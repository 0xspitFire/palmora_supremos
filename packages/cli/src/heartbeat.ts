import { readFile, rename, writeFile } from 'node:fs/promises';

/** The last time the service was alive, saved so a pause or stop is seen after the next start. Holds one timestamp. */
export async function readHeartbeat(path: string): Promise<Date | undefined> {
  try {
    const parsed = new Date((await readFile(path, 'utf8')).trim());
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  } catch { return undefined; }
}

let counter = 0;

export async function writeHeartbeat(path: string, at: Date): Promise<void> {
  // A temp name no other call shares, so two writes that overlap (a stalled event loop releases queued timers together) cannot fail on each other's rename.
  const temporary = `${path}.${process.pid}.${++counter}.tmp`;
  await writeFile(temporary, `${at.toISOString()}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
