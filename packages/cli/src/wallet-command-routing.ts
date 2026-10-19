/** Keep the documented `wallet <action>` interface while giving yargs unique command names. */
export function normalizeWalletCommandArgs(args: readonly string[]): string[] {
  if (args[0] !== 'wallet' || !['generate', 'list', 'import', 'import-turnkey'].includes(args[1] ?? '')) return [...args];
  return [`wallet-${args[1]}`, ...args.slice(2)];
}
