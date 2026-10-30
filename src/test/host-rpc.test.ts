import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostRpcClient } from '../host-rpc.js';
import { RpcError } from '../rpc.js';
import { repositoryRoot } from '../config.js';

test('loopback Companion transport authenticates events/RPC, preserves errors and cancels without stopping host', async () => {
  // TEST_FIXTURE: an ephemeral localhost protocol peer, no Desktop/QQ/model.
  const token = 'a1'.repeat(32); let connection: string | undefined; let stream: ServerResponse | undefined;
  let captures = 0; let eventRedirect = false; const responses: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/capture') { captures++; res.end('{}'); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.url === '/events') {
      if (eventRedirect) { res.writeHead(302, { Location: '/capture' }).end(); return; }
      connection = req.headers['x-aibotlink-connection'] as string;
      stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); res.write(': ready\n\n'); return;
    }
    if (!connection || req.headers['x-aibotlink-connection'] !== connection) { res.writeHead(403).end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/respond') { responses.push(body); res.end('{}'); return; }
    if (body.method === 'wait') return; // Test cancellation of an infinite prompt.
    if (body.method === 'redirect') { res.writeHead(302, { Location: '/capture' }).end(); return; }
    if (body.method === 'native-error' || body.method === 'notification-error') {
      res.end(JSON.stringify({ id: body.id, error: { code: -32600, message: 'native failure', data: { reason: 'test' } } })); return;
    }
    res.end(JSON.stringify(body.id === undefined ? {} : { id: body.id, result: body.params }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(path.join(tmpdir(), 'aibotlink-host-rpc-')); const file = path.join(root, 'connection.json');
  const config = (overrides = {}) => writeFile(file, JSON.stringify({ version: 1, url, token, ...overrides }));
  let client: HostRpcClient | undefined;
  try {
    await config(); client = await HostRpcClient.connect(file);
    assert.match(connection!, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await client.call('echo', { text: 'test' }), { text: 'test' });
    await assert.rejects(client.call('native-error'), (error: unknown) => {
      assert.ok(error instanceof RpcError); assert.equal(error.code, -32600); assert.equal(error.method, 'native-error');
      assert.deepEqual(error.cause, { reason: 'test' }); return true;
    });
    await client.respond('approval', { decision: 'accept' }); await client.reject(3, 'unsupported');
    assert.deepEqual(responses, [{ id: 'approval', result: { decision: 'accept' } }, { id: 3, error: { code: -32601, message: 'unsupported' } }]);
    const notification = once(client, 'notification', { signal: AbortSignal.timeout(2000) });
    const data = Buffer.from('data: {"method":"notice",\r\ndata: "params":{"text":"中文"}}\r\n\r\n');
    // Fragment UTF-8 and CRLF arbitrarily; parser must preserve both.
    for (let offset = 0; offset < data.length; offset += 3) stream!.write(data.subarray(offset, offset + 3));
    assert.deepEqual((await notification)[0], { method: 'notice', params: { text: '中文' } });
    const request = once(client, 'request', { signal: AbortSignal.timeout(2000) });
    stream!.write('data: {"id":"approve","method":"permission","params":{}}\n\n');
    assert.equal((await request)[0].id, 'approve');
    await assert.rejects(client.call('wait', {}, 15), /超时/);
    assert.ok(client.alive); // A single request timeout does not silently replay/close.
    await assert.rejects(client.call('redirect'), /请求失败/); assert.equal(captures, 0);
    const pending = client.call('wait', {}, 0);
    const rejected = assert.rejects(pending, /断开/);
    await client.stop(); await rejected; assert.equal(client.alive, false);
    // Closing the transport leaves the independently owned server running.
    assert.ok(server.listening);

    client = await HostRpcClient.connect(file);
    const closed = once(client, 'closed', { signal: AbortSignal.timeout(2000) });
    stream!.end(); await closed; assert.equal(client.alive, false);

    client = await HostRpcClient.connect(file);
    const failedNotification = once(client, 'closed', { signal: AbortSignal.timeout(2000) });
    client.notify('notification-error', {}); assert.ok((await failedNotification)[0] instanceof RpcError);
    assert.equal(client.alive, false);

    await config({ token: 'bb'.repeat(32) });
    await assert.rejects(HostRpcClient.connect(file), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes(token)); return true;
    });
    await config(); eventRedirect = true;
    await assert.rejects(HostRpcClient.connect(file), /无法连接/); assert.equal(captures, 0);
    for (const invalid of ['http://example.com:1234', `${url}/rpc`, `${url}/../`, `${url}?key=1`, `${url}#fragment`, url.replace('http://', 'http://user:password@'), 'https://127.0.0.1:443']) {
      await config({ url: invalid }); await assert.rejects(HostRpcClient.connect(file), /配置无效/);
    }
    await assert.rejects(HostRpcClient.connect(path.join(repositoryRoot, 'connection.json')), /仓库外/);
  } finally {
    await client?.stop(); stream?.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});
