import { isAbsolute, relative, resolve } from 'node:path';

function isWithin(root: string, candidate: string): boolean {
  const outside = relative(root, candidate);
  return !isAbsolute(outside) && outside !== '..' && !outside.startsWith('..\\') && !outside.startsWith('../');
}

export function resolveWalletPath(projectRoot: string, requestedPath = './Rets/wallets', additionalApprovedRoots: readonly string[] = []): string {
  const roots = [resolve(projectRoot, 'Rets', 'wallets'), ...additionalApprovedRoots.map((root) => resolve(root))];
  const candidate = resolve(projectRoot, requestedPath);
  if (!roots.some((root) => isWithin(root, candidate))) throw new Error('WALLET_PATH_OUTSIDE_APPROVED_ROOT');
  return candidate;
}
