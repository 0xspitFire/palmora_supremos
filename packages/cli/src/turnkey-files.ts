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
 * Reads a regular protected file. Root-owned/group-readable files can be allowed
 * for the production secret layout; otherwise owner-only permissions are required.
 * Optional maxBytes bounds the descriptor read before parsing (at most 1 MiB).
 * Every failure uses the caller's fixed code, without filenames or contents.
 */
export async function readProtectedText(path: string, errorCode: string, allowRootGroupRead: boolean, maxBytes?: number): Promise<string> {
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
    if (!file.isFile() || !secure || maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576 || file.size > maxBytes)) throw new Error(errorCode);
    if (maxBytes !== undefined) {
      const buffer = Buffer.alloc(maxBytes + 1);
      let used = 0;
      while (used < buffer.length) {
        const chunk = await handle.read(buffer, used, buffer.length - used, null);
        if (chunk.bytesRead === 0) break;
        used += chunk.bytesRead;
      }
      if (used > maxBytes) throw new Error(errorCode);
      return buffer.subarray(0, used).toString('utf8');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}
