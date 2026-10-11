import { readFile, rename, writeFile } from 'node:fs/promises';

/** The last time the service was alive, saved so a pause or stop is seen after the next start. Holds one timestamp. */
export async function readHeartbeat(path: string): Promise<Date | undefined> {
  try {
    const parsed = new Date((await readFile(path, 'utf8')).trim());
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  } catch { return undefined; }
}

export async function writeHeartbeat(path: string, at: Date): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${at.toISOString()}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
