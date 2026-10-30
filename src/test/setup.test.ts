import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { findExistingSetup, publishSetupUrl, startSetup } from '../setup.js';
import { atomicJson, repositoryRoot } from '../config.js';

test('local setup authenticates, preserves private config and controls runtime without a receiver', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aibotlink-setup-')); const file = path.join(root, 'config.json');
  let running = false; let starts = 0; let stops = 0; let tests = 0;
  // TEST_FIXTURE: secret and bot values are dummy data. The tester is injected;
  // no QQ network, receiver, messages or native inference occur.
  const callbacks = { start: async () => { running = true; starts++; }, stop: async () => { running = false; stops++; }, status: () => ({ running }) };
  await assert.rejects(startSetup(callbacks, { configFile: path.join(repositoryRoot, 'setup-secret.json') }), /仓库外/);
  const setup = await startSetup(callbacks, { configFile: file, tester: async c => { tests++; assert.equal(c.qq.appid, '456'); } });
  const url = new URL(setup.url); const token = url.hash.slice(1); url.hash = '';
  const request = (route: string, body?: unknown, headers: Record<string, string> = {}) => fetch(new URL(route, url), {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const record = path.join(root, 'setup.json');
    const first = await publishSetupUrl(setup.url, { file: record });
    assert.equal(await findExistingSetup({ file: record }), setup.url);
    const second = await publishSetupUrl(setup.url, { file: record });
    await first(); assert.equal(await findExistingSetup({ file: record }), setup.url);
    await second(); assert.equal(await findExistingSetup({ file: record }), undefined);
    for (const candidate of [
      { version: 1, pid: process.pid, url: setup.url.replace(token, '0'.repeat(64)) },
      { version: 1, pid: 2147483647, url: setup.url },
      { version: 1, pid: process.pid, url: 'https://example.invalid/#' + token },
      { version: 1, pid: process.pid, url: setup.url.replace('/#', '/other#') },
    ]) {
      await atomicJson(record, candidate); assert.equal(await findExistingSetup({ file: record }), undefined);
    }
    await assert.rejects(publishSetupUrl('http://localhost:1234/#' + token, { file: record }));
    const html = await fetch(url); assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    const markup = await html.text(); assert.ok(!markup.includes(token));
    new Script(markup.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]);
    assert.equal((await request('/api/config', undefined, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await request('/api/config', undefined, { Origin: 'https://elsewhere.invalid' })).status, 403);
    assert.equal((await request('/api/config', undefined, { Origin: url.origin })).status, 200);
    assert.equal((await request('/api/config')).status, 200);
    const base = { appid: '123', secret: 'dummy-private-secret', allowedUsers: ['owner'], allowedGroups: [] };
    assert.equal((await request('/api/config', { ...base, allowedUsers: [] })).status, 400);
    assert.equal((await request('/api/config', base)).status, 200);
    const initial = JSON.parse(await readFile(file, 'utf8')); assert.ok(initial.agents.codex); assert.ok(initial.agents.dsh.dshBridge);
    const stored = { ...initial, agents: { custom: { type: 'codex', command: 'example', args: [], cwd: root } }, extra: { retained: true }, qq: { ...initial.qq, secret: undefined, secretSource: { file: path.join(root, 'credentials.yml'), ref: 'dummy' } } };
    await atomicJson(file, stored);
    assert.equal((await request('/api/config', { ...base, secret: '', allowedGroups: ['group'] })).status, 200);
    let saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.agents, stored.agents); assert.deepEqual(saved.extra, stored.extra); assert.deepEqual(saved.qq.secretSource, stored.qq.secretSource);
    const safe = await (await request('/api/config')).text(); assert.ok(!safe.includes('secretSource')); assert.ok(!safe.includes('credentials.yml')); assert.ok(!safe.includes('dummy-private-secret'));
    assert.equal(JSON.parse(safe).hasSecret, true);
    assert.equal((await request('/api/config', { ...base, appid: '456', secret: '' })).status, 400);
    assert.equal((await request('/api/config', { ...base, appid: '456', secret: 'dummy-new-secret' })).status, 200);
    saved = JSON.parse(await readFile(file, 'utf8')); assert.equal(saved.qq.secretSource, undefined);
    const testReply = await request('/api/test', {}); assert.equal(testReply.status, 200); assert.equal(tests, 1);
    assert.ok(!(await testReply.text()).includes('dummy-new-secret'));
    assert.equal((await request('/api/start', {})).status, 200); assert.equal(starts, 1);
    assert.equal((await request('/api/config', base)).status, 409);
    assert.equal((await request('/api/stop', {})).status, 200); assert.equal(stops, 1);
    assert.equal((await request('/api/config', { ...base, secret: 'x'.repeat(70_000) })).status, 413);
  } finally {
    await setup.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('QR setup APIs expose only safe state and exclude concurrent receiver and config actions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aibotlink-qr-ui-')); const file = path.join(root, 'config.json');
  let running = false; let cancelled = 0; let qrState: any = { status: 'idle', busy: false };
  // TEST_FIXTURE: injected QR driver never contacts QQ. Extra private properties
  // intentionally verify that HTTP state serialization is an allowlist.
  const setup = await startSetup({ start: async () => { running = true; }, stop: async () => { running = false; }, status: () => ({ running }) }, {
    configFile: file,
    qrFactory: services => ({
      status: () => qrState,
      start: async () => { qrState = { status: 'select', busy: true, qrDataUrl: 'data:image/png;base64,AQ==', secret: 'must-not-leak', candidates: [{ appId: '123', secret: 'must-not-leak' }] }; },
      cancel: async () => { cancelled++; qrState = { status: 'cancelled', busy: false }; },
      select: async appId => { const config = (await services.load()) ?? services.defaults(); config.qq = { appid: appId, secret: 'must-not-leak', allowedUsers: ['auto-owner'], allowedGroups: [] }; await services.save(config); qrState = { status: 'ready', busy: false }; },
    }),
  });
  const url = new URL(setup.url); const token = url.hash.slice(1); url.hash = '';
  const call = (route: string, body?: unknown, authorized = true) => fetch(new URL('/api/' + route, url), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: authorized ? `Bearer ${token}` : '', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await call('qr/status', undefined, false)).status, 401);
    const html = await fetch(url); assert.match(html.headers.get('content-security-policy')!, /img-src 'self' data:/);
    const markup = await html.text(); assert.match(markup, /id="qrImage"/); new Script(markup.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]);
    assert.equal((await call('qr/start', {})).status, 200);
    const safe = await (await call('qr/status')).text(); assert.ok(!safe.includes('must-not-leak')); assert.match(safe, /data:image\/png/);
    assert.deepEqual(JSON.parse(safe).candidates, [{ appId: '123' }]);
    assert.equal((await call('start', {})).status, 409); assert.equal(running, false);
    assert.equal((await call('config', { appid: '123', secret: 'test', allowedUsers: ['manual'], allowedGroups: [] })).status, 409);
    assert.equal((await call('qr/start', {})).status, 409);
    assert.equal((await call('qr/cancel', {})).status, 200); assert.equal(cancelled, 1);
    assert.equal((await call('start', {})).status, 200); assert.equal((await call('qr/start', {})).status, 409);
    await call('stop', {}); await call('qr/start', {});
    assert.equal((await call('qr/select', { appId: '123' })).status, 200);
    const config = await (await call('config')).text(); assert.ok(!config.includes('must-not-leak')); assert.deepEqual(JSON.parse(config).allowedUsers, ['auto-owner']);
    qrState = { status: 'error', busy: true }; assert.equal((await call('start', {})).status, 409);
  } finally {
    await setup.close(); assert.equal(cancelled, 2);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});
