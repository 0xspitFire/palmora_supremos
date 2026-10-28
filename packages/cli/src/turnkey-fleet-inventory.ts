import type { TurnkeyWalletReference } from '@mint-bot/engine';

/**
 * Read-only view of the Turnkey private keys that could form the production fleet. MintBot signs with Turnkey PRIVATE KEYS (the
 * provider policy pins `private_key.id`), not with HD "wallets" that hold accounts. This lists only public facts (key id, name,
 * address), checks each key can be used, and drafts the public wallet list in a fixed order. It never exports or signs anything.
 */
export interface FleetKey { privateKeyId: string; name: string; address: string | undefined; usable: boolean; problems: string[] }
export interface FleetInventory {
  keys: FleetKey[];
  usable: number;
  /** The draft key list: usable keys only, ordered by key name then id, indexes 0..n-1. Position in this list is the wallet's list position. */
  draftWallets: TurnkeyWalletReference[];
  problems: string[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function describeKey(raw: unknown): FleetKey | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const key = raw as { privateKeyId?: unknown; privateKeyName?: unknown; curve?: unknown; exported?: unknown; addresses?: unknown };
  if (typeof key.privateKeyId !== 'string' || key.privateKeyId.length === 0) return undefined;
  const addresses = Array.isArray(key.addresses) ? (key.addresses as Array<{ format?: unknown; address?: unknown }>).filter((entry) => entry?.format === 'ADDRESS_FORMAT_ETHEREUM' && typeof entry.address === 'string') : [];
  const address = addresses.length === 1 ? (addresses[0]!.address as string).toLowerCase() : undefined;
  const problems: string[] = [];
  if (key.curve !== 'CURVE_SECP256K1') problems.push('not a secp256k1 key');
  if (key.exported !== false) problems.push('has been exported, or its export state is unknown');
  if (addresses.length !== 1) problems.push(addresses.length === 0 ? 'has no Ethereum address' : 'has more than one Ethereum address');
  else if (!ADDRESS.test(address!)) problems.push('has an invalid Ethereum address');
  return { privateKeyId: key.privateKeyId, name: typeof key.privateKeyName === 'string' ? key.privateKeyName : '', address, usable: problems.length === 0, problems };
}

export function inventoryFleet(input: { privateKeys: readonly unknown[]; hdWalletCount?: number; expect?: number }): FleetInventory {
  const keys = input.privateKeys.map(describeKey).filter((key): key is FleetKey => key !== undefined);
  const seen = new Map<string, number>();
  for (const key of keys) if (key.address) seen.set(key.address, (seen.get(key.address) ?? 0) + 1);
  for (const key of keys) if (key.address && (seen.get(key.address) ?? 0) > 1) { key.problems.push('shares its address with another key'); key.usable = false; }
  const ordered = keys.filter((key) => key.usable).sort((left, right) => left.name.localeCompare(right.name) || left.privateKeyId.localeCompare(right.privateKeyId));
  const draftWallets = ordered.map((key, index) => ({ index, address: key.address as `0x${string}`, signWith: key.privateKeyId }));

  const problems: string[] = [];
  if (input.privateKeys.length > keys.length) problems.push(`${input.privateKeys.length - keys.length} provider entries could not be read and were ignored.`);
  if (draftWallets.length === 0 && (input.hdWalletCount ?? 0) > 0) problems.push(`No usable private keys were found, but ${input.hdWalletCount} HD wallet(s) exist. MintBot cannot sign with HD wallet accounts; create the fleet as individual Private Keys (secp256k1, Ethereum address) instead.`);
  if (input.expect !== undefined && draftWallets.length !== input.expect) problems.push(`Expected ${input.expect} usable private keys but found ${draftWallets.length}.`);
  for (const key of keys) if (!key.usable) problems.push(`Key "${key.name || key.privateKeyId}" ${key.problems.join(' and ')}.`);
  return { keys, usable: draftWallets.length, draftWallets, problems };
}

export function renderFleetInventory(inventory: FleetInventory): string {
  const lines = inventory.draftWallets.map((wallet) => `  ${wallet.index}\t${wallet.address}\t${wallet.signWith}`);
  return [`Usable private keys: ${inventory.usable}`, 'Position\tAddress\tKey id', ...lines, ...inventory.problems.map((problem) => `  - ${problem}`)].join('\n');
}
