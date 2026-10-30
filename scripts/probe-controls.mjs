// TEST_ONLY: explicit metadata/control acceptance probe. Does not start inference.
// Native login remains in its own HOME. Test threads are owned by this script;
// Codex threads are archived through the native API when materialized; empty
// threads may have no rollout. No private native files are edited.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';
import { NativeAgent } from '../dist/agent.js';

const config = await loadConfig();
const root = await mkdtemp(path.join(tmpdir(), 'aibotlink-controls-'));
try {
  for (const [id, cfg] of Object.entries(config.agents)) {
    const a = new NativeAgent(id, { ...cfg, cwd: root }); let session;
    try {
      session = await a.create();
      const provider = await a.provider(session);
      assert.ok((await a.providers(session)).includes(provider));
      const selected = await a.setProvider(session, provider); session = selected.session;
      assert.equal(selected.provider, provider);
      assert.ok((await a.catalog(session)).length > 0);
      if (cfg.type === 'codex') {
        const readOnly = await a.setPermission(session, 'read-only'); session = readOnly.session;
        assert.equal(readOnly.sandbox.type, 'readOnly');
        const writable = await a.setPermission(session, 'workspace-write'); session = writable.session;
        assert.equal(writable.sandbox.type, 'workspaceWrite');
        const host = a.rpc;
        const unsaved = await a.releaseIdle();
        assert.ok(unsaved.includes(session));
        assert.equal(a.rpc, undefined);
        assert.notEqual(host.child.exitCode, null);
        session = await a.create();
      }
      console.log(`${id}: provider query/select-current, model catalog${cfg.type === 'codex' ? ', native sandbox switch, idle host release/restart' : ''} PASS`);
    } finally {
      try {
        if (session && cfg.type === 'codex' && a.rpc?.alive) {
          try { await a.rpc.call('thread/archive', { threadId: session }); }
          catch (error) { if (!error.message.includes('no rollout found for thread id')) throw error; }
        }
      } finally { await a.stop(); }
    }
  }
} catch (error) {
  console.error(`control probe failed: ${error.message}`); process.exitCode = 1;
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
}
