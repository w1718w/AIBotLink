import { link, open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { dataHome } from './config.js';
import { t } from './messages.js';

const file = path.join(dataHome, 'gateway.lock');
// Local-only ownership lock. Never terminate a process discovered from this file.
export async function acquireLock(recover = false) {
  const nonce = randomUUID();
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (!recover) throw new Error(t('runtime.lockExists'));
    await unlockStoppedProcess();
    return acquireLock();
  }
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
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(value.nonce)) throw new Error(t('runtime.lockInvalid'));
  try { process.kill(value.pid, 0); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    // Claim this generation so two unlockers cannot delete a newly acquired lock.
    const claim = `${file}.${value.nonce}.recover`;
    await link(file, claim);
    try {
      const current = JSON.parse(await readFile(claim, 'utf8'));
      if (current.nonce !== value.nonce || current.pid !== value.pid) throw new Error(t('runtime.lockExists'));
      await unlink(file);
    } finally { await unlink(claim); }
    return;
  }
  throw new Error(t('runtime.lockOwnerAlive'));
}
