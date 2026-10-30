import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { outsideRepository } from './config.js';
import { RpcError, type Data } from './rpc.js';
import { t as uiText } from './messages.js';

// Companion transport: one authenticated loopback SSE connection owns its RPCs
// and approval responses. Closing this client never stops the Desktop host.
export class HostRpcClient extends EventEmitter {
  private readonly connection = randomUUID();
  private readonly controller = new AbortController();
  private nextId = 0;
  private dead?: Error;
  private stream?: Promise<void>;
  private constructor(private readonly url: string, private readonly token: string) { super(); }
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
    const client = new HostRpcClient(url.origin, config.token);
    const timeout = setTimeout(() => client.controller.abort(), 30_000);
    try {
      const response = await fetch(`${client.url}/events`, { headers: client.headers(), redirect: 'error', signal: client.controller.signal });
      if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await response.body?.cancel(); throw new Error(uiText('hostRpc.connectionFailed'));
      }
      client.stream = client.readEvents(response.body);
      return client;
    } catch {
      client.controller.abort(); throw new Error(uiText('hostRpc.connectionFailed'));
    } finally { clearTimeout(timeout); }
  }
  private headers() {
    return { Authorization: `Bearer ${this.token}`, 'X-AIBotLink-Connection': this.connection, 'Content-Type': 'application/json' };
  }
  private end(error: Error) {
    if (this.dead) return;
    this.dead = error; this.controller.abort(); this.emit('closed', error);
  }
  private async readEvents(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let data: string[] = [];
    const line = (value: string) => {
      if (value === '') {
        if (!data.length) return;
        const event: Data = JSON.parse(data.join('\n')); data = [];
        if (typeof event.method !== 'string' || !event.method || !event.params || typeof event.params !== 'object') throw new Error();
        this.emit(event.id === undefined ? 'notification' : 'request', event);
      } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    };
    try {
      while (this.alive) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
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
    } finally { reader.releaseLock(); }
  }
  private async post(path: string, body: Data, timeout: number): Promise<Data> {
    if (this.dead) throw this.dead;
    const timeoutController = new AbortController();
    const timer = timeout ? setTimeout(() => timeoutController.abort(), timeout) : undefined;
    try {
      const response = await fetch(`${this.url}${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), redirect: 'error',
        signal: AbortSignal.any([this.controller.signal, timeoutController.signal]) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      return await response.json() as Data;
    } catch {
      if (this.dead) throw this.dead;
      if (timeoutController.signal.aborted) throw new Error(uiText('rpc.requestTimeout', { v0: body.method ?? path }));
      throw new Error(uiText('hostRpc.requestFailed'));
    } finally { clearTimeout(timer); }
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
