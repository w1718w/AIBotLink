import { t as uiText } from './messages.js';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, importDsh, configPath, dataHome, type Config } from './config.js';
import { StateStore } from './state.js';
import { Gateway } from './gateway.js';
import { QqTransport } from './qq.js';
import { NativeAgent } from './agent.js';
import { acquireLock, unlockStoppedProcess } from './lock.js';
import { startSetup, findExistingSetup, publishSetupUrl } from './setup.js';

async function startRuntime(config: Config, consoleMode = false) {
  const release = await acquireLock();
  let store: StateStore;
  try { store = await new StateStore().load(); } catch (error) { await release(); throw error; }
  const gateway = new Gateway(config, store);
  const qq = consoleMode ? undefined : new QqTransport(config, gateway);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { try { await qq?.stop(); await gateway.close(); } finally { await release(); } })();
  try { await qq?.start(); } catch (error) { await close(); throw error; }
  return { gateway, qq, close };
}

async function main() {
  if (process.argv[2] === 'import-dsh') {
    await importDsh(path.resolve(process.argv[3] || path.join(homedir(), '.dsh')), path.resolve(process.argv[4] || process.cwd()));
    console.log(uiText("cli.configImported", { v0: configPath })); return;
  }
  if (process.argv[2] === 'unlock') { await unlockStoppedProcess(); console.log(uiText('runtime.unlocked')); return; }
  if (process.argv[2] === 'setup' || process.argv[2] === undefined) {
    const existing = await findExistingSetup();
    if (existing) { console.log(uiText('cli.setupStarted', { url: existing })); return; }
    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    let transition = Promise.resolve();
    const serialize = (action: () => Promise<void>) => {
      const next = transition.then(action); transition = next.catch(() => {}); return next;
    };
    const setup = await startSetup({
      start: () => serialize(async () => {
        if (!runtime) { runtime = await startRuntime(await loadConfig()); console.log(uiText('cli.started')); }
      }),
      stop: () => serialize(async () => {
        if (runtime?.gateway.tasks.size) throw new Error(uiText('setup.tasksActive'));
        await runtime?.close(); runtime = undefined;
      }),
      status: () => ({ running: Boolean(runtime) }),
    });
    console.log(uiText('cli.setupStarted', { url: setup.url }));
    const unpublish = await publishSetupUrl(setup.url);
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => { await transition; await runtime?.close(); await unpublish(); await setup.close(); })();
    process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
    process.once('SIGTERM', () => { void close().then(() => process.exit(0)); });
    if (process.argv[2] !== 'setup') {
      try { runtime = await startRuntime(await loadConfig()); console.log(uiText('cli.started')); }
      catch (error) { console.error(uiText('cli.startFailed', { v0: (error as Error).message })); }
    }
    return;
  }
  const config = await loadConfig();
  if (process.argv[2] === 'doctor') {
    console.log(uiText("cli.dataDirectory", { v0: dataHome }));
    for (const [id, cfg] of Object.entries(config.agents)) {
      const a = new NativeAgent(id, cfg);
      try { await a.start(); console.log(uiText("cli.handshakePassed", { v0: a.id })); }
      catch { console.log(uiText("cli.agentUnavailable", { v0: a.id })); }
      finally { await a.stop(); }
    }
    return;
  }
  const runtime = await startRuntime(config, process.argv[2] === 'console');
  const { gateway, close } = runtime;
  process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void close().then(() => process.exit(0)); });
  if (process.argv[2] === 'console') {
    console.log(uiText("cli.consoleBanner"));
    const input = readline.createInterface({ input: process.stdin }); let sequence = 0;
    for await (const text of input) await gateway.receive({ id: `local:${Date.now()}:${++sequence}`, scope: 'local-console', user: config.qq.allowedUsers[0], text, reply: async t => { console.log(t); } });
    await close(); return;
  }
  console.log(uiText("cli.started"));
}
main().catch(e => { console.error(uiText("cli.startFailed", { v0: e.message })); process.exitCode = 1; });

