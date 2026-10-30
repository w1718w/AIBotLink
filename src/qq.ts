import { t as uiText } from './messages.js';
import { randomBytes } from 'node:crypto';
import { Bot, ReceiverMode, segment, type Sendable } from 'qq-official-bot';
import { dataHome, qqSecret, type Config } from './config.js';
import { Gateway, type Input, type Action, type Reply } from './gateway.js';
import type { Data } from './rpc.js';

export class QqTransport {
  bot?: Bot;
  connected = false;
  private secret = '';
  private menuSync = Promise.resolve();
  private stopping = false;
  private buttons = new Map<string, { scope: string; command: string; expires: number; target?: string }>();
  constructor(readonly config: Config, readonly gateway: Gateway) {}
  private scope(user: string, group?: string) { return `qq:${this.config.qq.appid}:${group || 'dm'}:${user}`; }
  private target(scope: string) {
    const b = this.gateway.store.value.scopes[scope];
    return JSON.stringify(b ? [b.agent, b.sessions[b.agent] ?? null] : []);
  }
  private logError(error: unknown) {
    // Axios errors carry request headers and bodies; never serialize the error object.
    const e = error as Data;
    const message = String(e.message || 'transport-error').replaceAll(this.secret || '\0', '[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
    console.error(uiText("qq.operationFailed", { v0: e.response?.data?.code ?? e.code ?? '', v1: message }));
  }
  async start() {
    this.stopping = false;
    const secret = await qqSecret(this.config);
    this.secret = secret;
    this.bot = new Bot({ appid: this.config.qq.appid, secret, mode: ReceiverMode.WEBSOCKET,
      intents: ['GROUP_AND_C2C_EVENT', 'INTERACTION'], logLevel: 'off', dataDir: dataHome,
      handleProcessErrors: false,
    });
    // The SDK emits readiness on its receiver, including resumed/reconnected
    // sessions. Serializing syncs keeps panel updates deterministic on reconnect.
    this.bot.receiver.on('ready', () => {
      if (this.stopping) return;
      this.connected = true; console.log(uiText('qq.ready'));
      this.menuSync = this.menuSync.then(async () => {
        if (this.stopping) return;
        try { await this.syncCommands(); }
        catch (error) { this.logError(error); console.error(uiText('qq.panelSyncFailed')); }
      });
    });
    this.bot.receiver.on('close', () => { this.connected = false; });
    this.bot.on('error', e => this.logError(e));
    this.bot.on('message.private.friend', e => this.message(e));
    this.bot.on('message.group.at', e => this.message(e));
    this.bot.on('notice.friend.action', e => { void this.action(e).catch(err => this.logError(err)); });
    this.bot.on('notice.group.action', e => { void this.action(e).catch(err => this.logError(err)); });
    await this.bot.start();
    await this.menuSync;
  }
  private message(e: Data) {
    const group = e.message_type === 'group' ? e.group_id : undefined;
    const scope = this.scope(e.user_id, group);
    const i: Input = { id: `qq:${this.config.qq.appid}:${e.message_id}`, user: e.user_id, group, scope,
      text: e.raw_message.trim(), reply: this.reply(e.user_id, group, { id: e.message_id }, scope) };
    void this.gateway.receive(i).catch(err => this.logError(err));
  }
  private async action(e: Data) {
    const user = e.operator_id; const group = e.notice_type === 'group' ? e.group_id : undefined;
    if (!this.gateway.allowed({ user, group })) { await e.reply(1); return; }
    const scope = this.scope(user, group); const token = e.data.resolved.button_data;
    const b = this.buttons.get(token);
    if (!b || b.scope !== scope || b.expires < Date.now() || (b.target !== undefined && b.target !== this.target(scope))) { await e.reply(1); return; }
    this.buttons.delete(token); // Consume before any asynchronous execution.
    await e.reply(0);
    await this.gateway.receive({ id: `qq-action:${this.config.qq.appid}:${e.notice_id}`, user, group, scope, text: b.command,
      reply: this.reply(user, group, { event_id: e.event_id || e.notice_id }, scope) });
  }
  private reply(user: string, group: string | undefined, source: Data, scope: string): Reply {
    return async (text: string, actions?: Action[]) => {
      const send = (content: Sendable) => group ? this.bot!.sendGroupMessage(group, content, source) : this.bot!.sendPrivateMessage(user, content, source);
      const chunks = splitText(text);
      for (let n = 0; n < chunks.length; n++) {
        const last = n === chunks.length - 1;
        if (last && actions?.length) {
          const now = Date.now();
          for (const [key, b] of this.buttons) if (b.expires < now) this.buttons.delete(key);
          if (this.buttons.size > 1000) this.buttons.clear();
          const buttons = actions.slice(0, 5).map(a => {
            const token = `bl:${randomBytes(12).toString('hex')}`;
            // Approval commands already carry an immutable native-request token.
            // They must remain usable after selecting a different foreground Agent.
            const requestBound = /^\/(approve|answer)\s/.test(a.command);
            this.buttons.set(token, { scope, command: a.command, expires: now + 15 * 60_000, target: requestBound ? undefined : this.target(scope) });
            // Explicit rows prevent the SDK from packing five buttons horizontally.
            return segment.button({ buttons: [{ render_data: { label: a.label, visited_label: a.label }, action: { type: 1, permission: { type: 2 }, data: token } }] });
          });
          try { await send([segment.markdown(chunks[n]), ...buttons]); }
          catch (error) {
            // Only explicit platform rejection permits a second send. A timeout is ambiguous.
            const code = (error as Data).response?.data?.code;
            if (![304036, 304014, 50056].includes(code)) throw error;
            await send([segment.text(chunks[n] + '\n' + actions.map(a => `${a.label}：${a.command}`).join('\n'))]);
          }
        } else await send([segment.text(chunks[n])]);
      }
    };
  }
  async syncCommands() {
    const bot = this.bot!;
    // QQ accepts at most 20 entries per panel. These shortcuts and /m use the
    // same registry; /m and /help expose every command, including the remainder.
    const items = commandPanelItems(this.gateway.commands);
    const marker = 'AIBotLink commands v1';
    const panels = await bot.getCommandPanels({ scope: 'c2c', limit: 20 });
    const matches = panels.records.filter(p => p.panel.remark === marker);
    if (matches.length > 1) throw new Error(uiText("qq.duplicateOwnedPanels"));
    if (matches.length) {
      // QQ strips the leading slash when returning command names. Compare the
      // canonical API representation to avoid rewriting an unchanged panel.
      if (JSON.stringify(canonicalPanelItems(matches[0].panel.items)) !== JSON.stringify(canonicalPanelItems(items))) await bot.updateCommandPanel(matches[0].panel_id, { items, remark: marker });
    }
    else {
      const r = await bot.createCommandPanel({ scope: 'c2c', target_type: 'all', panel: { items, remark: marker } });
      this.gateway.store.value.qqPanels.c2c = r.panel_id;
      await this.gateway.store.save();
    }
    // A whole-menu replacement must preserve every unrelated entry.
    const current = await bot.getCustomMenu(); const menu = current.menu?.items ?? [];
    const own = { name: 'AIBotLink', type: 'menu' as const, sub_menu_items: [
      ...['m', 'status', 'new', 'fork'].map(name => ({ name: this.gateway.commands.find(c => c.name === name)!.shortLabel, type: 'send_message' as const, send_message: `/${name}` })),
    ] };
    const index = menu.findIndex(item => item.name === 'AIBotLink');
    if (index >= 0) menu[index] = own;
    else if (menu.length < 10) menu.push(own);
    else { console.log(uiText("qq.preserveFullMenu")); return; }
    await bot.updateCustomMenu({ items: menu });
  }
  async stop() { this.stopping = true; this.connected = false; await this.bot?.stop(); await this.menuSync; }
}

export function commandPanelItems(commands: readonly { name: string; description: string }[]) {
  const shortcuts = ['m', 'help', 'agents', 'agent', 'status', 'sessions', 'session', 'new', 'fork', 'history', 'providers', 'provider', 'models', 'model', 'reasonings', 'reasoning', 'permissionlist', 'permission', 'stop', 'release'];
  return shortcuts.flatMap(name => {
    const command = commands.find(c => c.name === name);
    return command ? [{ name: `/${name}`, type: 'command' as const, desc: Array.from(command.description).slice(0, 10).join('') }] : [];
  });
}

export function canonicalPanelItems(items: readonly { name: string; type: string; desc?: string }[]) {
  return items.map(item => ({ name: item.type === 'command' ? item.name.replace(/^\/+/, '') : item.name, type: item.type, desc: item.desc ?? '' }));
}

export function splitText(text: string, max = 1500): string[] {
  const chars = Array.from(text || uiText("text.empty")); const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += max) chunks.push(chars.slice(i, i + max).join(''));
  return chunks;
}

