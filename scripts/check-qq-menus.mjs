// TEST_ONLY: read back live QQ menu metadata after the gateway connects.
// REST authentication only: no WebSocket receiver, no chat message is sent.
// Tokens and identifiers are never printed or persisted by this probe.
import assert from 'node:assert/strict';
import { loadConfig, qqSecret } from '../dist/config.js';
import { Gateway } from '../dist/gateway.js';
import { StateStore } from '../dist/state.js';
import { commandPanelItems, canonicalPanelItems } from '../dist/qq.js';

const config = await loadConfig();
const auth = await fetch('https://bots.qq.com/app/getAppAccessToken', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId: config.qq.appid, clientSecret: await qqSecret(config) }), signal: AbortSignal.timeout(15_000) });
assert.ok(auth.ok, 'QQ auth unavailable');
const { access_token: token } = await auth.json(); assert.equal(typeof token, 'string');
const get = async endpoint => {
  const response = await fetch(`https://api.bot.qq.com${endpoint}`, { headers: { Authorization: `QQBot ${token}`, 'X-Union-Appid': config.qq.appid }, signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `QQ menu read failed: HTTP ${response.status}`); return response.json();
};
// Registry construction alone does not load or write the running gateway state.
const gateway = new Gateway(config, new StateStore());
const panels = await get('/v2/panels?scope=c2c&limit=20');
const owned = panels.records.filter(p => p.panel.remark === 'AIBotLink commands v1');
assert.equal(owned.length, 1); assert.deepEqual(canonicalPanelItems(owned[0].panel.items), canonicalPanelItems(commandPanelItems(gateway.commands)));
const { menu } = await get('/v2/menu');
const own = menu.items.find(item => item.name === 'AIBotLink');
assert.deepEqual(own.sub_menu_items.map(item => item.send_message), ['/m', '/status', '/new', '/fork']);
console.log(`QQ menu readback PASS: ${owned[0].panel.items.length} slash shortcuts with matching descriptions; menu/new/fork entries match registry`);
