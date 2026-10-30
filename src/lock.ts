import { open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { dataHome } from './config.js';
import { t } from './messages.js';

const file = path.join(dataHome, 'gateway.lock');
// Local-only ownership lock. Never terminate a process discovered from this file.
export async function acquireLock() {
  const nonce = randomUUID();
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(t('runtime.lockExists')); throw e; }
  await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.close();
  return async () => {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value.nonce === nonce) await unlink(file);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  };
}
export async function unlockStoppedProcess() {
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error(t('runtime.lockInvalid'));
  try { process.kill(value.pid, 0); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(file); return; }
    throw e;
  }
  throw new Error(t('runtime.lockOwnerAlive'));
}
