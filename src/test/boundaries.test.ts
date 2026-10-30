import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { outsideRepository, repositoryRoot, type Config } from '../config.js';
import { StateStore } from '../state.js';
import { Gateway } from '../gateway.js';
import { splitText } from '../qq.js';
import { configureMessages, t } from '../messages.js';

test('configuration remains outside the repository independent of launch cwd', () => {
  assert.throws(() => outsideRepository(path.join(repositoryRoot, 'secrets')), /仓库外/);
  assert.doesNotThrow(() => outsideRepository(path.join(tmpdir(), 'aibotlink-test')));
});

test('local copy overrides remain literal and do not execute interpolation values', () => {
  try {
    configureMessages({ 'agent.current': '当前：{v0}' });
    assert.equal(t('agent.current', { v0: '$&<file,path=secret>' }), '当前：$&<file,path=secret>');
    assert.throws(() => configureMessages({ missing: 'invalid' }), /missing/);
  } finally { configureMessages(); }
});

test('a missing native backend does not prevent management commands, authorization or deduplication', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aibotlink-test-'));
  const state = new StateStore(path.join(temp, 'state.json'));
  // TEST_FIXTURE: intentionally missing executable and dummy QQ identifiers.
  // No QQ transport is started, and no model inference occurs in this test.
  const cfg: Config = { qq: { appid: 'test', secret: 'unused', allowedUsers: ['owner'], allowedGroups: [] },
    agents: { broken: { type: 'codex', command: path.join(temp, 'does-not-exist.exe'), args: [], cwd: temp } } };
  const gateway = new Gateway(cfg, state); const replies: string[] = [];
  const receive = (id: string, text: string, user = 'owner', group?: string) => gateway.receive({ id, text, user, group, scope: 'test-scope', reply: async t => { replies.push(t); } });
  try {
    await receive('forbidden', '/runtime start broken', 'stranger');
    await receive('forbidden-group', '/runtime start broken', 'owner', 'unlisted-group');
    assert.equal(replies.length, 0); assert.equal(gateway.agents.get('broken')!.rpc, undefined);
    await receive('start', '/runtime start broken');
    assert.match(replies.at(-1)!, /未完成/);
    await receive('status', '/status'); assert.match(replies.at(-1)!, /网关在线/);
    const count = replies.length; await receive('status', '/status'); assert.equal(replies.length, count);
    await receive('agents', '/agents'); assert.match(replies.at(-1)!, /broken/);
    await gateway.close();
    assert.ok(JSON.parse(await readFile(state.file, 'utf8')).delivered.includes('status'));
  } finally {
    await gateway.close();
    // Only remove this test's newly created directory under the verified temporary root.
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
    await rm(temp, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('restart marks dispatched work unknown without replaying it', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aibotlink-test-'));
  try {
    const state = new StateStore(path.join(temp, 'state.json'));
    state.value.operations.chat = { agent: 'codex', session: 'native-id', status: 'accepted', createdAt: new Date().toISOString() };
    state.value.operations.finished = { agent: 'codex', session: 'finished-id', status: 'completed', createdAt: new Date().toISOString() };
    state.value.responses.finished = 'saved final response';
    await state.save(); const restored = await new StateStore(state.file).load();
    assert.equal(restored.value.operations.chat.status, 'unknown');
    assert.equal(restored.value.operations.finished.status, 'completed');
    assert.equal(restored.value.responses.finished, 'saved final response');
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
    await rm(temp, { recursive: true });
  }
});

test('long text splitting preserves Unicode without interpreting message markup', () => {
  const text = '🦑<file,path=secret>'.repeat(200);
  const chunks = splitText(text, 31);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(s => Array.from(s).length <= 31));
});
