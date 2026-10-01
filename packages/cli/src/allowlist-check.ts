import { encodeAbiParameters, getAddress, isAddress, keccak256, concatHex, type Hex } from 'viem';

/**
 * Read-only allowlist eligibility (D-028, P2 late). It checks the owner's OWN wallets against an allowlist
 * or proof file the project has PUBLISHED, and against the Merkle root the SeaDrop contract holds on chain.
 * It never builds, signs or sends a transaction, and it never guesses: when the evidence is incomplete the
 * answer is `unknown`, which is different from `not_listed` (D-008: no forged or borrowed proofs).
 */
export interface MintParams {
  mintPrice: bigint;
  maxTotalMintableByWallet: bigint;
  startTime: bigint;
  endTime: bigint;
  dropStageIndex: bigint;
  maxTokenSupplyForStage: bigint;
  feeBps: bigint;
  restrictFeeRecipients: boolean;
}

export interface PublishedEntry { address: string; mintParams: MintParams; proof?: readonly Hex[] }
export type AllowlistVerdict = 'eligible' | 'not_listed' | 'unknown';
export interface WalletAllowlistResult {
  wallet: string;
  verdict: AllowlistVerdict;
  reason: string;
  /** Present only when eligible: what the project's list says this wallet may mint. */
  entry?: { priceWei: string; maxPerWallet: string; opensAt: string; closesAt: string };
}
export interface AllowlistReport {
  contract: string;
  onChainRoot: Hex | null;
  listKind: 'full-list' | 'proofs' | 'none';
  summary: string;
  wallets: WalletAllowlistResult[];
}

const ZERO_ROOT = `0x${'0'.repeat(64)}` as Hex;
const PARAM_FIELDS = ['mintPrice', 'maxTotalMintableByWallet', 'startTime', 'endTime', 'dropStageIndex', 'maxTokenSupplyForStage', 'feeBps'] as const;

/** The leaf SeaDrop v1 checks: keccak256(abi.encode(minter, mintParams)). */
export function allowlistLeaf(address: string, params: MintParams): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'tuple', components: [...PARAM_FIELDS.map((name) => ({ name, type: 'uint256' })), { name: 'restrictFeeRecipients', type: 'bool' }] }],
    [getAddress(address), params],
  ));
}

const hashPair = (left: Hex, right: Hex): Hex => (BigInt(left) <= BigInt(right) ? keccak256(concatHex([left, right])) : keccak256(concatHex([right, left])));

/** OpenZeppelin-style verification (sorted pairs), as the SeaDrop contract does. */
export function verifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  return proof.reduce<Hex>((hash, sibling) => hashPair(hash, sibling), leaf).toLowerCase() === root.toLowerCase();
}

/**
 * Root and proofs for a full published list, built the common way: leaves sorted, then paired level by level
 * (an unpaired node moves up unchanged). Another tool may order leaves differently; the caller treats a root
 * that does not match the chain as "unknown", never as "not listed".
 */
export function buildTree(leaves: readonly Hex[]): { root: Hex; proofFor(leaf: Hex): Hex[] | null } {
  if (leaves.length === 0) return { root: ZERO_ROOT, proofFor: () => null };
  const sorted = [...leaves].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const levels: Hex[][] = [sorted];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!;
    const next: Hex[] = [];
    for (let index = 0; index < level.length; index += 2) next.push(index + 1 < level.length ? hashPair(level[index]!, level[index + 1]!) : level[index]!);
    levels.push(next);
  }
  return {
    root: levels.at(-1)![0]!,
    proofFor(leaf) {
      let index = sorted.findIndex((item) => item.toLowerCase() === leaf.toLowerCase());
      if (index < 0) return null;
      const proof: Hex[] = [];
      for (const level of levels.slice(0, -1)) {
        const sibling = index % 2 === 0 ? index + 1 : index - 1;
        if (sibling < level.length) proof.push(level[sibling]!);
        index = Math.floor(index / 2);
      }
      return proof;
    },
  };
}

const iso = (seconds: bigint): string => (seconds === 0n ? 'no end' : new Date(Number(seconds) * 1000).toISOString());

