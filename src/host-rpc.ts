import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { outsideRepository } from './config.js';
import { RpcError, type Data } from './rpc.js';
import { t as uiText } from './messages.js';

// Companion transport: one authenticated loopback SSE connection owns its RPCs
// and approval responses. Closing this client never stops the Desktop host.
// Uses node:http instead of fetch: a prompt RPC can stay pending for the whole
// native turn, which exceeds the fetch client's default 5 minute header/body caps.
export class HostRpcClient extends EventEmitter {
  private readonly connection = randomUUID();
  private readonly controller = new AbortController();
  private readonly target: URL;
  private nextId = 0;
  private dead?: Error;
  private stream?: Promise<void>;
  private constructor(url: URL, private readonly token: string) { super(); this.target = url; }
  get alive() { return !this.dead; }

  static async connect(configFile: string): Promise<HostRpcClient> {
    outsideRepository(configFile);
    let config: Data;
    try {
      outsideRepository(await realpath(configFile));
      config = JSON.parse(await readFile(configFile, 'utf8'));
    } catch { throw new Error(uiText('hostRpc.invalidConfig')); }
    let url: URL;
    try { url = new URL(config.url); } catch { throw new Error(uiText('hostRpc.invalidConfig')); }
    if (config.version !== 1 || typeof config.token !== 'string' || !/^[a-f0-9]{32,}$/i.test(config.token) ||
      typeof config.url !== 'string' || config.url.trim() !== config.url || url.protocol !== 'http:' ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+\/?$/.test(config.url) ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error(uiText('hostRpc.invalidConfig'));
    const client = new HostRpcClient(url, config.token);
    try { await client.openEvents(30_000); return client; }
    catch { client.controller.abort(); throw new Error(uiText('hostRpc.connectionFailed')); }
  }
  private headers(): http.OutgoingHttpHeaders {
    return { Authorization: `Bearer ${this.token}`, 'X-AIBotLink-Connection': this.connection, 'Content-Type': 'application/json' };
  }
  private end(error: Error) {
    if (this.dead) return;
    this.dead = error; this.controller.abort(); this.emit('closed', error);
  }
  private openEvents(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false; let timer: NodeJS.Timeout | undefined;
      const done = (error?: Error) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); if (error) reject(error); else resolve(); };
      const req = http.request({ host: this.target.hostname.replace(/^\[|\]$/g, ''), port: this.target.port, path: '/events', method: 'GET',
        headers: this.headers(), signal: this.controller.signal }, response => {
        const contentType = String(response.headers['content-type'] ?? '');
        if (response.statusCode !== 200 || !contentType.startsWith('text/event-stream')) { response.resume(); done(new Error(uiText('hostRpc.connectionFailed'))); return; }
        done();
        this.stream = this.readEvents(response);
      });
      timer = setTimeout(() => { req.destroy(); done(new Error(uiText('hostRpc.connectionFailed'))); }, timeoutMs);
      req.on('error', () => done(new Error(uiText('hostRpc.connectionFailed'))));
      req.end();
    });
  }
  private async readEvents(response: http.IncomingMessage) {
    let buffer = ''; let data: string[] = [];
    const line = (value: string) => {
      if (value === '') {
        if (!data.length) return;
        const event: Data = JSON.parse(data.join('\n')); data = [];
        if (typeof event.method !== 'string' || !event.method || !event.params || typeof event.params !== 'object') throw new Error();
        this.emit(event.id === undefined ? 'notification' : 'request', event);
      } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    };
    try {
      response.setEncoding('utf8');
      for await (const chunk of response) {
        buffer += chunk as string;
        // Bound a malformed/unframed event without logging native payloads.
        if (buffer.length + data.join('\n').length > 4 * 1024 * 1024) throw new Error();
        let end: number;
        while ((end = buffer.search(/[\r\n]/)) !== -1) {
          // Preserve a split CRLF terminator across chunks.
          if (buffer[end] === '\r' && end === buffer.length - 1) break;
          const value = buffer.slice(0, end);
          const size = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
          buffer = buffer.slice(end + size); line(value);
        }
      }
      if (this.alive) this.end(new Error(uiText('hostRpc.disconnected')));
    } catch {
      if (this.alive) this.end(new Error(uiText('hostRpc.disconnected')));
    }
  }
  private post(path: string, body: Data, timeout: number): Promise<Data> {
    if (this.dead) return Promise.reject(this.dead);
    const payload = JSON.stringify(body);
    const timeoutMessage = uiText('rpc.requestTimeout', { v0: body.method ?? path });
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      const req = http.request({ host: this.target.hostname.replace(/^\[|\]$/g, ''), port: this.target.port, path, method: 'POST',
        headers: { ...this.headers(), 'Content-Length': Buffer.byteLength(payload) }, signal: this.controller.signal }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) req.destroy(new Error(uiText('hostRpc.requestFailed')));
          else chunks.push(chunk);
        });
        response.on('error', () => fail(new Error(uiText('hostRpc.requestFailed'))));
        response.on('end', () => {
          if (settled) return;
          if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) return fail(new Error(uiText('hostRpc.requestFailed')));
          try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Data; settled = true; resolve(parsed); }
          catch { fail(new Error(uiText('hostRpc.requestFailed'))); }
        });
      });
      if (timeout) req.setTimeout(timeout, () => req.destroy(new Error(timeoutMessage)));
      req.on('error', (error: Error) => {
        if (this.dead) return fail(this.dead);
        fail(error.message === timeoutMessage ? error : new Error(uiText('hostRpc.requestFailed')));
      });
      req.end(payload);
    });
  }
  async call(method: string, params: Data = {}, timeout = 30_000): Promise<any> {
    const id = ++this.nextId;
    const response = await this.post('/rpc', { id, method, params }, timeout);
    if (response.id !== id) throw new Error(uiText('hostRpc.requestFailed'));
    if (response.error) throw new RpcError(method, response.error.code, response.error.message, response.error.data);
    if (!Object.hasOwn(response, 'result')) throw new Error(uiText('hostRpc.requestFailed'));
    return response.result;
  }
  notify(method: string, params: Data) {
    void this.post('/rpc', { method, params }, 30_000).then(response => {
      if (response.error) throw new RpcError(method, response.error.code, response.error.message, response.error.data);
    }).catch(error => this.end(error));
  }
  private async response(body: Data): Promise<void> {
    const reply = await this.post('/respond', body, 30_000);
    if (reply.error) throw new RpcError('/respond', reply.error.code, reply.error.message, reply.error.data);
  }
  async respond(id: number | string, result: unknown): Promise<void> { await this.response({ id, result }); }
  async reject(id: number | string, message: string): Promise<void> { await this.response({ id, error: { code: -32601, message } }); }
  async stop(): Promise<void> {
    this.end(new Error(uiText('hostRpc.disconnected')));
    await this.stream;
  }
}
