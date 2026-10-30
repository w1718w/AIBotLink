import { t as uiText } from './messages.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, dataHome } from './config.js';
import type { TurnTiming } from './agent.js';

export interface Binding { agent: string; sessions: Record<string, string>; settings: Record<string, Record<string, string>> }
export interface State {
  version: 1; scopes: Record<string, Binding>; delivered: string[];
  operations: Record<string, { agent: string; session: string; status: 'dispatching' | 'accepted' | 'unknown' | 'completed'; createdAt: string }>;
  responses: Record<string, string>;
  timings: Record<string, TurnTiming & { prepareMs: number; totalMs: number; deliveryMs?: number }>;
  qqPanels: Record<string, string>;
}
export class StateStore {
  value: State = { version: 1, scopes: {}, delivered: [], operations: {}, responses: {}, timings: {}, qqPanels: {} };
  private queue = Promise.resolve();
  constructor(readonly file = path.join(dataHome, 'state.json')) {}
  async load() {
    try { this.value = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (this.value.version !== 1) throw new Error(uiText("state.versionMismatch"));
    // Version-1 additive migration: older local state had no pending result store.
    this.value.responses ??= {};
    this.value.timings ??= {};
    for (const op of Object.values(this.value.operations)) if (op.status !== 'completed') op.status = 'unknown';
    return this;
  }
  save() {
    const snapshot = structuredClone(this.value);
    const next = this.queue.then(() => atomicJson(this.file, snapshot));
    this.queue = next.catch(() => {});
    return next;
  }
  scope(key: string, defaultAgent: string) {
    return this.value.scopes[key] ??= { agent: defaultAgent, sessions: {}, settings: {} };
  }
  async claim(messageId: string) {
    if (this.value.delivered.includes(messageId)) return false;
    this.value.delivered.push(messageId);
    this.value.delivered = this.value.delivered.slice(-2000);
    await this.save();
    return true;
  }
}

