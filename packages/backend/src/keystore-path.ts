import { isAbsolute, relative, resolve } from 'node:path';
export function resolveWalletPath(projectRoot: string, requestedPath = './Rets/wallets'): string {
  const root = resolve(projectRoot, 'Rets', 'wallets'); const candidate = resolve(projectRoot, requestedPath); const outside = relative(root, candidate);
  if (isAbsolute(outside) || outside === '..' || outside.startsWith('..\\') || outside.startsWith('../')) throw new Error('WALLET_PATH_OUTSIDE_APPROVED_ROOT');
  return candidate;
}
