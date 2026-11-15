import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('login recovers a dead lock, keeps a live lock, and permits just one owner', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aibotlink-lock-'));
  const file = path.join(dir, 'gateway.lock');
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  const previous = process.env.BOTLINK_HOME;
  process.env.BOTLINK_HOME = dir;
  try {
    const pid = child.pid;
    assert.ok(pid);
    await once(child, 'exit');
    const { acquireLock } = await import('../lock.js');
    const stale = JSON.stringify({ pid, nonce: randomUUID() });
    await writeFile(file, stale);
    await assert.rejects(acquireLock());
    assert.equal(await readFile(file, 'utf8'), stale);
    const results = await Promise.allSettled([acquireLock(true), acquireLock(true)]);
    const owners = results.filter(result => result.status === 'fulfilled');
    assert.equal(owners.length, 1);
    const live = await readFile(file, 'utf8');
    assert.equal(JSON.parse(live).pid, process.pid);
    await assert.rejects(acquireLock(true));
    assert.equal(await readFile(file, 'utf8'), live);
    await owners[0].value();
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.BOTLINK_HOME;
    else process.env.BOTLINK_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
