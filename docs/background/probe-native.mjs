import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

// Metadata-only probes: isolated native homes, no prompt/turn execution.
const root = path.resolve('.research');
await mkdir(root, { recursive: true });
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/TOKEN|SECRET|API_KEY|PASSWORD/i.test(key)) delete env[key];
}

function connect(command, args, extraEnv, jsonrpc = false) {
  const child = spawn(command, args, {
    cwd: root, env: { ...env, ...extraEnv }, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0;
  const pending = new Map();
  const diagnostics = [];
  let terminalError;
  child.stderr.on('data', data => {
    if (diagnostics.length < 8) diagnostics.push(data.toString().slice(0, 500));
  });
  const fail = error => {
    terminalError = error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`owned process exited: ${code}`)));
  child.stdin.on('error', fail);
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch {
      if (diagnostics.length < 8) diagnostics.push(line.slice(0, 500));
      return;
    }
    if (message.method) {
      // These probes never start inference, so any server request is unexpected.
      if (message.id !== undefined) child.stdin.write(JSON.stringify({
        id: message.id, error: { code: -32601, message: 'metadata-only probe' },
      }) + '\n');
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  });
  return {
    diagnostics,
    notify(method, params) { child.stdin.write(JSON.stringify({ ...(jsonrpc ? { jsonrpc: '2.0' } : {}), method, params }) + '\n'); },
    call(method, params = {}) {
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id); reject(new Error(`${method}: timeout after 20s`));
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ ...(jsonrpc ? { jsonrpc: '2.0' } : {}), id, method, params }) + '\n');
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

const results = { checkedAt: new Date().toISOString(), inferenceStarted: false, codex: {}, dsh: {} };
async function check(target, name, action) {
  try { target[name] = { ok: true, result: await action() }; }
  catch (error) { target[name] = { ok: false, error: error.message }; }
  console.log(JSON.stringify({ check: name, ...target[name] }));
}

const codexHome = path.join(root, 'codex-home');
await mkdir(codexHome, { recursive: true });
const codex = connect(process.env.BOTLINK_CODEX_BIN || 'codex', ['app-server'], { CODEX_HOME: codexHome });
try {
  await check(results.codex, 'initialize', () => codex.call('initialize', {
    clientInfo: { name: 'botlink-research', title: 'BotLink metadata probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  }));
  codex.notify('initialized', {});
  await check(results.codex, 'models', async () => {
    const r = await codex.call('model/list', { limit: 2 });
    return { count: r.data.length, sample: r.data.map(m => ({ id: m.id, effort: m.supportedReasoningEfforts })) };
  });
  await check(results.codex, 'threads', async () => {
    const r = await codex.call('thread/list', { limit: 2 });
    return { count: r.data.length };
  });
  await check(results.codex, 'ephemeralThread', async () => {
    const r = await codex.call('thread/start', { cwd: root, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'on-request' });
    return { id: r.thread.id, ephemeral: r.thread.ephemeral, sandbox: r.sandbox, approvalPolicy: r.approvalPolicy };
  });
} finally { await codex.close(); }

const dshHome = path.join(root, 'dsh-home');
await mkdir(dshHome, { recursive: true });
// Set this to the installation discovered by Get-Command dsh, not the caller's virtualized LOCALAPPDATA.
const dshInstall = process.env.BOTLINK_DSH_INSTALL;
if (!dshInstall) throw new Error('Set BOTLINK_DSH_INSTALL to the installed DeepSeek Harness directory');
const dshExe = path.join(dshInstall, 'DeepSeek Harness.exe');
const dshCli = path.join(dshInstall, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
const dsh = connect(dshExe, ['--expose-internals', dshCli, '--profile', 'acp'], {
  ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome,
}, true);
try {
  await check(results.dsh, 'initialize', () => dsh.call('initialize', {
    protocolVersion: 1, clientCapabilities: {},
    clientInfo: { name: 'botlink-research', version: '0.1.0' },
  }));
  if (results.dsh.initialize.ok) {
    await check(results.dsh, 'newSession', () => dsh.call('session/new', { cwd: root, mcpServers: [] }));
    const sessionId = results.dsh.newSession.result?.sessionId;
    if (sessionId) {
      await check(results.dsh, 'setReasoning', () => dsh.call('session/set_config_option', {
        sessionId, configId: 'reasoning_effort', value: 'low',
      }));
      await check(results.dsh, 'rejectActiveResume', async () => {
        try { await dsh.call('session/resume', { sessionId, cwd: root, mcpServers: [] }); }
        catch (error) {
          const r = JSON.parse(error.message);
          if (r.code === -32602 && r.message.includes('already active')) return { expectedRejection: r };
          throw error;
        }
        throw new Error('Expected rejection for an already-active session');
      });
      await check(results.dsh, 'closeSession', () => dsh.call('session/close', { sessionId }));
      if (results.dsh.closeSession.ok) {
        await check(results.dsh, 'resumeSession', () => dsh.call('session/resume', {
          sessionId, cwd: root, mcpServers: [],
        }));
      }
    }
    await check(results.dsh, 'listSessions', () => dsh.call('session/list', { cwd: root }));
  } else {
    results.dsh.diagnostics = dsh.diagnostics;
    console.log(JSON.stringify({ dshDiagnostics: dsh.diagnostics }));
  }
} finally { await dsh.close(); }
await writeFile(path.join(root, 'native-probe-results.json'), JSON.stringify(results, null, 2));
