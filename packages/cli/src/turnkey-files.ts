import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isSecureTurnkeyFileAccess } from '@mint-bot/engine';

/** Refuses a path with a symbolic link anywhere above it, so a link can never redirect a secret read or write. */
export async function assertNoSymlinkParents(path: string, errorCode: string): Promise<void> {
  let current = dirname(resolve(path));
  while (true) {
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (entry?.isSymbolicLink()) throw new Error(errorCode);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/**
 * Reads a secret-root file only when it is a regular file the runtime may read and nobody else can write. `allowRootGroupRead`
 * lets a root-owned, group-readable file be read by the service account (the production secret layout); otherwise the file must
 * be owner-only. The error is always the one code given, so a failure never reveals why.
 */
export async function readProtectedText(path: string, errorCode: string, allowRootGroupRead: boolean): Promise<string> {
  let handle;
  try {
    await assertNoSymlinkParents(path, errorCode);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    const runtimeUid = typeof process.geteuid === 'function' ? process.geteuid() : process.getuid?.();
    const runtimeGroups = typeof process.getgroups === 'function' ? process.getgroups() : [];
    const secure = allowRootGroupRead && runtimeUid !== undefined
      ? isSecureTurnkeyFileAccess(file, runtimeUid, runtimeGroups)
      : (file.mode & 0o077) === 0;
    if (!file.isFile() || !secure) throw new Error(errorCode);
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}
