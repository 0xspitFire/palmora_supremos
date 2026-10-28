/**
 * D-078 (A): a supported way to change the wallet set when a signed bundle is already installed. Without `--fleet-change` the old
 * rule stands (an installed bundle is the only wallet source and `--wallet-artifact` is refused). With it, the draft only feeds an
 * UNSIGNED proposal: nothing takes effect until the owner creates the exact provider policy and signs the proposal offline.
 */
export type WalletSource = 'bundle' | 'artifact' | 'fleet-change';

export function chooseWalletSource(input: { hasBundle: boolean; walletArtifact?: string | undefined; fleetChange?: string | undefined }): WalletSource {
  if (input.fleetChange !== undefined && input.fleetChange.trim() === '') throw new Error('TURNKEY_FLEET_CHANGE_PATH_REQUIRED');
  if (input.fleetChange && input.walletArtifact) throw new Error('TURNKEY_FLEET_CHANGE_CONFLICT');
  if (input.fleetChange && !input.hasBundle) throw new Error('TURNKEY_FLEET_CHANGE_REQUIRES_BUNDLE');
  if (input.hasBundle && input.walletArtifact) throw new Error('TURNKEY_POLICY_BUNDLE_OVERRIDE_BLOCKED');
  if (input.fleetChange) return 'fleet-change';
  return input.hasBundle ? 'bundle' : 'artifact';
}

export interface WalletRef { index: number; address: string; signWith: string }
export interface WalletChange {
  previousCount: number;
  newCount: number;
  added: Array<{ address: string; signWith: string }>;
  removed: Array<{ address: string; signWith: string }>;
  unchanged: number;
  /** True when a wallet kept its address and key id but moved to another list position. */
  reordered: boolean;
}

/** Compares two wallet lists by key id and address, so the owner sees exactly what a signature would add and remove. */
export function diffWallets(previous: readonly WalletRef[], next: readonly WalletRef[]): WalletChange {
  const id = (wallet: WalletRef) => `${wallet.signWith}|${wallet.address.toLowerCase()}`;
  const before = new Map(previous.map((wallet) => [id(wallet), wallet]));
  const after = new Map(next.map((wallet) => [id(wallet), wallet]));
  const added = next.filter((wallet) => !before.has(id(wallet))).map(({ address, signWith }) => ({ address: address.toLowerCase(), signWith }));
  const removed = previous.filter((wallet) => !after.has(id(wallet))).map(({ address, signWith }) => ({ address: address.toLowerCase(), signWith }));
  const kept = next.filter((wallet) => before.has(id(wallet)));
  return {
    previousCount: previous.length,
    newCount: next.length,
    added,
    removed,
    unchanged: kept.length,
    reordered: kept.some((wallet) => before.get(id(wallet))!.index !== wallet.index),
  };
}

export function assertFleetChanged(change: WalletChange): void {
  if (change.added.length === 0 && change.removed.length === 0 && !change.reordered) throw new Error('TURNKEY_FLEET_CHANGE_NOOP');
}
