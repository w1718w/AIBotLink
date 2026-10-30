import { configureMessages, t as uiText } from './messages.js';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';

export interface AgentConfig {
  type: 'codex' | 'dsh'; command?: string; args?: string[]; cwd: string;
  dshBridge?: string;
  env?: Record<string, string>; home?: string;
  model?: string;
}
export interface Config {
  qq: { appid: string; secret?: string; secretSource?: { file: string; ref: string }; allowedUsers: string[]; allowedGroups: string[] };
  agents: Record<string, AgentConfig>;
  messages?: Record<string, string>;
}
export const dataHome = path.resolve(process.env.BOTLINK_HOME || (process.platform === 'win32'
  ? path.join(homedir(), 'AppData', 'Local', 'AIBotLink')
  : path.join(homedir(), '.local', 'state', 'aibotlink')));
export const configPath = path.join(dataHome, 'config.json');

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export function outsideRepository(location: string, repository = repositoryRoot) {
  const relative = path.relative(repository, path.resolve(location));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error(uiText("config.dataInsideRepository"));
  }
}
export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
export async function loadConfig(): Promise<Config> {
  outsideRepository(dataHome);
  const c = JSON.parse(await readFile(configPath, 'utf8')) as Config;
  configureMessages(c.messages);
  if (!c.qq?.appid || !Array.isArray(c.qq.allowedUsers) || !Array.isArray(c.qq.allowedGroups)) throw new Error(uiText("config.qqFieldsMissing"));
  if (c.qq.allowedUsers.length === 0) throw new Error(uiText("config.allowlistEmpty"));
  for (const [id, agent] of Object.entries(c.agents)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || !['codex', 'dsh'].includes(agent.type) || !path.isAbsolute(agent.cwd)) throw new Error(uiText("config.invalidAgent", { v0: id }));
    if (agent.dshBridge) {
      if (agent.type !== 'dsh' || !path.isAbsolute(agent.dshBridge)) throw new Error(uiText('config.invalidLaunch', { v0: id }));
      outsideRepository(agent.dshBridge);
    } else if (!agent.command || !Array.isArray(agent.args) || agent.args.some(x => typeof x !== 'string')) throw new Error(uiText("config.invalidLaunch", { v0: id }));
  }
  return c;
}
export async function qqSecret(c: Config) {
  if (c.qq.secret) return c.qq.secret;
  if (!c.qq.secretSource) throw new Error(uiText("config.secretMissing"));
  const doc = parse(await readFile(c.qq.secretSource.file, 'utf8'));
  const secret = doc.refs[c.qq.secretSource.ref];
  if (typeof secret !== 'string' || !secret) throw new Error(uiText("config.secretReferenceInvalid"));
  return secret;
}

export async function importDsh(dshHome: string, cwd: string) {
  outsideRepository(dataHome);
  try { await readFile(configPath); throw new Error(uiText("config.refuseOverwrite")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const document = JSON.parse(await readFile(path.join(dshHome, 'integrations', 'dsh-qq', 'config.json'), 'utf8'));
  if (document.bots.length !== 1) throw new Error(uiText("config.importNeedsSingleBot"));
  const bot = document.bots[0];
  const program = path.join(homedir(), 'AppData', 'Local', 'Programs');
  const dshInstall = path.join(program, 'DeepSeek Harness');
  const c: Config = {
    qq: { appid: bot.appId, secretSource: { file: path.join(dshHome, '.credentials.yaml'), ref: bot.secretRef }, allowedUsers: [bot.ownerUserOpenid], allowedGroups: [] },
    agents: {
      codex: { type: 'codex', command: path.join(program, 'OpenAI', 'Codex', 'bin', 'codex.exe'), args: ['app-server'], cwd, home: path.join(homedir(), '.codex') },
      dsh: { type: 'dsh', command: path.join(dshInstall, 'DeepSeek Harness.exe'), args: ['--expose-internals', path.join(dshInstall, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'), '--profile', 'acp'], cwd, home: dshHome, env: { ELECTRON_RUN_AS_NODE: '1' } },
    },
  };
  await qqSecret(c); // Validate the reference without copying or logging its value.
  await atomicJson(configPath, c);
}

