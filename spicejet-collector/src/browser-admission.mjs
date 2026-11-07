import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

// Independent collector installations share admission by OS user, not by
// repo location. Atomic directory creation prevents simultaneous acquisition.
export async function tryBrowserLease({ root = path.join(os.tmpdir(), `airfare-browser-slots-${process.getuid?.() ?? os.userInfo().username}`), slots = os.totalmem() < 8 * 1024 ** 3 ? 1 : 3 } = {}) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (let slot = 0; slot < slots; slot++) {
    const directory = path.join(root, String(slot));
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Serialize stale-owner reclamation; recheck inside this lock so a
      // second reclaimer cannot delete a newly acquired live lease.
      const reclaim = `${directory}.reclaim`;
      try { await fs.mkdir(reclaim); } catch { continue; }
      try {
        let owner;
        try { owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')); }
        catch {
          const stat = await fs.stat(directory).catch(() => null);
          if (stat && Date.now() - stat.mtimeMs > 10000)
            await fs.rm(directory, { recursive: true, force: true });
          continue;
        }
        if (!alive(owner.pid) && !alive(owner.workerPid))
          await fs.rm(directory, { recursive: true, force: true });
      } finally { await fs.rm(reclaim, { recursive: true, force: true }); }
      continue;
    }
    const owner = { token: crypto.randomUUID(), pid: process.pid, workerPid: null };
    const filename = path.join(directory, 'owner.json');
    await fs.writeFile(filename, JSON.stringify(owner), { mode: 0o600 });
    return {
      async attach(pid) {
        owner.workerPid = pid;
        const temporary = `${filename}.${owner.token}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(owner), { mode: 0o600 });
        await fs.rename(temporary, filename);
      },
      async release() {
        const current = JSON.parse(await fs.readFile(filename, 'utf8').catch(() => '{}'));
        if (current.token === owner.token) await fs.rm(directory, { recursive: true, force: true });
      }
    };
  }
  return null;
}
