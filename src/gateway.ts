import { defaultMessages, t as uiText, type MessageKey } from './messages.js';
import { randomBytes } from 'node:crypto';
import { NativeAgent, SessionWriterConflict, type NativeEvent } from './agent.js';
import type { Config } from './config.js';
import { StateStore, type Binding } from './state.js';
import type { Data } from './rpc.js';

export interface Action { label: string; command: string }
export type Reply = (text: string, actions?: Action[]) => Promise<void>;
export interface Input { id: string; scope: string; user: string; group?: string; text: string; reply: Reply; receivedAt?: number }
interface Command { name: string; description: string; shortLabel: string; aliases: string[]; arguments?: string; run: (i: Input, b: Binding, args: string) => Promise<void> }
interface Task { scope: string; reply: Reply; progress: number; lastProgress: number; startedAt: number; prepareMs: number }
interface Pending { scope: string; agent: string; session: string; request: Data; expires: number }
interface SessionPage { scope: string; agent: string; items: Data[]; nativeCursor?: string; expires: number }

// DSH 模型选项值以 JSON 编码的 [provider, model] 字符串传递；聊天回复只展示可读名称。
const modelLabel = (value: string) => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every(part => typeof part === 'string') ? `${parsed[0]} / ${parsed[1]}` : value;
  } catch { return value; }
};


