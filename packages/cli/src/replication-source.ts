import { decodeEventLog, decodeFunctionData, toFunctionSelector, type Address, type Hex, type PublicClient } from 'viem';
import { ALLOWLIST_MINT_ABI, SIGNED_MINT_ABI, buildSignedMint, buildAllowlistMint, buildReplicationPlan, getStrategy, SeaDropV1PublicStrategy, SEADROP_V1_ADDRESS, SEADROP_EVENTS_ABI, type DropConfig, type ObservedMintTransaction, type ReplicationPlan, type SupportedChainId, type VerifiedWalletProof, type VerifiedSignedWalletAuthorization } from '@mint-bot/engine';

export interface QualifiedSource {
  observed: ObservedMintTransaction;
  drop: DropConfig;
  plan: ReplicationPlan;
  mintedAt: string;
}

/** A Transfer to a watched wallet is insufficient: require a successful self-paid SeaDrop event and matching transaction. */
export async function readReplicationSource(input: {
  client: PublicClient;
  chainId: SupportedChainId;
  contract: Address;
  hash: Hex;
  watchedWallets: readonly string[];
  targetWallets: readonly Address[];
  now?: Date | (() => Date);
}): Promise<QualifiedSource> {
  const { client, hash, contract, chainId } = input;
  const clock = typeof input.now === 'function' ? input.now : input.now ? () => input.now as Date : () => new Date();
  const [tx, receipt, head, actualChain] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash }), client.getBlockNumber(), client.getChainId()]);
  if (actualChain !== chainId || tx.hash.toLowerCase() !== hash.toLowerCase() || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.status !== 'success' || receipt.from.toLowerCase() !== tx.from.toLowerCase() || receipt.to?.toLowerCase() !== SEADROP_V1_ADDRESS.toLowerCase() || tx.blockNumber === null || tx.blockNumber !== receipt.blockNumber || tx.blockHash !== receipt.blockHash || head < receipt.blockNumber + 2n || tx.to?.toLowerCase() !== SEADROP_V1_ADDRESS.toLowerCase() || !input.watchedWallets.some((wallet) => wallet.toLowerCase() === tx.from.toLowerCase())) throw new Error('WATCHED_MINT_NOT_VERIFIED');
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const age = clock().getTime() - Number(block.timestamp) * 1000;
  if (block.hash !== receipt.blockHash || age < 0 || age > 15 * 60_000) throw new Error('WATCHED_MINT_STALE_OR_REORGED');
  const matches = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== SEADROP_V1_ADDRESS.toLowerCase()) return [];
    try {
      const decoded = decodeEventLog({ abi: SEADROP_EVENTS_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'SeaDropMint') return [];
      return decoded.args.nftContract.toLowerCase() === contract.toLowerCase() && decoded.args.minter.toLowerCase() === tx.from.toLowerCase() && decoded.args.payer.toLowerCase() === tx.from.toLowerCase() && decoded.args.quantityMinted > 0n ? [decoded.args] : [];
    } catch { return []; }
  });
  if (matches.length !== 1) throw new Error('WATCHED_MINT_NOT_VERIFIED');
  const publicMint = tx.input.slice(0, 10).toLowerCase() === '0x161ac21f';
  // A signed drop is not a Merkle allowlist. Never interpret another wallet's
  // server signature as a proof, or silently authorize it under a public policy.
  const allowlistMint = tx.input.slice(0, 10).toLowerCase() === toFunctionSelector(ALLOWLIST_MINT_ABI[0]);
  const signedMint = tx.input.slice(0, 10).toLowerCase() === toFunctionSelector(SIGNED_MINT_ABI[0]);
  if (!publicMint && !allowlistMint && !signedMint) throw new Error('REPLICATION_METHOD_UNSUPPORTED');
  let strategy;
  try { strategy = publicMint ? new SeaDropV1PublicStrategy() : getStrategy(signedMint ? 'seadrop-v1-signed' : 'seadrop-v1-allowlist'); }
  catch { throw new Error(signedMint ? 'SIGNED_MINT_OWN_SIGNATURE_AND_CUSTODY_REQUIRED' : 'ALLOWLIST_OWN_WALLET_PROOF_REQUIRED'); }
  const drop = await strategy.readDrop(client, contract, chainId);
  // Authority acquisition can take time. Recheck source freshness and sample the
  // current clock for proofs obtained during the awaited platform/RPC reads.
  const finalAge = clock().getTime() - Number(block.timestamp) * 1000;
  if (!Number.isFinite(finalAge) || finalAge < 0 || finalAge > 15 * 60_000) throw new Error('WATCHED_MINT_STALE_OR_REORGED');
  const observed: ObservedMintTransaction = { chainId, hash, from: tx.from, to: tx.to!, value: tx.value, data: tx.input, blockNumber: receipt.blockNumber, observedAt: new Date(Number(block.timestamp) * 1000).toISOString() };
  let plan = buildReplicationPlan({ observed, drop, targetWallets: input.targetWallets });
  if (signedMint) {
    const decoded = decodeFunctionData({ abi: SIGNED_MINT_ABI, data: tx.input });
    const [nft, fee, minter, quantity, sourceParams] = decoded.args;
    if (nft.toLowerCase() !== contract.toLowerCase() || fee.toLowerCase() !== drop.feePayer.toLowerCase() || ![/^0x0{40}$/.test(minter), minter.toLowerCase() === tx.from.toLowerCase()].some(Boolean) || quantity !== matches[0]!.quantityMinted || sourceParams.dropStageIndex !== drop.extra?.['stageIndex'] || quantity > BigInt(Number.MAX_SAFE_INTEGER) || tx.value !== 0n || sourceParams.mintPrice !== 0n) throw new Error('SIGNED_MINT_SOURCE_TRANSACTION_INVALID');
    const authorizations = drop.extra?.['signedWalletAuthorizations'] as readonly VerifiedSignedWalletAuthorization[] | undefined;
    const targets = (authorizations ?? []).filter(proof => input.targetWallets.some(wallet => wallet.toLowerCase() === proof.wallet.toLowerCase())).map(proof => {
      const ownQuantity = Math.min(Number(quantity), proof.authority.verifiedQuantity, chainId === 8453 ? 4 : 10);
      return { wallet: proof.wallet, quantity: ownQuantity, ...buildSignedMint(proof, proof.wallet, ownQuantity, clock()) };
    });
    if (!targets.length) throw new Error('SIGNED_MINT_OWN_SIGNATURE_REQUIRED');
    plan = { ...plan, strategy: 'seadrop-v1-signed', verdict: 'replicable', observed: { nftContract: nft, feeRecipient: fee, minterIfNotPayer: minter, quantity: Number(quantity) }, reasons: [], targets, checklist: { ...plan.checklist, knownStrategy: true, chainMatches: true, targetMatches: true, selectorDecoded: true, contractMatches: true, feeRecipientMatches: true, walletIndependent: false, valueMatches: true, quantityWithinDrop: true } };
  } else if (!publicMint) {
    // Decode the source only to establish method and arguments. The source proof is never reused.
    const decoded = decodeFunctionData({ abi: ALLOWLIST_MINT_ABI, data: tx.input });
    const [nft, fee, minter, quantity, sourceParams] = decoded.args;
    if (nft.toLowerCase() !== contract.toLowerCase() || fee.toLowerCase() !== drop.feePayer.toLowerCase() || !/^0x0{40}$/.test(minter) || quantity !== matches[0]!.quantityMinted || sourceParams.dropStageIndex !== drop.extra?.['stageIndex'] || quantity > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ALLOWLIST_SOURCE_TRANSACTION_INVALID');
    const targets = (drop.extra?.['walletProofs'] as readonly VerifiedWalletProof[]).filter((p) => input.targetWallets.some((w) => w.toLowerCase() === p.wallet.toLowerCase())).map((p) => {
      const ownQuantity = Math.min(Number(quantity), Number(p.mintParams.maxTotalMintableByWallet), 15);
      return { wallet: p.wallet, quantity: ownQuantity, ...buildAllowlistMint(p, p.wallet, ownQuantity, clock()) };
    });
    if (!targets.length || tx.value !== sourceParams.mintPrice * quantity) throw new Error('ALLOWLIST_OWN_WALLET_PROOF_REQUIRED');
    plan = { ...plan, strategy: 'seadrop-v1-allowlist', verdict: 'replicable', source: { ...plan.source }, observed: { nftContract: nft, feeRecipient: fee, minterIfNotPayer: minter, quantity: Number(quantity) }, reasons: [], targets, checklist: { ...plan.checklist, knownStrategy: true, chainMatches: true, targetMatches: true, selectorDecoded: true, contractMatches: true, feeRecipientMatches: true, walletIndependent: false, valueMatches: true, quantityWithinDrop: true } };
  }
  if (plan.observed.quantity !== Number(matches[0]!.quantityMinted)) throw new Error('WATCHED_MINT_QUANTITY_MISMATCH');
  return { observed, drop, plan, mintedAt: observed.observedAt! };
}
