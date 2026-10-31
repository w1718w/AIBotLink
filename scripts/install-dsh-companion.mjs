// Production installer: registers this local bundle through DSH's plugin CLI,
// then updates the documented editable profile composition and gateway config.
// All machine-specific paths and backups remain outside the source repository.
import { spawn } from 'node:child_process';
import { readFile, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, configPath, dataHome, repositoryRoot, atomicJson, outsideRepository } from '../dist/config.js';
import { t } from '../dist/messages.js';

const profile = process.argv[2] ?? 'desktop';
if (!/^[a-z][a-z0-9_-]*$/.test(profile)) throw new Error(t('installDsh.invalidProfile'));
const config = await loadConfig();
const root = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const profileFile = path.join(root, 'profiles', profile, 'package.json');
outsideRepository(profileFile);
// The DSH plugin is a separate repository. Default to the sibling checkout used by
// the documented install layout; AILINKBRIDGE_COMPANION overrides it without code edits.
const source = path.resolve(process.env.AILINKBRIDGE_COMPANION ?? path.join(repositoryRoot, '..', 'dsh-companion'));
const executable = path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
const cli = path.join(path.dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
await access(executable); await access(profileFile); await access(path.join(source, 'package.json'));
const stamp = Date.now();
await copyFile(profileFile, `${profileFile}.before-aibotlink-${stamp}.bak`);
const child = spawn(executable, ['--expose-internals', cli, 'plugin', '--profile', profile, 'add', '--save-exact', source], {
  cwd: source, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit',
});
await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(t('installDsh.nativeFailed', { code })))); });
const manifest = JSON.parse(await readFile(profileFile, 'utf8'));
if (!manifest.dependencies?.['aibotlink-dsh-companion']) throw new Error(t('installDsh.registrationMissing'));
manifest.dsh ??= {}; manifest.dsh.profile ??= {}; manifest.dsh.profile.bundles ??= [];
if (!Array.isArray(manifest.dsh.profile.bundles)) throw new Error(t('installDsh.invalidProfile'));
if (!manifest.dsh.profile.bundles.includes('aibotlink-dsh-companion')) {
  manifest.dsh.profile.bundles.push('aibotlink-dsh-companion');
  await atomicJson(profileFile, manifest);
}
await copyFile(configPath, path.join(dataHome, `config.before-dsh-companion-${stamp}.json`));
config.agents.dsh = { type: 'dsh', cwd: config.agents.dsh?.cwd ?? repositoryRoot, dshBridge: path.join(dataHome, 'dsh-bridge.json') };
await atomicJson(configPath, config);
console.log(t('installDsh.completed', { profile }));
