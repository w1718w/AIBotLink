// TEST_ONLY: opt-in probe against the installed Desktop companion. By default
// it performs metadata only. --prompt creates one owned native test conversation
// and asks for a fixed reply without tools, then forks that saved conversation.
// These ordinary test sessions remain in native history; no private files are
// deleted or edited. This script never starts a QQ receiver or changes defaults.
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig, atomicJson, dataHome } from '../dist/config.js';
import { NativeAgent } from '../dist/agent.js';

const config = await loadConfig();
const cfg = config.agents.dsh;
assert.ok(cfg?.dshBridge, 'Install the DSH companion before running this probe');
const agent = new NativeAgent('dsh-probe', cfg);
try {
  const session = await agent.create();
  const native = await agent.settings(session);
  await atomicJson(path.join(dataHome, 'test-dsh-probe.json'), { purpose: 'TEST_ONLY: owned native probe session, retained for explicit diagnostic/cleanup through native APIs', session, cwd: cfg.cwd });
  console.log(`DSH test session created; native provider=${native.modelProvider}, model=${native.model}, reasoning=${native.reasoningEffort ?? 'default'}`);
  assert.ok((await agent.catalog(session)).length);
  assert.ok((await agent.permissionOptions(session)).length);
  assert.equal(typeof await agent.history(session), 'string');
  console.log('DSH companion: native new/list/catalog/permissions/history PASS');
  assert.ok((await agent.list()).items.some(s => s.id === session));
  if (process.argv.includes('--prompt')) {
    let timer; let heartbeat;
    const completed = new Promise((resolve, reject) => {
      const listen = event => {
        if (event.session !== session || !['done', 'failed'].includes(event.kind)) return;
        agent.off('event', listen); clearTimeout(timer);
        if (event.kind === 'failed') reject(new Error(event.text)); else resolve(event);
      };
      agent.on('event', listen);
      // TEST_ONLY watchdog for this explicit probe; production prompts have no
      // fixed inference deadline. Only this probe's owned run may be interrupted.
      timer = setTimeout(() => { agent.off('event', listen); reject(new Error('probe deadline reached')); }, 180_000);
    });
    heartbeat = setInterval(() => { console.log(`DSH probe waiting; receivedText=${Boolean(agent.runs.get(session)?.delta)}`); }, 30_000);
    try {
      await agent.send(session, '只回复 AIBOTLINK_DSH_OK，不调用任何工具。', {});
      const result = await completed;
      assert.equal(result.text.trim(), 'AIBOTLINK_DSH_OK');
      const branch = await agent.fork(session);
      assert.notEqual(branch, session);
      assert.ok((await agent.history(branch)).includes('AIBOTLINK_DSH_OK'));
      console.log('DSH companion: real native prompt + persisted history + fork PASS');
    } finally { clearTimeout(timer); clearInterval(heartbeat); if (agent.runs.has(session)) await agent.interrupt(session); }
  }
} finally { await agent.stop(); }