/** Parses a published list file. Throws a plain error for anything malformed; never reads outside the given text. */
export function parsePublishedList(text: string): { kind: 'full-list' | 'proofs'; entries: PublishedEntry[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('ALLOWLIST_FILE_NOT_JSON'); }
  const rows = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : null);
  if (!rows || rows.length === 0 || rows.length > 100_000) throw new Error('ALLOWLIST_FILE_SHAPE_INVALID: expected a list of entries (1 to 100000)');
  const entries = rows.map((row, index): PublishedEntry => {
    const item = row as { address?: unknown; mintParams?: Record<string, unknown>; proof?: unknown };
    if (typeof item.address !== 'string' || !isAddress(item.address) || !item.mintParams || typeof item.mintParams !== 'object') throw new Error(`ALLOWLIST_ENTRY_INVALID: entry ${index + 1}`);
    const params = item.mintParams;
    const num = (name: string): bigint => {
      const value = params[name];
      if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{1,78}$/.test(String(value))) throw new Error(`ALLOWLIST_ENTRY_INVALID: entry ${index + 1} ${name}`);
      return BigInt(String(value));
    };
    const mintParams: MintParams = { mintPrice: num('mintPrice'), maxTotalMintableByWallet: num('maxTotalMintableByWallet'), startTime: num('startTime'), endTime: num('endTime'), dropStageIndex: num('dropStageIndex'), maxTokenSupplyForStage: num('maxTokenSupplyForStage'), feeBps: num('feeBps'), restrictFeeRecipients: params.restrictFeeRecipients === true };
    let proof: Hex[] | undefined;
    if (item.proof !== undefined) {
      if (!Array.isArray(item.proof) || item.proof.length > 64 || item.proof.some((node) => typeof node !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(node))) throw new Error(`ALLOWLIST_ENTRY_INVALID: entry ${index + 1} proof`);
      proof = item.proof as Hex[];
    }
    return { address: getAddress(item.address), mintParams, ...(proof ? { proof } : {}) };
  });
  return { kind: entries.every((entry) => entry.proof !== undefined) ? 'proofs' : 'full-list', entries };
}

/** Checks each of the owner's wallets. `onChainRoot` is null when the chain could not be read. */
export function checkAllowlist(args: { contract: string; wallets: readonly string[]; onChainRoot: Hex | null; list: { kind: 'full-list' | 'proofs'; entries: readonly PublishedEntry[] } | null }): AllowlistReport {
  const { contract, wallets, onChainRoot, list } = args;
  const unknownAll = (reason: string): AllowlistReport => ({ contract, onChainRoot, listKind: list?.kind ?? 'none', summary: reason, wallets: wallets.map((wallet) => ({ wallet, verdict: 'unknown', reason })) });
  if (onChainRoot === null) return unknownAll('The contract could not be read, so nothing can be confirmed. Try again shortly.');
  if (onChainRoot === ZERO_ROOT) return unknownAll('This contract has no allowlist set on chain (root is empty), so there is nothing to be eligible for yet.');
  if (!list) return unknownAll('No published allowlist or proof file was given. Download the one the project published and pass it in.');
  const byWallet = new Map<string, PublishedEntry[]>();
  for (const entry of list.entries) byWallet.set(entry.address.toLowerCase(), [...(byWallet.get(entry.address.toLowerCase()) ?? []), entry]);
  // A full list is only trusted as complete when it rebuilds into the exact root held on chain.
  let completeList = false;
  let tree: ReturnType<typeof buildTree> | null = null;
  if (list.kind === 'full-list') {
    tree = buildTree(list.entries.map((entry) => allowlistLeaf(entry.address, entry.mintParams)));
    completeList = tree.root.toLowerCase() === onChainRoot.toLowerCase();
  }
  const results = wallets.map((wallet): WalletAllowlistResult => {
    const entries = isAddress(wallet) ? byWallet.get(wallet.toLowerCase()) ?? [] : [];
    if (!isAddress(wallet)) return { wallet, verdict: 'unknown', reason: 'That is not a valid wallet address.' };
    for (const entry of entries) {
      const leaf = allowlistLeaf(entry.address, entry.mintParams);
      const proof = entry.proof ?? tree?.proofFor(leaf) ?? null;
      if (proof && verifyProof(proof, onChainRoot, leaf)) {
        return { wallet, verdict: 'eligible', reason: 'The project’s published list includes this wallet and its proof matches the contract’s allowlist.', entry: { priceWei: entry.mintParams.mintPrice.toString(), maxPerWallet: entry.mintParams.maxTotalMintableByWallet.toString(), opensAt: iso(entry.mintParams.startTime), closesAt: iso(entry.mintParams.endTime) } };
      }
    }
    if (entries.length > 0) return { wallet, verdict: 'unknown', reason: 'The published list includes this wallet, but its proof does not match the contract’s current allowlist. The list may be out of date.' };
    if (completeList) return { wallet, verdict: 'not_listed', reason: 'The published list matches the contract’s allowlist and does not include this wallet.' };
    return { wallet, verdict: 'unknown', reason: list.kind === 'proofs' ? 'The project published proofs only for some wallets, and none is for this one. That does not prove it is excluded.' : 'The published list does not rebuild into the contract’s allowlist, so it cannot show this wallet is excluded.' };
  });
  const count = (verdict: AllowlistVerdict): number => results.filter((item) => item.verdict === verdict).length;
  return { contract, onChainRoot, listKind: list.kind, summary: `${count('eligible')} of ${results.length} wallet(s) eligible, ${count('not_listed')} not listed, ${count('unknown')} unknown.`, wallets: results };
}
