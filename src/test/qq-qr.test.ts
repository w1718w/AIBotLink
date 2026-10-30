import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { QqQrSetup, type QqQrSetupOptions } from '../qq-qr.js';
import type { Config } from '../config.js';
import type { QrConnectCallbacks } from '@tencent-connect/qqbot-connector';

// TEST_FIXTURE: fake connector callbacks and receiver only. No real QQ network,
// credential exchange, model request or user's configuration file is accessed.
class FakeReceiver extends EventEmitter {
  starts = 0; stops = 0; stopFails = false;
  async start() { this.starts++; }
  async stop() { this.stops++; if (this.stopFails) throw new Error('private-secret'); }
}
const defaults = (): Config => ({ qq: { appid: '', allowedUsers: [], allowedGroups: [] }, agents: {} });
function fixture(overrides: Partial<QqQrSetupOptions> = {}) {
  const connections: { callbacks: QrConnectCallbacks; signal?: AbortSignal; disposed: number }[] = [];
  const receivers: FakeReceiver[] = []; const saved: Config[] = [];
  const setup = new QqQrSetup({ load: async () => undefined, save: async c => { saved.push(c); }, defaults, isRunning: () => false,
    qrFactory: (callbacks, options) => {
      assert.equal(options?.displayQrCodeToConsole, false); assert.equal(options?.source, 'aibotlink');
      const connection = { callbacks, signal: options?.signal, disposed: 0 }; connections.push(connection);
      return () => { connection.disposed++; };
    },
    makeQrDataUrl: async () => 'data:image/png;base64,TEST',
    createPairReceiver: () => { const receiver = new FakeReceiver(); receivers.push(receiver); return receiver; }, ...overrides });
  return { setup, connections, receivers, saved };
}
async function until(test: () => boolean) {
  const end = Date.now() + 2000;
  while (!test()) { if (Date.now() > end) throw new Error('Test state did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); }
}

test('native OpenID saves directly without hand entry, preserves only same-bot owner lists and never exposes secrets', async () => {
  const existing: Config = { ...defaults(), qq: { appid: 'same-bot', secretSource: { file: 'old-file', ref: 'old-ref' }, allowedUsers: ['old-owner'], allowedGroups: ['old-group'] } };
  const f = fixture({ load: async () => existing });
  try {
    assert.equal((await f.setup.start()).status, 'connecting');
    f.connections[0].callbacks.onQrDisplayed?.('https://example.test/auth?authorization=private');
    await until(() => f.setup.status().status === 'qr');
    assert.equal(f.setup.status().qrDataUrl, 'data:image/png;base64,TEST');
    f.connections[0].callbacks.onSuccess([{ appId: 'same-bot', appSecret: 'private-secret', userOpenid: 'scanned-owner' }]);
    await until(() => f.setup.status().status === 'ready');
    assert.deepEqual(f.saved[0].qq.allowedUsers, ['old-owner', 'scanned-owner']);
    assert.deepEqual(f.saved[0].qq.allowedGroups, ['old-group']); assert.equal(f.saved[0].qq.secretSource, undefined);
    assert.equal(f.saved[0].qq.secret, 'private-secret'); assert.equal(f.receivers.length, 0);
    assert.equal(f.connections[0].signal?.aborted, true); assert.equal(f.connections[0].disposed, 1);
    assert.equal(f.setup.status().busy, false); assert.ok(!JSON.stringify(f.setup.status()).includes('private'));

    await f.setup.start();
    f.connections[1].callbacks.onSuccess([{ appId: 'replacement', appSecret: 'replacement-secret', userOpenid: 'new-owner' }]);
    await until(() => f.saved.length === 2);
    assert.deepEqual(f.saved[1].qq.allowedUsers, ['new-owner']); assert.deepEqual(f.saved[1].qq.allowedGroups, []);
  } finally { await f.setup.cancel(); }
});

test('missing OpenID accepts only one exact private pairing nonce and stops receiver before saving', async () => {
  const f = fixture();
  try {
    await f.setup.start(); f.connections[0].callbacks.onSuccess([{ appId: 'pair-bot', appSecret: 'private-secret' }]);
    await until(() => f.setup.status().status === 'pairing');
    const code = f.setup.status().pairingCode!; assert.match(code, /^[A-Za-z0-9_-]{8}$/); assert.equal(f.setup.status().busy, true);
    const receiver = f.receivers[0];
    receiver.emit('message.private.friend', { user_id: 'stranger', raw_message: '/pair wrong' });
    receiver.emit('message.private.friend', { user_id: 'stranger', raw_message: 'ordinary task' });
    receiver.emit('message.private.friend', { user_id: '', raw_message: `/pair ${code}` });
    receiver.emit('message.group.at', { user_id: 'stranger', raw_message: `/pair ${code}` });
    assert.equal(f.saved.length, 0);
    receiver.emit('message.private.friend', { user_id: 'owner-from-native-event', raw_message: `/pair ${code}` });
    receiver.emit('message.private.friend', { user_id: 'second-owner', raw_message: `/pair ${code}` });
    await until(() => f.setup.status().status === 'ready');
    assert.equal(f.saved.length, 1); assert.ok(receiver.stops >= 1);
    assert.deepEqual(f.saved[0].qq.allowedUsers, ['owner-from-native-event']); assert.deepEqual(f.saved[0].qq.allowedGroups, []);
    assert.equal(f.setup.status().pairingCode, undefined); assert.ok(!JSON.stringify(f.setup.status()).includes('private-secret'));
  } finally { await f.setup.cancel(); }
});

test('multiple QR credentials publish only app ids and require explicit selection', async () => {
  const f = fixture();
  try {
    await f.setup.start(); f.connections[0].callbacks.onSuccess([
      { appId: 'first', appSecret: 'first-secret', userOpenid: 'one' }, { appId: 'second', appSecret: 'second-secret', userOpenid: 'two' },
    ]);
    assert.equal(f.setup.status().status, 'select'); assert.deepEqual(f.setup.status().candidates, [{ appId: 'first' }, { appId: 'second' }]);
    assert.ok(!JSON.stringify(f.setup.status()).includes('secret')); assert.equal(f.saved.length, 0);
    await assert.rejects(f.setup.select('missing'), /失效/); await f.setup.select('second');
    assert.equal(f.setup.status().status, 'ready'); assert.equal(f.saved[0].qq.appid, 'second');
  } finally { await f.setup.cancel(); }
});

test('cancel and replacement generations invalidate pending QR rendering, callbacks and deferred configuration loads', async () => {
  let render!: (url: string) => void;
  let load!: (c: Config | undefined) => void;
  const delayedLoad = new Promise<Config | undefined>(resolve => { load = resolve; });
  const f = fixture({ makeQrDataUrl: () => new Promise<string>(resolve => { render = resolve; }), load: () => delayedLoad });
  try {
    await f.setup.start(); const stale = f.connections[0]; stale.callbacks.onQrDisplayed?.('private-url');
    await f.setup.cancel(); render('data:image/png;base64,STALE');
    stale.callbacks.onSuccess([{ appId: 'stale', appSecret: 'stale-secret', userOpenid: 'stale-owner' }]);
    assert.equal(f.setup.status().status, 'cancelled'); assert.equal(f.saved.length, 0);
    await f.setup.start(); f.connections[1].callbacks.onSuccess([{ appId: 'new', appSecret: 'new-secret', userOpenid: 'new-owner' }]);
    await until(() => f.setup.status().status === 'saving');
    const cancelled = f.setup.cancel(); load(undefined); await cancelled;
    assert.equal(f.saved.length, 0); assert.equal(f.setup.status().status, 'cancelled');
    stale.callbacks.onFailure(new Error('stale-secret')); assert.equal(f.setup.status().status, 'cancelled');
  } finally { load(undefined); await f.setup.cancel(); }
});

test('pairing expires, old codes cannot bind, and cleanup failures keep runtime blocked', async () => {
  const f = fixture({ pairTimeoutMs: 15 });
  try {
    await f.setup.start(); f.connections[0].callbacks.onSuccess([{ appId: 'pair', appSecret: 'private-secret' }]);
    await until(() => f.setup.status().status === 'pairing');
    const oldCode = f.setup.status().pairingCode; const oldReceiver = f.receivers[0];
    await until(() => f.setup.status().status === 'expired' && !f.setup.status().busy);
    oldReceiver.emit('message.private.friend', { user_id: 'late-owner', raw_message: `/pair ${oldCode}` }); assert.equal(f.saved.length, 0);
    await f.setup.start(); f.connections[1].callbacks.onSuccess([{ appId: 'pair', appSecret: 'private-secret' }]);
    await until(() => f.setup.status().status === 'pairing');
    f.receivers[1].stopFails = true; await f.setup.cancel();
    assert.equal(f.setup.status().status, 'error'); assert.equal(f.setup.status().busy, true);
    assert.ok(!JSON.stringify(f.setup.status()).includes('private-secret'));
    f.receivers[1].stopFails = false; await f.setup.cancel(); assert.equal(f.setup.status().busy, false);
  } finally { for (const receiver of f.receivers) receiver.stopFails = false; await f.setup.cancel(); }
});

test('an active gateway prevents QR startup and raw SDK failures remain private', async () => {
  const blocked = fixture({ isRunning: () => true });
  await assert.rejects(blocked.setup.start(), /先停止网关/); assert.equal(blocked.connections.length, 0);
  const f = fixture();
  try {
    await f.setup.start(); f.connections[0].callbacks.onFailure(new Error('credentials private-secret'));
    await until(() => f.setup.status().status === 'error' && !f.setup.status().busy);
    assert.equal(f.setup.status().messageKey, 'qqQr.failed'); assert.ok(!JSON.stringify(f.setup.status()).includes('private-secret'));
  } finally { await f.setup.cancel(); }
});
