import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Gateway, type Action } from '../gateway.js';
import { NativeAgent } from '../agent.js';
import { StateStore } from '../state.js';
import type { Config } from '../config.js';

// TEST_FIXTURE: a local stdio protocol peer, with no QQ or model connection.
// It models a saved idle thread, an unsaved empty thread and native compaction.
const peer = `
const readline = require('node:readline');
const loaded = new Set();
let turnStarts = 0;
const thread = id => ({ thread: { id, status: { type: id === 'compacting' ? 'active' : 'idle' } } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  let result = {};
  if (m.method === 'thread/resume' && ['desktop', 'invalid', 'different-code'].includes(m.params.threadId)) {
    const message = m.params.threadId === 'invalid' ? 'invalid thread' : 'thread desktop already has an active writer';
    console.log(JSON.stringify({ id: m.id, error: { code: m.params.threadId === 'different-code' ? -32603 : -32600, message } })); return;
  }
  if (m.method === 'turn/start') turnStarts++;
  if (m.method === 'test/counts') result = { turnStarts };
  if (m.method === 'thread/resume') { loaded.add(m.params.threadId); result = thread(m.params.threadId); }
  if (m.method === 'thread/start') { loaded.add('empty'); result = thread('empty'); }
  if (m.method === 'thread/loaded/list') result = { data: [...loaded] };
  if (m.method === 'thread/read') {
    if (m.params.threadId === 'empty') {
      console.log(JSON.stringify({ id: m.id, error: { code: -1, message: 'no rollout found for thread id empty' } })); return;
    }
    result = thread(m.params.threadId);
  }
  console.log(JSON.stringify({ id: m.id, result }));
});
`;

test('writer conflicts never submit a turn, and the exact handoff alias never reaches the model', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aibotlink-conflict-'));
  // TEST_FIXTURE: same local fake stdio peer; no real account or bot is used.
  const cfg: Config = { qq: { appid: 'test', secret: 'unused', allowedUsers: ['owner'], allowedGroups: [] },
    agents: { codex: { type: 'codex', command: process.execPath, args: ['--input-type=commonjs', '-e', peer], cwd: temp } } };
  const state = new StateStore(path.join(temp, 'state.json')); const gateway = new Gateway(cfg, state);
  const a = gateway.agents.get('codex')!; const replies: { text: string; actions?: Action[] }[] = []; let id = 0;
  const counts = () => a.rpc!.call('test/counts');
  const receive = (text: string) => gateway.receive({ id: String(++id), text, scope: 'chat', user: 'owner',
    reply: async (text, actions) => { replies.push({ text, actions }); } });
  try {
    const binding = state.scope('chat', 'codex'); binding.sessions.codex = 'desktop';
    await receive('只回复测试内容');
    assert.match(replies.at(-1)!.text, /本次 QQ 消息未提交/);
    assert.equal(replies.at(-1)!.actions?.[0].command, '/new');
    assert.equal(state.value.operations.chat, undefined); assert.equal(gateway.tasks.size, 0);
    assert.equal(a.sessions.has('desktop'), false);
    assert.equal((await counts()).turnStarts, 0);
    await receive('交接给谁'); assert.match(replies.at(-1)!.text, /本次 QQ 消息未提交/);
    assert.ok(a.rpc?.alive); // Longer natural text does not trigger the alias.
    for (const nativeId of ['invalid', 'different-code']) {
      binding.sessions.codex = nativeId;
      await receive('ordinary task');
      assert.match(replies.at(-1)!.text, /操作未完成/);
      assert.equal(replies.at(-1)!.actions, undefined);
    }
    binding.sessions.codex = 'desktop';
    await receive('交接'); assert.match(replies.at(-1)!.text, /已释放 codex/);
    assert.equal(a.rpc, undefined); assert.equal(binding.sessions.codex, 'desktop');
    await receive('/new'); assert.equal(binding.sessions.codex, 'empty');
    assert.equal((await counts()).turnStarts, 0);
  } finally {
    await gateway.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
    await rm(temp, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('handoff stops only its native host, preserves saved bindings and checks native activity', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aibotlink-release-'));
  const cfg: Config = { qq: { appid: 'test', secret: 'unused', allowedUsers: ['owner'], allowedGroups: [] },
    agents: { codex: { type: 'codex', command: process.execPath, args: ['--input-type=commonjs', '-e', peer], cwd: temp } } };
  const state = new StateStore(path.join(temp, 'state.json'));
  const gateway = new Gateway(cfg, state); const a = gateway.agents.get('codex')!;
  const alive = () => a.rpc?.alive;
  const unrelated = new NativeAgent('unrelated', cfg.agents.codex);
  const replies: string[] = []; let id = 0;
  const receive = (text: string, scope = 'chat', reply = async (s: string) => { replies.push(s); }) => gateway.receive({ id: String(++id), text, scope, user: 'owner', reply });
  try {
    const binding = state.scope('chat', 'codex'); binding.sessions.codex = 'saved';
    binding.settings.codex = { reasoning: 'low' };
    await a.attach('saved'); await unrelated.start();
    const host = a.rpc!;
    state.value.operations.other = { agent: 'codex', session: 'saved', status: 'unknown', createdAt: '' };
    await receive('/release'); assert.match(replies.at(-1)!, /未释放/); assert.ok(host.alive);
    delete state.value.operations.other;
    await a.attach('compacting');
    await receive('/release'); assert.match(replies.at(-1)!, /未释放/); assert.ok(host.alive);
    // End the simulated native activity by starting a fresh protocol peer.
    await a.stop(); await a.attach('saved');
    const releasedHost = a.rpc!;
    const empty = state.scope('empty-chat', 'codex'); empty.sessions.codex = await a.create();
    await receive('/release');
    assert.match(replies.at(-1)!, /已释放 codex/);
    assert.equal(a.rpc, undefined); assert.ok('child' in releasedHost); assert.notEqual(releasedHost.child.exitCode, null);
    assert.equal(a.error, undefined);
    assert.equal(binding.sessions.codex, 'saved'); assert.equal(binding.settings.codex.reasoning, 'low');
    assert.equal(empty.sessions.codex, undefined); assert.ok(unrelated.rpc!.alive);
    await receive('/status'); assert.match(replies.at(-1)!, /网关未加载/); assert.equal(a.rpc, undefined);
    await receive('/session saved'); assert.ok(alive());

    // Keep another scope's command in flight: release must not race a resume.
    let entered!: () => void; let finish!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const waiting = new Promise<void>(r => { finish = r; });
    const concurrent = receive('/agent', 'other-chat', async () => { entered(); await waiting; });
    await ready;
    try { await receive('/release'); assert.match(replies.at(-1)!, /并行操作/); assert.ok(alive()); }
    finally { finish(); await concurrent; }

    // Once release has started, later requests must not reload its host.
    let releasing!: () => void; let allowRelease!: () => void;
    const started = new Promise<void>(r => { releasing = r; });
    const allowed = new Promise<void>(r => { allowRelease = r; });
    const releaseIdle = a.releaseIdle.bind(a);
    a.releaseIdle = async () => { releasing(); await allowed; return releaseIdle(); };
    const handoff = receive('/release'); await started;
    try { await receive('/session saved', 'later-chat'); assert.match(replies.at(-1)!, /正在交接/); }
    finally { allowRelease(); await handoff; }
    assert.equal(a.rpc, undefined);
  } finally {
    await gateway.close(); await unrelated.stop();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
    await rm(temp, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});
