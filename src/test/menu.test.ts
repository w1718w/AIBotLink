import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Gateway, type Action } from '../gateway.js';
import { QqTransport, commandPanelItems, canonicalPanelItems } from '../qq.js';
import { Bot } from 'qq-official-bot';
import { StateStore } from '../state.js';
import type { Config } from '../config.js';

test('all commands are reachable in both agent menus and callbacks execute the same commands as slash input', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aibotlink-menu-'));
  // TEST_FIXTURE: dummy identities and a mocked QQ sender; no platform or native
  // backend is contacted. Missing executables detect accidental model dispatch.
  const cfg: Config = { qq: { appid: 'test', secret: 'unused', allowedUsers: ['owner'], allowedGroups: [] }, agents: {
    codex: { type: 'codex', command: 'missing-codex.exe', args: [], cwd: temp },
    dsh: { type: 'dsh', command: 'missing-dsh.exe', args: [], cwd: temp },
  } };
  const gateway = new Gateway(cfg, new StateStore(path.join(temp, 'state.json')));
  const replies: { text: string; actions: Action[] }[] = []; let sequence = 0;
  const receive = (text: string, scope = 'chat') => gateway.receive({ id: `msg:${++sequence}`, scope, user: 'owner', text,
    reply: async (text, actions = []) => { replies.push({ text, actions }); } });
  try {
    for (const agent of ['codex', 'dsh']) {
      await receive(`/agent ${agent}`);
      const reached = new Set<string>(); let page = '/m';
      for (let n = 0; n < 50; n++) {
        await receive(page); const result = replies.at(-1)!;
        // Eight entries plus up to two pagination buttons; two buttons share each row.
        assert.ok(result.actions.filter(a => a.group !== 'nav').length <= 8);
        assert.ok(result.actions.filter(a => a.group === 'nav').length <= 2);
        for (const match of result.text.matchAll(/^\/(\w+) — (.+)$/gm)) {
          reached.add(match[1]); assert.ok(Array.from(match[2]).length <= 10);
          const command = gateway.commands.find(c => c.name === match[1])!;
          const target = command.arguments?.includes('<') ? `/m ${command.name}` : `/${command.name}`;
          assert.ok(result.actions.some(a => a.command === target));
        }
        assert.ok(result.actions.every(a => Array.from(a.label).length <= 3));
        const next = result.actions.find(a => a.label === '下一页');
        if (!next) break; page = next.command;
      }
      assert.deepEqual([...reached].sort(), gateway.commands.map(c => c.name).sort());
      await receive('/m runtime');
      assert.ok(replies.at(-1)!.actions.some(a => a.command === `/runtime start ${agent}`));
      assert.equal(gateway.agents.get(agent)!.rpc, undefined);
    }
    const panel = commandPanelItems(gateway.commands);
    assert.equal(panel.length, 20);
    for (const item of panel) {
      const command = gateway.commands.find(c => `/${c.name}` === item.name)!;
      assert.ok(command); assert.equal(item.desc, command.description);
      assert.ok(Array.from(item.desc).length <= 10);
    }
    assert.ok(panel.some(i => i.name === '/m')); assert.ok(panel.some(i => i.name === '/fork'));
    assert.deepEqual(canonicalPanelItems(panel), canonicalPanelItems(panel.map(item => ({ ...item, name: item.name.slice(1) }))));

    const transport = new QqTransport(cfg, gateway); const sent: any[][] = [];
    transport.bot = { sendPrivateMessage: async (_user: string, content: any[]) => { sent.push(content); } } as any;
    const scope = 'qq:test:dm:owner';
    await (transport as any).reply('owner', undefined, { id: 'test-source' }, scope)('menu', [{ label: '状态', command: '/status' }]);
    const rows = sent[0].filter(s => s.type === 'button');
    assert.equal(rows.length, 1); assert.equal(rows[0].data.buttons.length, 1);
    const token = rows[0].data.buttons[0].action.data; const acks: number[] = [];
    const event = { operator_id: 'owner', notice_type: 'friend', notice_id: 'callback-id', data: { resolved: { button_data: token } }, reply: async (code: number) => { acks.push(code); } };
    await (transport as any).action(event);
    assert.deepEqual(acks, [0]);
    await receive('/status', scope);
    assert.equal(sent.at(-1)![0].data.text, replies.at(-1)!.text);
    const count = sent.length;
    await (transport as any).action(event); assert.deepEqual(acks, [0, 1]); assert.equal(sent.length, count);
    // Grouped actions share a row: eight menu entries use four rows, pagination one more.
    const grouped: Action[] = Array.from({ length: 8 }, (_, n) => ({ label: `项${n + 1}`, command: `/item${n + 1}`, group: `row${Math.floor(n / 2)}` }));
    grouped.push({ label: '上一页', command: '/m 0', group: 'nav' }, { label: '下一页', command: '/m 2', group: 'nav' });
    transport.bot = { sendPrivateMessage: async (_user: string, content: any[]) => { sent.push(content); } } as any;
    const before = sent.length;
    await (transport as any).reply('owner', undefined, { id: 'page' }, scope)('menu', grouped);
    const pageRows = sent[before].filter(s => s.type === 'button');
    assert.equal(pageRows.length, 5);
    assert.deepEqual(pageRows.map((row: any) => row.data.buttons.length), [2, 2, 2, 2, 2]);
    assert.ok([...gateway.agents.values()].every(a => a.rpc === undefined));
  } finally {
    await gateway.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
    await rm(temp, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('QQ receiver readiness syncs menus on initial connection and reconnection', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aibotlink-ready-'));
  // TEST_FIXTURE: replace only the SDK connection entry points. No authentication,
  // WebSocket, platform writes or native backend is started by this test.
  const cfg: Config = { qq: { appid: 'test', secret: 'unused', allowedUsers: ['owner'], allowedGroups: [] }, agents: {} };
  const gateway = new Gateway(cfg, new StateStore(path.join(temp, 'state.json')));
  const transport = new QqTransport(cfg, gateway); let synced = 0;
  const start = Bot.prototype.start; const stop = Bot.prototype.stop;
  Bot.prototype.start = async function () { this.receiver.emit('ready'); return this; };
  Bot.prototype.stop = async function () { this.receiver.emit('close'); };
  transport.syncCommands = async () => { synced++; };
  try {
    await transport.start(); assert.equal(synced, 1); assert.equal(transport.connected, true);
    transport.bot!.receiver.emit('close'); assert.equal(transport.connected, false);
    transport.bot!.receiver.emit('ready'); await (transport as any).menuSync;
    assert.equal(synced, 2); assert.equal(transport.connected, true);
    await transport.stop(); transport.bot!.receiver.emit('ready'); await (transport as any).menuSync;
    assert.equal(synced, 2); assert.equal(transport.connected, false);
  } finally {
    Bot.prototype.start = start; Bot.prototype.stop = stop;
    await gateway.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
    await rm(temp, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});