export class Gateway {
  readonly agents: Map<string, NativeAgent>;
  readonly commands: Command[];
  readonly tasks = new Map<string, Task>();
  readonly pending = new Map<string, Pending>();
  private inbox = new Map<string, Promise<void>>();
  private sessionPages = new Map<string, SessionPage>();
  private dispatches = 0;
  private releasing = false;
  constructor(readonly config: Config, readonly store: StateStore) {
    this.agents = new Map(Object.entries(config.agents).map(([id, cfg]) => [id, new NativeAgent(id, cfg)]));
    for (const a of this.agents.values()) a.on('event', (e: NativeEvent) => { void this.nativeEvent(a, e).catch(error => console.error(uiText("delivery.eventFailed"), error.message)); });
    this.commands = this.registry();
  }
  allowed(i: Pick<Input, 'user' | 'group'>) {
    return this.config.qq.allowedUsers.includes(i.user) && (!i.group || this.config.qq.allowedGroups.includes(i.group));
  }
  private agent(b: Binding) {
    const a = this.agents.get(b.agent); if (!a) throw new Error(uiText("agent.selectConfigured")); return a;
  }
  private async session(b: Binding) {
    const a = this.agent(b);
    if (!b.sessions[a.id]) { b.sessions[a.id] = await a.create(); await this.store.save(); }
    else await a.attach(b.sessions[a.id]);
    return b.sessions[a.id];
  }
  async receive(i: Input) {
    if (!this.allowed(i)) return;
    i.receivedAt ??= Date.now();
    // Serialize only submission/command handling, never wait for the model's
    // whole turn here: Stop and approval messages must remain processable.
    const previous = this.inbox.get(i.scope) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.dispatch(i));
    this.inbox.set(i.scope, next);
    try { await next; } finally { if (this.inbox.get(i.scope) === next) this.inbox.delete(i.scope); }
  }
  private async dispatch(i: Input) {
    // Handoff must not overlap any command/submission that might load a thread.
    // Only the short release window blocks other scopes; model turns stay async.
    if (this.releasing) { await i.reply(uiText('release.inProgress')); return; }
    this.dispatches++;
    try { await this.dispatchOwned(i); } finally { this.dispatches--; }
  }
  private async dispatchOwned(i: Input) {
    if (!(await this.store.claim(i.id))) return;
    for (const task of this.tasks.values()) if (task.scope === i.scope) task.reply = i.reply;
    const b = this.store.scope(i.scope, this.agents.keys().next().value ?? '');
    try {
      const match = i.text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
      const alias = this.commands.find(c => c.aliases.includes(i.text.trim()));
      if (match || alias) {
        const command = alias || this.commands.find(c => c.name === match![1]);
        if (!command) throw new Error(uiText("command.unknown"));
        await command.run(i, b, match?.[2]?.trim() || '');
        await this.store.save(); return;
      }
      if (!i.text.trim()) throw new Error(uiText("input.textOnly"));
      if (this.store.value.operations[i.scope]) throw new Error(uiText("task.unresolvedSubmission"));
      const a = this.agent(b); const session = await this.session(b); const key = `${a.id}:${session}`;
      if (this.tasks.has(key)) throw new Error(uiText("task.ownedByAnotherChat"));
      this.tasks.set(key, { scope: i.scope, reply: i.reply, progress: 0, lastProgress: Date.now(), startedAt: i.receivedAt!, prepareMs: Date.now() - i.receivedAt! });
      this.store.value.operations[i.scope] = { agent: a.id, session, status: 'dispatching', createdAt: new Date().toISOString() };
      await this.store.save();
      try { await i.reply(uiText("task.submitting", { v0: a.id })); }
      catch (error) {
        // Native dispatch has not happened. It is safe to clear only this unsent operation.
        this.tasks.delete(key); delete this.store.value.operations[i.scope]; await this.store.save(); throw error;
      }
      try {
        await a.send(session, i.text, b.settings[a.id] ?? {});
        const op = this.store.value.operations[i.scope];
        if (op && op.status === 'dispatching') { op.status = 'accepted'; await this.store.save(); }
      } catch (e) {
        const op = this.store.value.operations[i.scope]; if (op && op.status !== 'completed') op.status = 'unknown';
        this.tasks.delete(key); await this.store.save(); throw e;
      }
    } catch (e) {
      if (e instanceof SessionWriterConflict) await i.reply(e.message, [
        { label: uiText('button.new'), command: '/new' },
        { label: uiText('button.status'), command: '/status' },
      ]);
      else await i.reply(uiText("operation.failed", { v0: (e as Error).message }));
    }
  }
  private registry(): Command[] {
    const cmd = (name: string, description: string, run: Command['run'], args?: string): Command => {
      const labelKey = `button.${name}` as MessageKey;
      return { name, description, shortLabel: labelKey in defaultMessages ? uiText(labelKey) : description, aliases: name === 'release' ? [uiText('command.release.alias')].filter(s => s.trim()) : [], run, arguments: args };
    };
    return [
      cmd('help', uiText("command.help.description"), async i => i.reply(this.commands.map(c => `/${c.name}${c.arguments ? ' ' + c.arguments : ''} — ${c.description}`).join('\n'))),
      cmd('m', uiText("command.m.description"), async (i, b, arg) => {
        const selected = this.commands.find(c => c.name === arg);
        if (selected) {
          const related: Record<string, string> = { agent: 'agents', session: 'sessions', model: 'models', provider: 'providers', reasoning: 'reasonings', permission: 'permissionlist' };
          const directory = this.commands.find(c => c.name === related[selected.name]);
          const actions = selected.name === 'runtime' ? ['start', 'stop', 'restart'].map(action => ({ label: uiText(`button.runtime.${action}` as MessageKey), command: `/runtime ${action} ${b.agent}` })) : directory ? [{ label: directory.shortLabel, command: `/${directory.name}` }] : [];
          actions.push({ label: uiText('button.menu'), command: '/m' });
          return i.reply(uiText('menu.usage', { command: `/${selected.name}${selected.arguments ? ' ' + selected.arguments : ''}`, description: selected.description }), actions);
        }
        const common = ['agents', 'status', 'sessions', 'new', 'fork', 'stop'];
        const ordered = [...common.flatMap(name => this.commands.filter(c => c.name === name)), ...this.commands.filter(c => !common.includes(c.name))];
        const page = Number(arg || 0); const size = 3; const pages = Math.ceil(ordered.length / size);
        if (!Number.isInteger(page) || page < 0 || page >= pages) throw new Error(uiText('catalog.invalidPage'));
        const items = ordered.slice(page * size, (page + 1) * size);
        await i.reply(uiText('menu.page', { page: page + 1, pages, items: items.map(c => `/${c.name} — ${c.description}`).join('\n') }), [
          ...items.map(c => ({ label: c.shortLabel, command: c.arguments?.includes('<') ? `/m ${c.name}` : `/${c.name}` })),
          ...(page > 0 ? [{ label: uiText('button.previous'), command: `/m ${page - 1}` }] : []),
          ...(page + 1 < pages ? [{ label: uiText('button.next'), command: `/m ${page + 1}` }] : []),
        ]);
      }, '[page|command]'),
      cmd('agents', uiText("command.agents.description"), async (i, b) => i.reply([...this.agents.values()].map(a => uiText("agents.row", { v0: b.agent === a.id ? '✓ ' : '', v1: a.id, v2: a.rpc?.alive ? uiText("runtime.running") : uiText("runtime.unavailable"), v3: a.runs.size, v4: a.error ? `；${a.error}` : '' })).join('\n'), [...this.agents.keys()].map(id => ({ label: id, command: `/agent ${id}` })))),
      cmd('agent', uiText("command.agent.description"), async (i, b, arg) => {
        if (!arg) return i.reply(uiText("agent.current", { v0: b.agent }));
        if (!this.agents.has(arg)) throw new Error(uiText("agent.notFound"));
        b.agent = arg; await i.reply(uiText("agent.selected", { v0: arg }));
      }, '[id]'),
      cmd('runtime', uiText("command.runtime.description"), async (i, _b, arg) => {
        const [action, id] = arg.split(/\s+/); const a = this.agents.get(id);
        if (!a || !['start', 'stop', 'restart'].includes(action)) throw new Error(uiText("runtime.usage"));
        if (action !== 'start') await a.stop();
        if (action !== 'stop') await a.start();
        await i.reply(uiText("runtime.actionCompleted", { v0: id, v1: action }));
      }, 'start|stop|restart <id>'),
      cmd('status', uiText("command.status.description"), async (i, b) => {
        const op = this.store.value.operations[i.scope];
        const loaded = this.agents.get(b.agent)?.sessions.has(b.sessions[b.agent]);
        await i.reply(uiText("status.summary", { v0: b.agent, v1: b.sessions[b.agent] || uiText("session.notCreated"), v2: op ? `${op.agent} / ${op.status}` : uiText("task.idle"), v3: [...this.pending.values()].filter(p => p.scope === i.scope).length, ownership: uiText(loaded ? 'release.loaded' : 'release.notLoaded') }), loaded ? [{ label: uiText('button.release'), command: '/release' }] : undefined);
        const timing = this.store.value.timings[i.scope];
        const seconds = (ms?: number) => ms === undefined ? '—' : (ms / 1000).toFixed(1);
        if (timing) await i.reply(uiText('status.timing', { prepare: seconds(timing.prepareMs), native: seconds(timing.nativeMs), first: seconds(timing.firstTextMs), delivery: seconds(timing.deliveryMs), total: seconds(timing.totalMs), model: timing.model || '—', reasoning: timing.reasoning || '—' }));
      }),
      cmd('release', uiText('command.release.description'), async (i, b) => {
        const a = this.agent(b);
        if (this.dispatches !== 1 || [...this.tasks.keys()].some(key => key.startsWith(`${a.id}:`)) ||
          Object.values(this.store.value.operations).some(op => op.agent === a.id && op.status !== 'completed') ||
          [...this.pending.values()].some(p => p.agent === a.id)) throw new Error(uiText('release.busy'));
        this.releasing = true;
        try {
          const unsaved = await a.releaseIdle();
          // Empty Codex threads have no resumable history on this native version.
          // Remove only bindings returned as known never-submitted by this host.
          for (const binding of Object.values(this.store.value.scopes)) if (unsaved.includes(binding.sessions[a.id])) delete binding.sessions[a.id];
          await this.store.save();
          await i.reply(uiText('release.completed', { agent: a.id, session: b.sessions[a.id] || uiText('session.notBound'), empty: unsaved.length ? uiText('release.emptyDiscarded') : '' }));
        } finally { this.releasing = false; }
      }),
      cmd('sessions', uiText("command.sessions.description"), async (i, b, cursor) => {
        let r: { items: Data[]; cursor?: string };
        if (cursor.startsWith('page:')) {
          const page = this.sessionPages.get(cursor);
          if (!page || page.scope !== i.scope || page.agent !== b.agent || page.expires < Date.now()) throw new Error(uiText('catalog.invalidPage'));
          r = { items: page.items, cursor: page.nativeCursor };
        } else r = await this.agent(b).list(cursor || undefined);
        const items = r.items.slice(0, 4); let next = r.cursor;
        if (r.items.length > 4) {
          for (const [key, page] of this.sessionPages) if (page.expires < Date.now()) this.sessionPages.delete(key);
          if (this.sessionPages.size >= 256) this.sessionPages.delete(this.sessionPages.keys().next().value!);
          next = `page:${randomBytes(8).toString('hex')}`;
          this.sessionPages.set(next, { scope: i.scope, agent: b.agent, items: r.items.slice(4), nativeCursor: r.cursor, expires: Date.now() + 15 * 60_000 });
        }
        await i.reply(items.map((s: Data, n: number) => `${n + 1}. ${s.title}\n${s.id}`).join('\n\n') || uiText("session.emptyList"), [...items.map((s: Data, n: number) => ({ label: uiText("button.sessionNumber", { v0: n + 1 }), command: `/session ${s.id}` })), ...(next ? [{ label: uiText("button.next"), command: `/sessions ${next}` }] : [])]);
      }, '[cursor]'),
      cmd('session', uiText("command.session.description"), async (i, b, id) => {
        if (!id) return i.reply(b.sessions[b.agent] || uiText("session.notBound"));
        const a = this.agent(b);
        if (this.tasks.has(`${a.id}:${id}`)) throw new Error(uiText("session.targetBusy"));
        await a.attach(id); b.sessions[a.id] = id; b.settings[a.id] = {};
        await i.reply(uiText("session.bound", { v0: id }));
      }, '[id]'),
      cmd('new', uiText("command.new.description"), async (i, b) => {
        if (this.store.value.operations[i.scope]) throw new Error(uiText("session.finishTaskFirst"));
        const a = this.agent(b); b.sessions[a.id] = await a.create(); b.settings[a.id] = {};
        await i.reply(uiText("session.created", { v0: a.id, v1: b.sessions[a.id] }));
      }),
      cmd('fork', uiText('command.fork.description'), async (i, b) => {
        if (this.store.value.operations[i.scope]) throw new Error(uiText('session.finishTaskFirst'));
        const a = this.agent(b); const original = b.sessions[a.id];
        if (!original) throw new Error(uiText('session.notBound'));
        const next = await a.fork(original);
        b.sessions[a.id] = next; b.settings[a.id] = { ...b.settings[a.id] };
        await i.reply(uiText('session.forked', { original, session: next }));
      }),
      cmd('history', uiText("command.history.description"), async (i, b) => i.reply(await this.agent(b).history(await this.session(b)) || uiText("history.empty"))),
      cmd('providers', uiText("command.providers.description"), async (i, b) => {
        const a = this.agent(b); const id = await this.session(b); const providers = await a.providers(id);
        await i.reply(providers.join('\n') || uiText("provider.emptyDirectory"), providers.slice(0, 5).map((p, n) => ({ label: uiText("button.providerNumber", { v0: n + 1 }), command: `/provider ${p}` })));
      }),
      cmd('provider', uiText("command.provider.description"), async (i, b, value) => {
        const a = this.agent(b); const id = await this.session(b);
        if (!value) return i.reply(uiText("provider.current", { v0: await a.provider(id) }));
        if (this.store.value.operations[i.scope]) throw new Error(uiText("provider.waitForIdle"));
        const actual = await a.setProvider(id, value); b.sessions[a.id] = actual.session; b.settings[a.id] = {};
        await i.reply(uiText("provider.selected", { v0: actual.provider }));
      }, '[id]'),
      cmd('models', uiText("command.models.description"), async (i, b, page) => {
        const list = await this.agent(b).catalog(await this.session(b)); const offset = Number(page || 0);
        if (!Number.isInteger(offset) || offset < 0 || offset > list.length) throw new Error(uiText("catalog.invalidPage"));
        const items = list.slice(offset, offset + 4);
        await i.reply(items.map((m, n) => `${n + 1}. ${m.provider ? m.provider + ' / ' : ''}${m.name}\n${m.value}`).join('\n\n') || uiText("model.emptyDirectory"), [
          ...items.map((m, n) => ({ label: uiText("button.modelNumber", { v0: n + 1 }), command: `/model ${m.value}` })),
          ...(offset + 4 < list.length ? [{ label: uiText("button.next"), command: `/models ${offset + 4}` }] : []),
        ]);
      }, '[offset]'),
      ...(['model', 'reasoning'] as const).map(kind => cmd(kind, kind === 'model' ? uiText("command.model.description") : uiText("command.reasoning.description"), async (i, b, value) => {
        const a = this.agent(b); const id = await this.session(b);
        if (this.store.value.operations[i.scope]) throw new Error(uiText("settings.waitForIdle"));
        if (!value) {
          const native = await a.settings(id); const requested = b.settings[a.id] ?? {};
          const current = kind === 'model'
            ? [native.modelProvider, native.model].filter(Boolean).join(' / ') || uiText('settings.notExposed')
            : native.reasoningEffort || uiText('settings.notExposed');
          return i.reply(uiText(kind === 'model' ? 'settings.modelCurrent' : 'settings.reasoningCurrent',
            { v0: current, v1: requested[kind] ?? uiText('settings.notRequested') }));
        }
        if (a.config.type === 'codex') {
          const catalog = await a.models(); const opts = b.settings[a.id] ??= {};
          if (kind === 'model' && !catalog.some((m: Data) => m.id === value || m.model === value)) throw new Error(uiText("model.notListed"));
          if (kind === 'reasoning') {
            const native = await a.settings(id); const currentModel = opts.model || native.model;
            const model = catalog.find((m: Data) => m.id === currentModel || m.model === currentModel);
            if (!model?.supportedReasoningEfforts?.some((r: Data) => r.reasoningEffort === value)) throw new Error(uiText("reasoning.notSupported"));
          }
          opts[kind] = value;
          await i.reply(uiText("settings.nextTurnRequested", { v0: kind, v1: value }));
        } else {
          await a.setOption(id, kind, value);
          await i.reply(uiText(kind === 'model' ? 'settings.modelChanged' : 'settings.reasoningChanged',
            { v0: kind === 'model' ? modelLabel(value) : value }));
        }
      }, '[value]')),
      cmd('reasonings', uiText('command.reasonings.description'), async (i, b) => {
        const exposed = await this.agent(b).reasoningOptions(await this.session(b));
        const list: Data[] = Array.isArray(exposed)
          ? exposed.map((r: Data) => ({ value: r.reasoningEffort ?? r.value, name: r.description ?? r.name }))
          : exposed?.options ?? [];
        await i.reply(list.map((r: Data) => r.name ? `${r.value} — ${r.name}` : String(r.value)).join('\n') || uiText('settings.notExposed'));
      }),
      cmd('permissionlist', uiText('command.permissionlist.description'), async (i, b, page) => {
        const a = this.agent(b);
        const options = await a.permissionOptions(a.config.type === 'codex' ? undefined : await this.session(b));
        const offset = Number(page || 0);
        if (!Number.isInteger(offset) || offset < 0 || offset > options.length) throw new Error(uiText('catalog.invalidPage'));
        const items = options.slice(offset, offset + 4);
        await i.reply(items.map((option, n) => `${n + 1}. ${option.name}\n${option.value}`).join('\n\n') || uiText('settings.notExposed'), [
          ...items.map((option, n) => ({ label: uiText('button.permissionNumber', { v0: n + 1 }), command: `/permission ${option.value}` })),
          ...(offset + 4 < options.length ? [{ label: uiText('button.next'), command: `/permissionlist ${offset + 4}` }] : []),
        ]);
      }, '[offset]'),
      cmd('permission', uiText("command.permission.description"), async (i, b, mode) => {
        const a = this.agent(b); const id = await this.session(b);
        if (!mode) return i.reply(uiText('permission.current', { v0: await a.permissionState(id) }));
        if (this.store.value.operations[i.scope]) throw new Error(uiText('settings.waitForIdle'));
        const result = await a.setPermission(id, mode); b.sessions[a.id] = result.session;
        await i.reply(uiText('permission.changed', { v0: result.currentValue ?? result.sandbox?.type ?? mode }));
      }, '[mode]'),
      cmd('stop', uiText("command.stop.description"), async (i, b) => {
        const op = this.store.value.operations[i.scope]; if (!op) throw new Error(uiText("task.noChatTask"));
        await this.agents.get(op.agent)!.interrupt(op.session); await i.reply(uiText("task.interruptRequested"));
      }),
      cmd('steer', uiText("command.steer.description"), async (i, _b, text) => {
        const op = this.store.value.operations[i.scope]; if (!op || !text) throw new Error(uiText("steer.needsTextAndTask"));
        await this.agents.get(op.agent)!.steer(op.session, text); await i.reply(uiText("steer.accepted"));
      }, '<text>'),
      cmd('compact', uiText("command.compact.description"), async (i, b) => { await this.agent(b).compact(await this.session(b)); await i.reply(uiText("compact.requested")); }),
      cmd('approve', uiText("command.approve.description"), async (i, _b, arg) => this.resolve(i, arg, false), '<token> accept|decline'),
      cmd('answer', uiText("command.answer.description"), async (i, _b, arg) => this.resolve(i, arg, true), '<token> <text>'),
      cmd('ackunknown', uiText("command.ackunknown.description"), async i => {
        const op = this.store.value.operations[i.scope]; if (op?.status !== 'unknown') throw new Error(uiText("task.noUnknownOutcome"));
        delete this.store.value.operations[i.scope]; await i.reply(uiText("task.unknownAcknowledged"));
      }),
      cmd('result', uiText('command.result.description'), async i => {
        const text = this.store.value.responses[i.scope];
        if (!text) throw new Error(uiText('result.nonePending'));
        await i.reply(text);
        delete this.store.value.responses[i.scope]; delete this.store.value.operations[i.scope];
      }),
    ];
  }
  private async resolve(i: Input, arg: string, question: boolean) {
    const [token, ...rest] = arg.split(/\s+/); const p = this.pending.get(token);
    if (!p || p.scope !== i.scope || p.expires < Date.now()) throw new Error(uiText("interaction.expiredOrWrongScope"));
    const a = this.agents.get(p.agent)!; const m = p.request; let result: Data;
    if (question) {
      if (m.method !== 'item/tool/requestUserInput') throw new Error(uiText("interaction.notQuestion"));
      let answers: Data;
      if (m.params.questions.length === 1) answers = { [m.params.questions[0].id]: { answers: [rest.join(' ')] } };
      else { answers = JSON.parse(rest.join(' ')); }
      result = { answers };
    } else {
      const decision = rest.join(' '); if (!['accept', 'decline'].includes(decision)) throw new Error(uiText("interaction.invalidDecision"));
      if (m.method === 'session/request_permission') {
        const option = m.params.options.find((o: Data) => o.kind === (decision === 'accept' ? 'allow_once' : 'reject_once'));
        result = { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
      } else if (m.method === 'item/permissions/requestApproval') result = { permissions: decision === 'accept' ? m.params.permissions : {}, scope: 'turn' };
      else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(m.method)) result = { decision };
      else throw new Error(uiText("interaction.unsupportedApproval"));
    }
    this.pending.delete(token); await a.rpc!.respond(m.id, result); await i.reply(uiText("interaction.answerSubmitted"));
  }
  private async nativeEvent(a: NativeAgent, e: NativeEvent) {
    const key = `${a.id}:${e.session}`; const task = this.tasks.get(key);
    if (e.kind === 'closed') {
      for (const [k, t] of this.tasks) if (k.startsWith(`${a.id}:`)) {
        this.tasks.delete(k); const op = this.store.value.operations[t.scope]; if (op) op.status = 'unknown';
        await t.reply(uiText("runtime.disconnected", { v0: a.id }));
      }
      for (const [token, p] of this.pending) if (p.agent === a.id) this.pending.delete(token);
      await this.store.save(); return;
    }
    if (e.kind === 'resolved') {
      for (const [token, p] of this.pending) if (p.agent === a.id && p.request.id === e.request?.requestId) this.pending.delete(token);
      return;
    }
    if (!task) {
      if (e.kind === 'request') await a.rpc!.reject(e.request!.id, 'No authorized active gateway task');
      return;
    }
    if (e.kind === 'progress' && task.progress < 2 && Date.now() - task.lastProgress > 30_000) {
      task.progress++; task.lastProgress = Date.now(); await task.reply(e.text!);
    }
    if (e.kind === 'request') {
      const m = e.request!;
      if (!['session/request_permission', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'].includes(m.method)) {
        await a.rpc!.reject(m.id, 'Unsupported interaction; never auto-approved'); return;
      }
      const token = randomBytes(8).toString('hex');
      this.pending.set(token, { scope: task.scope, agent: a.id, session: e.session!, request: m, expires: Date.now() + 15 * 60_000 });
      const question = m.method === 'item/tool/requestUserInput';
      await task.reply(uiText("interaction.prompt", { v0: question ? uiText("interaction.question") : uiText("interaction.approval"), v1: a.id, v2: JSON.stringify(m.params, null, 2), v3: question ? uiText("interaction.answerUsage", { v0: token }) : `/approve ${token} accept|decline` }), question ? undefined : [
        { label: uiText("button.approveOnce"), command: `/approve ${token} accept` }, { label: uiText("button.decline"), command: `/approve ${token} decline` },
      ]);
    }
    if (e.kind === 'done' || e.kind === 'failed') {
      this.tasks.delete(key);
      for (const [token, p] of this.pending) if (p.agent === a.id && p.session === e.session) this.pending.delete(token);
      // Persist the final response before delivery. Recovery resends only an explicitly
      // requested result, never the original task. It survives a disconnect or restart.
      const text = e.kind === 'failed' ? uiText("task.failed", { v0: e.text }) : e.text!;
      if (e.timing) this.store.value.timings[task.scope] = { ...e.timing, prepareMs: task.prepareMs, totalMs: Date.now() - task.startedAt };
      this.store.value.responses[task.scope] = text;
      const op = this.store.value.operations[task.scope]; if (op) op.status = 'completed';
      await this.store.save();
      const deliveryStarted = Date.now(); await task.reply(text);
      const timing = this.store.value.timings[task.scope];
      if (timing) { timing.deliveryMs = Date.now() - deliveryStarted; timing.totalMs = Date.now() - task.startedAt; }
      delete this.store.value.responses[task.scope]; delete this.store.value.operations[task.scope]; await this.store.save();
    }
  }
  async close() { await Promise.allSettled([...this.agents.values()].map(a => a.stop())); await this.store.save(); }
}

