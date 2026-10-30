import { t as uiText } from './messages.js';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { AgentConfig } from './config.js';

export type Data = Record<string, any>;
export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number, readonly nativeMessage: string, data?: unknown) {
    super(`${method}: ${code}: ${nativeMessage}`, { cause: data });
  }
}
export class RpcClient extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private dead?: Error;
  diagnostics = '';
  private pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  constructor(readonly config: AgentConfig) {
    super();
    const env = { ...process.env, ...config.env };
    if (config.home) env[config.type === 'codex' ? 'CODEX_HOME' : 'DSH_HOME'] = config.home;
    this.child = spawn(config.command!, config.args ?? [], { cwd: config.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', data => {
      const safe = String(data).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/((?:access_token|refresh_token|api_key|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]');
      this.diagnostics = (this.diagnostics + safe).slice(-4000);
    });
    this.child.on('error', e => this.end(e));
    this.child.on('exit', code => this.end(new Error(uiText("runtime.nativeExited", { v0: code }))));
    this.child.stdin.on('error', e => this.end(e));
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      if (!line.trim()) return;
      // COMPAT(DSH 0.2.1-rc.2): observed account-catalog diagnostic on stdout.
      // Remove this exact-prefix shim after verifying a native version that
      // emits diagnostics only on stderr. Other malformed JSON still fails fast.
      if (this.config.type === 'dsh' && line.startsWith('[llm-deepseek-account] model list')) {
        this.emit('diagnostic', uiText("runtime.dshCatalogDiagnostic")); return;
      }
      let m: Data;
      try { m = JSON.parse(line); }
      catch {
        this.end(new Error(uiText("rpc.invalidStdout", { v0: line.length }))); return;
      }
      if (m.method) { this.emit(m.id === undefined ? 'notification' : 'request', m); return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new RpcError(p.method, m.error.code, m.error.message, m.error.data));
      else p.resolve(m.result);
    });
  }
  get alive() { return !this.dead; }
  private end(e: Error) {
    if (this.dead) return;
    this.dead = e;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear(); this.emit('closed', e);
  }
  private write(value: Data) {
    if (this.dead) throw this.dead;
    this.child.stdin.write(JSON.stringify({ ...(this.config.type === 'dsh' ? { jsonrpc: '2.0' } : {}), ...value }) + '\n');
  }
  call(method: string, params: Data = {}, timeout = 30_000): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id); reject(new Error(uiText("rpc.requestTimeout", { v0: method })));
      }, timeout) : undefined;
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: Data) { this.write({ method, params }); }
  respond(id: number | string, result: unknown) { this.write({ id, result }); }
  reject(id: number | string, message: string) { this.write({ id, error: { code: -32601, message } }); }
  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        // The PID is held by this live ChildProcess; never search by executable name.
        if (process.platform === 'win32' && this.child.pid && this.child.exitCode === null) {
          const killer = spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('exit', () => resolve()); killer.once('error', () => { this.child.kill(); resolve(); });
        } else { this.child.kill(); resolve(); }
      }, 3000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

