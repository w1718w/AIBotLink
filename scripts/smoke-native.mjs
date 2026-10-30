import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../dist/config.js';
import { NativeAgent } from '../dist/agent.js';

// TEST_ONLY: opt-in real inference smoke test, never run by the gateway or npm test.
// Uses native local login, never copies credentials. Temporary workspace only.
// This checks native protocol delivery, not QQ E2E; replace/supplement it with
// the real chat acceptance flow once that flow can be exercised reproducibly.
const id = process.argv[2];
if (!['codex', 'dsh'].includes(id)) throw new Error('Usage: node scripts/smoke-native.mjs codex|dsh');
const config = await loadConfig();
const temp = await mkdtemp(path.join(tmpdir(), 'aibotlink-smoke-'));
const agent = new NativeAgent(id, { ...config.agents[id], cwd: temp });
let session;
const expected = `BOTLINK_${id.toUpperCase()}_OK`;
let settings = {};
try {
  await agent.start();
  if (id === 'codex') {
    const catalog = await agent.rpc.call('model/list', {});
    const model = catalog.data.find(m => m.isDefault) ?? catalog.data[0];
    // TEST_ONLY selection: don't change the user's global model if its stored
    // value is unavailable. Production follows native/configured selection.
    settings = { model: model.model || model.id };
    console.log(`Using native catalog default for this smoke test: ${settings.model}`);
    const r = await agent.rpc.call('thread/start', { cwd: temp, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'on-request', model: settings.model });
    session = r.thread.id; agent.sessions.set(session, r);
  } else session = await agent.create();
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Real turn timed out; inspect native status before retry')), 120_000);
    agent.on('event', e => {
      if (e.kind === 'request') agent.rpc.reject(e.request.id, 'No tools or approvals expected in smoke test');
      if (['done', 'failed', 'closed'].includes(e.kind)) {
        clearTimeout(timer);
        if (e.kind === 'done') resolve(e.text); else reject(new Error(e.text));
      }
    });
  });
  await agent.send(session, `只回复 ${expected}，不调用工具、不访问文件、不执行命令。`, settings);
  const text = await completed;
  if (!String(text).includes(expected)) throw new Error('Unexpected model response');
  console.log(`${id}: real native turn PASS (${expected})`);
} catch (error) {
  console.error(`${id}: ${error.message}`);
  if (error.cause) {
    const cause = error.cause;
    console.error(JSON.stringify({ nativeErrorDataKeys: typeof cause === 'object' ? Object.keys(cause) : [], detailType: typeof cause }));
    if (cause.details) console.error(String(cause.details).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/((?:access_token|refresh_token|api_key|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]').slice(0, 1200));
  }
  if (agent.rpc?.diagnostics) console.error(agent.rpc.diagnostics);
  process.exitCode = 1;
} finally {
  await agent.stop();
  if (path.dirname(path.resolve(temp)) !== path.resolve(tmpdir())) throw new Error('Unexpected temporary path');
  await rm(temp, { recursive: true, maxRetries: 5, retryDelay: 100 });
}
