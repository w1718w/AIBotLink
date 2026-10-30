import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeAgent } from '../agent.js';

// TEST_FIXTURE: local JSONL peer models saved history and native activity only.
// No real bot/account is connected, and no model inference occurs.
const peer = `
const readline = require('node:readline');
const calls = [];
const response = id => ({ thread: { id, status: { type: id === 'busy' ? 'active' : 'idle' } }, model: 'native-model', modelProvider: 'native-provider', sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request' });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  calls.push({ method: m.method, params: m.params });
  let result = {};
  if (m.method === 'thread/read') result = response(m.params.threadId);
  if (m.method === 'thread/fork') result = response('branch');
  if (m.method === 'thread/resume') result = response(m.params.threadId);
  if (m.method === 'thread/start') result = response('empty');
  if (m.method === 'turn/start') result = { turn: { id: 'pending-turn' } };
  if (m.method === 'test/calls') result = calls;
  console.log(JSON.stringify({ id: m.id, result }));
});
`;

test('native fork preserves source ownership and inherited branch settings, refusing active or unsaved sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aibotlink-fork-'));
  const a = new NativeAgent('codex', { type: 'codex', command: process.execPath, args: ['--input-type=commonjs', '-e', peer], cwd: root, model: 'configured-default' });
  const dsh = new NativeAgent('dsh', { type: 'dsh', command: 'not-started', args: [], cwd: root });
  try {
    assert.equal(await a.fork('saved-source'), 'branch');
    assert.equal(a.sessions.has('saved-source'), false);
    assert.equal(a.sessions.get('branch')!.model, 'native-model');
    let calls = await a.rpc!.call('test/calls') as { method: string; params: Record<string, unknown> }[];
    assert.deepEqual(calls.filter(c => c.method === 'thread/fork').map(c => c.params), [{ threadId: 'saved-source', excludeTurns: true }]);
    assert.ok(!calls.some(c => c.method === 'thread/resume'));
    await a.setPermission('branch', 'read-only');
    calls = await a.rpc!.call('test/calls');
    assert.ok(calls.some(c => c.method === 'thread/resume' && c.params.threadId === 'branch'));
    assert.ok(!calls.some(c => c.method === 'thread/start'));
    await assert.rejects(a.fork('busy'), /正在执行/);
    const empty = await a.create();
    await assert.rejects(a.fork(empty), /尚无已保存历史/);
    await a.send('active', 'test only', {});
    await assert.rejects(a.fork('active'), /正在执行/);
    calls = await a.rpc!.call('test/calls');
    assert.equal(calls.filter(c => c.method === 'thread/fork').length, 1);
    await assert.rejects(dsh.fork('saved'), /DSH ACP/);
    assert.equal(dsh.rpc, undefined);
  } finally {
    await a.stop(); await dsh.stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});
