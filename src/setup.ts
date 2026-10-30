import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { atomicJson, configPath, dataHome, outsideRepository, qqSecret, repositoryRoot, type Config } from './config.js';
import { t, type MessageKey } from './messages.js';
import { QqQrSetup } from './qq-qr.js';

interface Callbacks { start(): Promise<void>; stop(): Promise<void>; status(): { running: boolean } }
interface QrState { status: string; busy?: boolean; qrDataUrl?: string; pairingCode?: string; candidates?: { appId: string }[]; messageKey?: MessageKey }
interface QrService { start(): Promise<unknown>; status(): QrState; cancel(): Promise<void>; select(appId: string): Promise<void> }
interface QrServices { load(): Promise<Config | undefined>; save(config: Config): Promise<void>; defaults(): Config; isRunning(): boolean }
interface Options { configFile?: string; tester?: (config: Config) => Promise<void>; qrFactory?: (services: QrServices) => QrService }
interface SetupRecordOptions { file?: string }
class SetupError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
const reject = (code: string, status?: number): never => { throw new SetupError(code, status); };
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function managementUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/#([a-f0-9]{64})$/.test(value)) return;
  try { return new URL(value); } catch { return; }
}

/** Find an authenticated live setup server; stale records never authorize a kill. */
export async function findExistingSetup(options: SetupRecordOptions = {}): Promise<string | undefined> {
  const file = path.resolve(options.file ?? path.join(dataHome, 'setup.json')); outsideRepository(file);
  try {
    const record = JSON.parse(await readFile(file, 'utf8')); const url = managementUrl(record.url);
    if (record.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 0 || !url) return;
    process.kill(record.pid, 0); // Existence check only; never terminate a recorded PID.
    const result = await fetch(new URL('/api/config', url), { headers: { Authorization: `Bearer ${url.hash.slice(1)}` }, signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!result.ok || result.status !== 200) { await result.body?.cancel(); return; }
    const status = await result.json() as { running?: unknown };
    if (typeof status.running === 'boolean') return record.url;
  } catch { return; }
}

/** The record contains a management secret, so it stays outside Git with config. */
export async function publishSetupUrl(url: string, options: SetupRecordOptions = {}): Promise<() => Promise<void>> {
  if (!managementUrl(url)) throw new SetupError('invalid');
  const file = path.resolve(options.file ?? path.join(dataHome, 'setup.json')); outsideRepository(file);
  const nonce = randomBytes(24).toString('hex');
  await atomicJson(file, { version: 1, pid: process.pid, url, nonce });
  return async () => {
    try { if (JSON.parse(await readFile(file, 'utf8')).nonce === nonce) await unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  };
}

async function testQq(config: Config) {
  const response = await fetch('https://bots.qq.com/app/getAppAccessToken', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: config.qq.appid, clientSecret: await qqSecret(config) }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) reject('testFailed');
  const result = await response.json() as { access_token?: string };
  if (typeof result.access_token !== 'string' || !result.access_token) reject('testFailed');
  const me = await fetch('https://api.bot.qq.com/users/@me', { headers: { Authorization: `QQBot ${result.access_token}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!me.ok) reject('testFailed');
}

export async function startSetup(callbacks: Callbacks, options: Options = {}): Promise<{ url: string; close(): Promise<void> }> {
  const file = path.resolve(options.configFile ?? configPath); outsideRepository(file);
  const token = randomBytes(32).toString('hex'); const nonce = randomBytes(18).toString('base64');
  let origin = ''; let queue = Promise.resolve();
  const load = async (): Promise<Config | undefined> => {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  };
  const defaults = (): Config => ({ qq: { appid: '', allowedUsers: [], allowedGroups: [] }, agents: {
    codex: { type: 'codex', command: process.platform === 'win32' ? path.join(homedir(), 'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe') : 'codex', args: ['app-server'], cwd: repositoryRoot, home: path.join(homedir(), '.codex') },
    dsh: { type: 'dsh', dshBridge: path.join(path.dirname(file), 'dsh-bridge.json'), cwd: repositoryRoot },
  } });
  const qr: QrService = (options.qrFactory ?? (services => new QqQrSetup(services)))({ load, save: config => atomicJson(file, config), defaults, isRunning: () => callbacks.status().running });
  const qrBusy = () => qr.status().busy ?? !['idle', 'ready', 'cancelled', 'expired', 'error'].includes(qr.status().status);
  const qrPublic = () => {
    const state = qr.status();
    return { status: state.status, busy: qrBusy(),
      ...(state.qrDataUrl && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(state.qrDataUrl) && state.qrDataUrl.length < 500_000 ? { qrDataUrl: state.qrDataUrl } : {}),
      ...(typeof state.pairingCode === 'string' && state.pairingCode.length <= 128 ? { pairingCode: state.pairingCode } : {}),
      ...(state.candidates ? { candidates: state.candidates.filter(c => /^\d{1,32}$/.test(c.appId)).slice(0, 100).map(c => ({ appId: c.appId })) } : {}),
      ...(state.messageKey ? { message: t(state.messageKey) } : {}),
    };
  };
  const safe = (config?: Config) => ({ appid: config?.qq.appid ?? '', allowedUsers: config?.qq.allowedUsers ?? [], allowedGroups: config?.qq.allowedGroups ?? [], hasSecret: Boolean(config?.qq.secret || config?.qq.secretSource) });
  const json = (res: http.ServerResponse, status: number, value: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); } };
  const server = http.createServer((req, res) => { void (async () => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    if (`http://${req.headers.host}` !== origin || (req.headers.origin && req.headers.origin !== origin)) { json(res, 403, { code: 'forbidden' }); return; }
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page(nonce)); return; }
    const supplied = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { json(res, 401, { code: 'unauthorized' }); return; }
    if (req.method === 'GET' && req.url === '/api/config') { json(res, 200, { ...safe(await load()), ...callbacks.status() }); return; }
    if (req.method === 'GET' && req.url === '/api/qr/status') { json(res, 200, qrPublic()); return; }
    if (req.method !== 'POST' || !['/api/config', '/api/test', '/api/start', '/api/stop', '/api/qr/start', '/api/qr/cancel', '/api/qr/select'].includes(req.url!)) { json(res, 404, { code: 'notFound' }); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) reject('invalid');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) reject('tooLarge', 413); chunks.push(chunk); }
    let body: any; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject('invalid'); }
    const action = queue.then(async () => {
      if (req.url === '/api/qr/cancel') { await qr.cancel(); return qrPublic(); }
      if (req.url === '/api/qr/select') {
        if (callbacks.status().running) reject('stopFirst', 409);
        if (!body || typeof body.appId !== 'string') reject('invalid');
        await qr.select(body.appId); return qrPublic();
      }
      if (qrBusy()) reject('qrBusy', 409);
      if (req.url === '/api/qr/start') {
        if (callbacks.status().running) reject('stopFirst', 409);
        await qr.start(); return qrPublic();
      }
      if (req.url === '/api/config') {
        if (callbacks.status().running) reject('stopFirst', 409);
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.appid !== 'string' || !/^\d{1,32}$/.test(body.appid.trim()) || typeof body.secret !== 'string' || body.secret.length > 4096) reject('invalid');
        const ids = (value: unknown) => {
          if (!Array.isArray(value) || value.length > 200 || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 256)) reject('invalid');
          return [...new Set((value as string[]).map(x => x.trim()))];
        };
        const users = ids(body.allowedUsers); const groups = ids(body.allowedGroups);
        if (!users.length) reject('allowlistEmpty');
        const current = await load(); const config = current ?? defaults(); const secret = body.secret.trim();
        if (!secret && (!current || current.qq.appid !== body.appid.trim() || !(current.qq.secret || current.qq.secretSource))) reject('secretRequired');
        config.qq = { ...config.qq, appid: body.appid.trim(), allowedUsers: users, allowedGroups: groups };
        if (secret) { config.qq.secret = secret; delete config.qq.secretSource; }
        await atomicJson(file, config); return { code: 'saved', ...safe(config), ...callbacks.status() };
      }
      if (req.url === '/api/test') { const config = await load(); if (!config) reject('configRequired'); try { await (options.tester ?? testQq)(config!); } catch { reject('testFailed'); } return { code: 'testPassed' }; }
      if (req.url === '/api/start') await callbacks.start(); else await callbacks.stop();
      return { code: 'updated', ...callbacks.status() };
    });
    queue = action.then(() => {}, () => {}); json(res, 200, await action);
  })().catch(error => { json(res, error instanceof SetupError ? error.status : 500, { code: error instanceof SetupError ? error.code : 'failed' }); }); });
  server.requestTimeout = 20_000; server.headersTimeout = 15_000;
  await new Promise<void>((resolve, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  return { url: `${origin}/#${token}`, async close() { await queue; await qr.cancel(); server.closeAllConnections(); await new Promise<void>((resolve, rejectClose) => server.close(error => error ? rejectClose(error) : resolve())); } };
}

function page(nonce: string) {
  const text = { saved: t('setup.saved'), testPassed: t('setup.testPassed'), updated: t('setup.updated'), failed: t('setup.failed'), invalid: t('setup.invalid'), allowlistEmpty: t('setup.allowlistEmpty'), secretRequired: t('setup.secretRequired'), configRequired: t('setup.configRequired'), testFailed: t('setup.testFailed'), stopFirst: t('setup.stopFirst'), unauthorized: t('setup.unauthorized'), forbidden: t('setup.unauthorized'), running: t('setup.running'), stopped: t('setup.stopped'), hasSecret: t('setup.hasSecret'), noSecret: t('setup.noSecret'), working: t('setup.working'), qrBusy: t('setup.qrBusy'), qrReady: t('setup.qrReady'), pairing: t('setup.pairing'), qrStatuses: Object.fromEntries(['idle', 'connecting', 'qr', 'select', 'pairing', 'saving', 'ready', 'cancelled', 'expired', 'error'].map(state => [state, t(`setup.qrStatus.${state}` as MessageKey)])) };
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(t('setup.title'))}</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:640px;margin:40px auto;padding:0 20px;background:#f5f6f8;color:#172131}label{display:block;margin:18px 0}input,textarea{display:block;box-sizing:border-box;width:100%;padding:10px;margin-top:6px;border:1px solid #aab3c2;border-radius:6px}button{padding:10px 16px;margin:6px 8px 6px 0;cursor:pointer}small{display:block;color:#536075}output{display:block;white-space:pre-wrap;margin:20px 0}</style>
<h1>${escape(t('setup.title'))}</h1><p>${escape(t('setup.intro'))}</p>
<section><h2>${escape(t('setup.qrTitle'))}</h2><p>${escape(t('setup.qrIntro'))}</p>
<button data-action="qr/start">${escape(t('setup.qrStart'))}</button><button data-action="qr/cancel" disabled>${escape(t('setup.qrCancel'))}</button>
<div><img id="qrImage" hidden width="256" height="256" alt="${escape(t('setup.qrAlt'))}"></div><output id="qrStatus" role="status"></output>
<div id="qrChoose" hidden><label>${escape(t('setup.qrChoose'))}<select id="qrCandidates"></select></label><button data-action="qr/select" disabled>${escape(t('setup.qrConfirm'))}</button></div></section>
<details><summary>${escape(t('setup.manual'))}</summary>
<label>${escape(t('setup.appid'))}<input id="appid" autocomplete="off"></label>
<label>${escape(t('setup.secret'))}<input id="secret" type="password" autocomplete="new-password"><small id="secretHint"></small></label>
<label>${escape(t('setup.users'))}<textarea id="users" rows="3"></textarea><small>${escape(t('setup.usersHint'))}</small></label>
<label>${escape(t('setup.groups'))}<textarea id="groups" rows="2"></textarea><small>${escape(t('setup.groupsHint'))}</small></label>
<button data-action="config">${escape(t('setup.save'))}</button></details>
<button data-action="test">${escape(t('setup.test'))}</button><button data-action="start">${escape(t('setup.start'))}</button><button data-action="stop">${escape(t('setup.stop'))}</button><output id="result" role="status"></output>
<script nonce="${nonce}">const messages=${JSON.stringify(text).replaceAll('<', '\\u003c')};const token=location.hash.slice(1);const el=id=>document.getElementById(id);const buttons=[...document.querySelectorAll('button')];
async function api(route,body){const response=await fetch('/api/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(messages[value.code]||messages.failed);return value;}
function status(value){el('secretHint').textContent=value.hasSecret?messages.hasSecret:messages.noSecret;return value.running?messages.running:messages.stopped;}
async function load(){const value=await api('config');el('appid').value=value.appid;el('users').value=value.allowedUsers.join('\\n');el('groups').value=value.allowedGroups.join('\\n');el('result').textContent=status(value);}
let qrState='idle',qrActive=false,requesting=false,lastQrState='',candidateKey='';
function controls(){buttons.forEach(button=>{const a=button.dataset.action;button.disabled=requesting||(a==='qr/cancel'?!qrActive:a==='qr/select'?qrState!=='select':qrActive);});['appid','secret','users','groups'].forEach(id=>el(id).disabled=requesting||qrActive);}
async function showQr(value){qrState=value.status;qrActive=value.busy;el('qrImage').hidden=!value.qrDataUrl;if(value.qrDataUrl)el('qrImage').src=value.qrDataUrl;else el('qrImage').removeAttribute('src');el('qrChoose').hidden=qrState!=='select';const candidates=value.candidates||[];const key=JSON.stringify(candidates);if(candidateKey!==key){el('qrCandidates').replaceChildren();candidates.forEach(c=>{const option=document.createElement('option');option.value=c.appId;option.textContent=c.appId;el('qrCandidates').append(option);});candidateKey=key;}el('qrStatus').textContent=value.message||messages.qrStatuses[qrState]||messages.failed;if(value.pairingCode)el('qrStatus').textContent+='\\n'+messages.pairing.replace('{code}',value.pairingCode);if(qrState==='ready'&&lastQrState!=='ready'){await load();el('qrStatus').textContent=messages.qrReady;}lastQrState=qrState;controls();}
buttons.forEach(button=>button.onclick=async()=>{requesting=true;controls();el('result').textContent=messages.working;try{const action=button.dataset.action;const list=id=>el(id).value.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean);const body=action==='config'?{appid:el('appid').value,secret:el('secret').value,allowedUsers:list('users'),allowedGroups:list('groups')}:action==='qr/select'?{appId:el('qrCandidates').value}:{};const value=await api(action,body);if(action.startsWith('qr/')){await showQr(value);el('result').textContent='';}else{if(action==='config'){el('secret').value='';status(value);}el('result').textContent=(messages[value.code]||messages.updated)+(typeof value.running==='boolean'?'\\n'+status(value):'');}}catch(error){el('result').textContent=error.message;}finally{requesting=false;controls();}});
let polling=false;async function poll(){if(polling)return;polling=true;try{await showQr(await api('qr/status'));}catch(error){el('qrStatus').textContent=error.message;}finally{polling=false;}}load().then(poll).catch(error=>el('result').textContent=error.message);setInterval(poll,1000);</script></html>`;
}
