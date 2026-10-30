import { t as uiText } from './messages.js';
import { EventEmitter } from 'node:events';
import { RpcClient, RpcError, type Data } from './rpc.js';
import { HostRpcClient } from './host-rpc.js';
import type { AgentConfig } from './config.js';

export interface TurnTiming { nativeMs: number; firstTextMs?: number; acceptMs?: number; model?: string; reasoning?: string }
interface Run { turn?: string; messages: string[]; final: string; delta: string; startedAt: number; firstTextMs?: number; acceptMs?: number; model?: string; reasoning?: string }
export interface NativeEvent { kind: 'progress' | 'done' | 'failed' | 'request' | 'resolved' | 'closed'; session?: string; text?: string; request?: Data; timing?: TurnTiming }
export class SessionWriterConflict extends Error {
  constructor(cause: RpcError) { super(uiText('session.writerConflict'), { cause }); }
}
export class NativeAgent extends EventEmitter {
  rpc?: RpcClient | HostRpcClient;
  connecting?: Promise<void>;
  error?: string;
  capabilities: Data = {};
  sessions = new Map<string, Data>();
  runs = new Map<string, Run>();
  private untouched = new Set<string>();
  constructor(readonly id: string, readonly config: AgentConfig) { super(); }
  private event(e: NativeEvent) { this.emit('event', e); }
  async start() {
    if (this.connecting) return this.connecting;
    if (this.rpc?.alive) return;
    this.connecting = this.connect();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private async connect() {
    const rpc = this.config.dshBridge ? await HostRpcClient.connect(this.config.dshBridge) : new RpcClient(this.config);
    this.rpc = rpc; this.error = undefined;
    rpc.on('notification', (m: Data) => this.notification(m));
    rpc.on('request', (m: Data) => this.event({ kind: 'request', session: m.params?.threadId ?? m.params?.sessionId, request: m }));
    rpc.on('closed', (e: Error) => {
      if (this.rpc !== rpc) return;
      this.error = e.message; this.sessions.clear(); this.runs.clear(); this.untouched.clear();
      this.event({ kind: 'closed', text: e.message });
    });
    try {
      if (this.config.type === 'codex') {
        await rpc.call('initialize', { clientInfo: { name: 'aibotlink', title: 'AIBotLink', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        rpc.notify('initialized', {});
      } else {
        const r = await rpc.call('initialize', { protocolVersion: 1, clientInfo: { name: 'aibotlink', version: '0.1.0' }, clientCapabilities: {} });
        this.capabilities = r.agentCapabilities;
      }
    } catch (e) { this.error = (e as Error).message; await rpc.stop(); throw e; }
  }
  async stop() { await this.rpc?.stop(); this.rpc = undefined; this.sessions.clear(); this.untouched.clear(); this.error = undefined; }
  async releaseIdle() {
    if (this.connecting || this.runs.size) throw new Error(uiText('release.busy'));
    if (this.config.type === 'codex' && this.rpc?.alive) {
      // A compaction can remain active after its start request returns. Verify
      // native runtime status as well as gateway turns before stopping the host.
      const loaded = await this.rpc.call('thread/loaded/list');
      for (const id of loaded.data as string[]) {
        try {
          const r = await this.rpc.call('thread/read', { threadId: id });
          if (r.thread.status.type !== 'idle') throw new Error(uiText('release.busy'));
        } catch (error) {
          // COMPAT(Codex 0.153.2): an untouched thread may have no saved rollout.
          // Only locally known, never-submitted threads can be discarded safely.
          if (!this.untouched.has(id) || !(error as Error).message.includes('no rollout found for thread id')) throw error;
        }
      }
    }
    const unsaved = [...this.untouched];
    await this.stop();
    return unsaved;
  }
  async create() {
    await this.start();
    const r = this.config.type === 'codex'
      ? await this.rpc!.call('thread/start', { cwd: this.config.cwd, ...(this.config.model ? { model: this.config.model } : {}) })
      : await this.rpc!.call('session/new', { cwd: this.config.cwd, mcpServers: [] });
    const id = this.config.type === 'codex' ? r.thread.id : r.sessionId;
    this.sessions.set(id, r);
    if (this.config.type === 'codex') this.untouched.add(id);
    return id as string;
  }
  async attach(id: string) {
    await this.start(); if (this.sessions.has(id)) return;
    const r = this.config.type === 'codex'
      ? await this.resumeCodex({ threadId: id, excludeTurns: true })
      : await this.rpc!.call('session/resume', { sessionId: id, cwd: this.config.cwd, mcpServers: [] });
    this.sessions.set(id, r);
  }
  async fork(id: string): Promise<string> {
    if (this.config.dshBridge) {
      if (this.runs.has(id)) throw new Error(uiText('fork.sourceBusy'));
      await this.start(); const r = await this.rpc!.call('session/fork', { sessionId: id });
      this.sessions.set(r.sessionId, r); return r.sessionId;
    }
    if (this.config.type !== 'codex') throw new Error(uiText('fork.dshUnsupported'));
    if (this.runs.has(id)) throw new Error(uiText('fork.sourceBusy'));
    if (this.untouched.has(id)) throw new Error(uiText('fork.noSavedHistory'));
    await this.start();
    // Read stored metadata without resuming or taking the source's writer lock.
    const source = await this.rpc!.call('thread/read', { threadId: id });
    if (source.thread.status?.type === 'active') throw new Error(uiText('fork.sourceBusy'));
    const r = await this.rpc!.call('thread/fork', { threadId: id, excludeTurns: true });
    const next = r.thread.id;
    this.sessions.set(next, r);
    // A fork contains native persisted history. It must never enter untouched:
    // reconfiguration must preserve that history rather than create a new thread.
    return next;
  }
  private async resumeCodex(params: Data) {
    try { return await this.rpc!.call('thread/resume', params); }
    catch (error) {
      // COMPAT(Codex 0.153.2): writer contention uses the generic -32600 code.
      // Match the observed native message as well; other errors remain distinct.
      if (error instanceof RpcError && error.code === -32600 && /\balready has an active writer\b/.test(error.nativeMessage)) throw new SessionWriterConflict(error);
      throw error;
    }
  }
  async list(cursor?: string) {
    await this.start();
    if (this.config.type === 'codex') {
      const r = await this.rpc!.call('thread/list', { cwd: this.config.cwd, limit: 4, ...(cursor ? { cursor } : {}) });
      return { items: r.data.map((s: Data) => ({ id: s.id, title: s.name || s.preview || s.id })), cursor: r.nextCursor };
    }
    if (!this.capabilities.sessionCapabilities?.list) throw new Error(uiText("session.listUnsupported"));
    const r = await this.rpc!.call('session/list', { cwd: this.config.cwd, ...(cursor ? { cursor } : {}) });
    return { items: r.sessions.map((s: Data) => ({ id: s.sessionId, title: s.title || s.sessionId })), cursor: r.nextCursor };
  }
  async models() {
    await this.start();
    if (this.config.type === 'codex') return (await this.rpc!.call('model/list', {})).data;
    return [...this.sessions.values()].at(-1)?.configOptions?.filter((o: Data) => o.category === 'model') ?? [];
  }
  async catalog(id: string): Promise<{ value: string; name: string; provider?: string }[]> {
    if (this.config.dshBridge) await this.settings(id);
    await this.attach(id);
    if (this.config.type === 'codex') return (await this.models()).filter((m: Data) => !m.hidden).map((m: Data) => ({ value: m.model || m.id, name: m.displayName || m.model || m.id }));
    const option = (this.sessions.get(id)!.configOptions ?? []).find((o: Data) => o.category === 'model');
    return (option?.options ?? []).flatMap((group: Data) => group.options
      ? group.options.map((m: Data) => ({ value: m.value, name: m.name, provider: group.group }))
      : [{ value: group.value, name: group.name }]);
  }
  async providers(id: string) {
    await this.attach(id);
    if (this.config.type === 'dsh') return [...new Set((await this.catalog(id)).map(m => m.provider).filter(Boolean))] as string[];
    const r = await this.rpc!.call('config/read', { includeLayers: false });
    return [...new Set([this.sessions.get(id)!.modelProvider, ...Object.keys(r.config.model_providers ?? {})].filter(Boolean))] as string[];
  }
  async provider(id: string) {
    await this.attach(id);
    if (this.config.type === 'codex') return this.sessions.get(id)!.modelProvider as string;
    const value = (this.sessions.get(id)!.configOptions ?? []).find((o: Data) => o.category === 'model')?.currentValue;
    return (await this.catalog(id)).find(m => m.value === value)?.provider ?? uiText("provider.nativeDefault");
  }
  async setProvider(id: string, provider: string) {
    if (this.runs.has(id)) throw new Error(uiText('task.sessionBusy'));
    if (!(await this.providers(id)).includes(provider)) throw new Error(uiText("provider.notListed"));
    if (await this.provider(id) === provider) return { provider, session: id };
    if (this.config.type === 'codex') {
      id = await this.reconfigureCodex(id, { modelProvider: provider });
    } else {
      const model = (await this.catalog(id)).find(m => m.provider === provider);
      if (!model) throw new Error(uiText("provider.noModels"));
      await this.setOption(id, 'model', model.value);
    }
    return { provider: await this.provider(id), session: id };
  }
  async history(id: string) {
    if (this.config.dshBridge) { await this.start(); return (await this.rpc!.call('session/history', { sessionId: id })).text as string; }
    if (this.config.type !== 'codex') throw new Error(uiText("history.dshUnsupported"));
    await this.start();
    const r = await this.rpc!.call('thread/turns/list', { threadId: id, limit: 5, sortDirection: 'desc', itemsView: 'full' });
    return r.data.reverse().flatMap((t: Data) => t.items.filter((i: Data) => ['userMessage', 'agentMessage'].includes(i.type)).map((i: Data) => i.text ?? i.content?.map((x: Data) => x.text || '').join(''))).join('\n\n');
  }
  async settings(id: string) {
    await this.attach(id);
    if (this.config.dshBridge) this.sessions.set(id, await this.rpc!.call('session/resume', { sessionId: id, cwd: this.config.cwd }));
    return this.sessions.get(id)!;
  }
  async setOption(id: string, kind: 'model' | 'reasoning', value: string) {
    await this.settings(id);
    if (this.runs.has(id)) throw new Error(uiText('task.sessionBusy'));
    if (this.config.type === 'codex') throw new Error(uiText("settings.codexUseTurn"));
    const options: Data[] = this.sessions.get(id)!.configOptions ?? [];
    const option = options.find(o => kind === 'model' ? o.category === 'model' : o.category === 'thought_level');
    if (!option) throw new Error(uiText("settings.notExposed"));
    const r = await this.rpc!.call('session/set_config_option', { sessionId: id, configId: option.id, value });
    this.sessions.set(id, { ...this.sessions.get(id), configOptions: r.configOptions });
    return r.configOptions;
  }
  async setPermission(id: string, mode: string) {
    await this.attach(id);
    if (this.runs.has(id)) throw new Error(uiText('task.sessionBusy'));
    if (this.config.dshBridge) return this.rpc!.call('session/set_permission', { sessionId: id, mode });
    if (this.config.type !== 'codex') throw new Error(uiText('permission.dshUnsupported'));
    if (!['read-only', 'workspace-write'].includes(mode)) throw new Error(uiText('permission.modeUnsupported'));
    const next = await this.reconfigureCodex(id, { sandbox: mode, approvalPolicy: 'on-request' });
    const r = this.sessions.get(next)!;
    return { session: next, sandbox: r.sandbox, approvalPolicy: r.approvalPolicy };
  }
  async permissionOptions(id?: string): Promise<{ value: string; name: string }[]> {
    if (this.config.type === 'codex') return [{ value: 'read-only', name: uiText('button.readOnly') }, { value: 'workspace-write', name: uiText('button.workspaceWrite') }];
    if (!this.config.dshBridge || !id) throw new Error(uiText('permission.dshUnsupported'));
    await this.start(); return (await this.rpc!.call('session/permissions', { sessionId: id })).options;
  }
  private async reconfigureCodex(id: string, overrides: Data) {
    const current = this.sessions.get(id)!;
    const modes: Record<string, string> = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' };
    const inheritedSandbox = modes[current.sandbox?.type];
    if (this.untouched.has(id) && !inheritedSandbox) throw new Error(uiText('settings.cannotPreserveNativePolicy'));
    const params = { cwd: current.cwd || this.config.cwd, model: current.model, modelProvider: current.modelProvider,
      ...(this.untouched.has(id) ? { sandbox: inheritedSandbox, approvalPolicy: current.approvalPolicy } : {}), ...overrides };
    // Codex 0.153.2 cannot resume a newly-created thread before its first turn
    // materializes a rollout. Recreate only threads we know have never received
    // user input; history-bearing threads always use the native resume contract.
    const r = this.untouched.has(id)
      ? await this.rpc!.call('thread/start', params)
      : await this.resumeCodex({ threadId: id, excludeTurns: true, ...params });
    const next = r.thread.id; this.sessions.set(next, r);
    if (this.untouched.has(id)) this.untouched.add(next);
    return next as string;
  }
  async reasoningOptions(id: string) {
    await this.settings(id);
    if (this.config.type === 'dsh') return (this.sessions.get(id)!.configOptions ?? []).find((o: Data) => o.category === 'thought_level');
    const current = this.sessions.get(id)!;
    const model = (await this.models()).find((m: Data) => m.model === current.model || m.id === current.model);
    return model?.supportedReasoningEfforts;
  }
  async send(id: string, text: string, settings: Record<string, string>) {
    await this.attach(id);
    if (this.runs.has(id)) throw new Error(uiText("task.sessionBusy"));
    const native = this.sessions.get(id)!;
    const run: Run = { messages: [], final: '', delta: '', startedAt: Date.now(), model: settings.model || native.model, reasoning: settings.reasoning || native.reasoningEffort };
    this.runs.set(id, run);
    if (this.config.type === 'codex') {
      try {
        // Even a timed-out submission may have reached the native backend.
        // Never classify it as an untouched/replaceable empty thread again.
        this.untouched.delete(id);
        const r = await this.rpc!.call('turn/start', { threadId: id, input: [{ type: 'text', text }], ...(settings.model ? { model: settings.model } : {}), ...(settings.reasoning ? { effort: settings.reasoning } : {}) });
        run.acceptMs = Date.now() - run.startedAt;
        run.turn = r.turn.id;
        return;
      } catch (e) { this.runs.delete(id); throw e; }
    }
    // ACP session/prompt remains pending until completion; don't impose a model-task timeout.
    void this.rpc!.call('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }] }, 0).then(r => {
      // HTTP completion and SSE may arrive on different connections. The bridge
      // returns canonical final text in the RPC result as well as a live event.
      this.finish(id, r.stopReason === 'cancelled' ? uiText("task.interrupted") : typeof r.text === 'string' ? r.text : undefined);
    }, e => { this.runs.delete(id); this.event({ kind: 'failed', session: id, text: e.message }); });
  }
  async interrupt(id: string) {
    const run = this.runs.get(id); if (!run) throw new Error(uiText("task.noneActive"));
    if (this.config.type === 'codex') await this.rpc!.call('turn/interrupt', { threadId: id, turnId: run.turn });
    else if (this.config.dshBridge) await this.rpc!.call('session/cancel', { sessionId: id });
    else this.rpc!.notify('session/cancel', { sessionId: id });
  }
  async steer(id: string, text: string) {
    if (this.config.dshBridge) { await this.start(); await this.rpc!.call('session/steer', { sessionId: id, text }); return; }
    if (this.config.type !== 'codex') throw new Error(uiText("steer.dshUnsupported"));
    const run = this.runs.get(id); if (!run?.turn) throw new Error(uiText("steer.noActiveTurn"));
    await this.rpc!.call('turn/steer', { threadId: id, expectedTurnId: run.turn, input: [{ type: 'text', text }] });
  }
  async compact(id: string) {
    await this.attach(id);
    if (this.config.dshBridge) { await this.rpc!.call('session/compact', { sessionId: id }); return; }
    if (this.config.type !== 'codex') throw new Error(uiText("compact.dshUnsupported"));
    await this.rpc!.call('thread/compact/start', { threadId: id });
  }
  private finish(id: string, override?: string) {
    const run = this.runs.get(id); if (!run) return;
    this.runs.delete(id);
    this.event({ kind: 'done', session: id, text: override || run.final || run.messages.at(-1) || run.delta || uiText("task.completedWithoutText"), timing: {
      nativeMs: Date.now() - run.startedAt, firstTextMs: run.firstTextMs, acceptMs: run.acceptMs, model: run.model, reasoning: run.reasoning,
    } });
  }
  private notification(m: Data) {
    const p = m.params ?? {}; const id = p.threadId ?? p.sessionId;
    const run = this.runs.get(id);
    if (m.method === 'session/update' && p.update?.sessionUpdate === 'config_option_update' && this.sessions.has(id)) {
      this.sessions.set(id, { ...this.sessions.get(id), configOptions: p.update.configOptions });
    }
    if (m.method === 'serverRequest/resolved') this.event({ kind: 'resolved', session: id, request: p });
    if (m.method === 'turn/started' && run) run.turn = p.turn.id;
    if (m.method === 'item/agentMessage/delta' && run) { run.firstTextMs ??= Date.now() - run.startedAt; run.delta += p.delta; }
    if (m.method === 'item/completed' && run && p.item.type === 'agentMessage') {
      run.messages.push(p.item.text); if (p.item.phase === 'final_answer') run.final += p.item.text;
    }
    if (m.method === 'item/started' && run && ['commandExecution', 'fileChange', 'mcpToolCall'].includes(p.item.type)) this.event({ kind: 'progress', session: id, text: uiText("progress.toolStarted", { v0: p.item.type }) });
    if (m.method === 'turn/completed' && run) {
      if (p.turn.status === 'failed') { this.runs.delete(id); this.event({ kind: 'failed', session: id, text: p.turn.error?.message || uiText("task.nativeFailed") }); }
      else this.finish(id, p.turn.status === 'interrupted' ? uiText("task.interrupted") : undefined);
    }
    if (m.method === 'session/update' && run) {
      const u = p.update;
      if (u.sessionUpdate === 'agent_message_final' && typeof u.text === 'string') { run.final = u.text; run.delta = u.text; run.messages = []; }
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') { run.firstTextMs ??= Date.now() - run.startedAt; run.delta += u.content.text; }
      if (u.sessionUpdate === 'tool_call') this.event({ kind: 'progress', session: id, text: uiText("progress.toolStarted", { v0: u.title || uiText("progress.tool") }) });
    }
  }
}

