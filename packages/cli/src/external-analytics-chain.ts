import { decodeEventLog, decodeFunctionData, encodeEventTopics, encodeAbiParameters, encodeFunctionData, parseAbi, toEventSelector, zeroAddress, type Hex, type PublicClient } from 'viem';
import { ALLOWLIST_MINT_ABI, SIGNED_MINT_ABI, SEADROP_EVENTS_ABI, SEADROP_V1_ADDRESS } from '@mint-bot/engine';
import type { ExecutionChainId, ExternalAnalyticsChainPort, ExternalMintCost, ExternalNftTransfer, ExternalSaleSettlement, ExternalTransactionEvidence } from '@mint-bot/backend';

// Official event shape: ProjectOpenSea/seaport-types,
// src/interfaces/ConsiderationEventsAndErrors.sol::OrderFulfilled.
export const EXTERNAL_SEAPORT_ABI = parseAbi(['event OrderFulfilled(bytes32 orderHash,address indexed offerer,address indexed zone,address recipient,(uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer,(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)']);
export const EXTERNAL_TRANSFER_ABI = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)', 'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)', 'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)']);
export const EXTERNAL_PUBLIC_MINT_ABI = parseAbi(['function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable']);
const ERC20_TRANSFER = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const TRANSFER = toEventSelector(EXTERNAL_TRANSFER_ABI[0]);
const SINGLE = toEventSelector(EXTERNAL_TRANSFER_ABI[1]);
const BATCH = toEventSelector(EXTERNAL_TRANSFER_ABI[2]);
const ORDER = toEventSelector(EXTERNAL_SEAPORT_ABI[0]);
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const SAFE_CODES = new Set(['EXTERNAL_ANALYTICS_HASH_INVALID', 'EXTERNAL_ANALYTICS_RECEIPT_INVALID', 'EXTERNAL_ANALYTICS_REORGED', 'EXTERNAL_ANALYTICS_LOG_BINDING_INVALID', 'EXTERNAL_ANALYTICS_FEES_INVALID', 'EXTERNAL_ANALYTICS_RPC_DISAGREEMENT', 'EXTERNAL_ANALYTICS_FINALITY_UNPROVEN', 'EXTERNAL_ANALYTICS_RPC_TIMEOUT', 'EXTERNAL_NFT_LOG_INVALID']);
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export interface ExternalChainLog { address: string; topics: readonly string[]; data: string; logIndex: number; transactionHash: string; blockHash: string; blockNumber: bigint; removed: boolean; }
export interface ExternalChainReceipt { transactionHash: string; from: string; to: string | null; status: 'success' | 'reverted'; blockNumber: bigint; blockHash: string; transactionIndex: number; gasUsed: bigint; effectiveGasPrice: bigint; logs: ExternalChainLog[]; l1Fee: string | null; operatorFee: string | null; }
export interface ExternalAnalyticsReader { identity: string; client: PublicClient; }
export interface ExternalAnalyticsChainOptions {
  chainId: ExecutionChainId;
  /** Identities are HTTPS hostname identities selected from configuration by the composition root. */
  readers: readonly ExternalAnalyticsReader[];
  /** Explicitly reviewed deployed protocol addresses, never addresses from an API response. */
  seaportAddresses: readonly string[];
  wethAddress?: string;
  /** Required for L2s: finalized tag alone does not establish Ethereum staged finality. */
  finality?(input: { chainId: ExecutionChainId; transactionHash: string; blockNumber: bigint; blockHash: string; readers: readonly ExternalAnalyticsReader[] }): Promise<boolean>;
  /** Required for known full L2 fees. Called on both agreed normalized receipts. */
  totalFeeWei?(chainId: ExecutionChainId, receipt: ExternalChainReceipt): bigint | null;
  timeoutMs?: number;
}

/** Exact standard transfer decoding. Batch items retain canonical array position;
 * a batch proves asset movement, never per-item consideration or mint authority. */
export function parseExternalNftTransfers(logs: readonly ExternalChainLog[]): { transfers: ExternalNftTransfer[]; issues: string[] } {
  const transfers: ExternalNftTransfer[] = []; const issues: string[] = [];
  for (const log of logs) {
    const selector = log.topics[0]?.toLowerCase();
    if (!(selector === TRANSFER.toLowerCase() && log.topics.length === 4 || selector === SINGLE.toLowerCase() || selector === BATCH.toLowerCase())) continue;
    try {
      if (!ADDRESS.test(log.address) || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || log.removed || log.topics.length !== 4 || log.topics.some(topic => !HASH.test(topic)) || !/^0x(?:[a-f0-9]{2})*$/i.test(log.data) || log.data.length > 128_258) throw new Error('INVALID_TRANSFER');
      const decoded = decodeEventLog({ abi: EXTERNAL_TRANSFER_ABI, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
      const args = decoded.args;
      if (!ADDRESS.test(args.from) || !ADDRESS.test(args.to) || same(args.from, args.to)) throw new Error('INVALID_TRANSFER');
      const canonicalTopics = decoded.eventName === 'Transfer'
        ? encodeEventTopics({ abi: EXTERNAL_TRANSFER_ABI, eventName: 'Transfer', args: { from: args.from, to: args.to, tokenId: decoded.args.tokenId } })
        : encodeEventTopics({ abi: EXTERNAL_TRANSFER_ABI, eventName: decoded.eventName, args: { operator: decoded.args.operator, from: args.from, to: args.to } });
      if (canonicalTopics.map(topic => String(topic).toLowerCase()).join('|') !== log.topics.map(topic => topic.toLowerCase()).join('|')) throw new Error('INVALID_TRANSFER');
      let ids: readonly bigint[]; let values: readonly bigint[];
      if (decoded.eventName === 'TransferBatch') {
        ids = decoded.args.ids; values = decoded.args.values;
        if (!ids.length || ids.length > 1000 || ids.length !== values.length || encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [ids, values]).toLowerCase() !== log.data.toLowerCase()) throw new Error('INVALID_TRANSFER');
      } else if (decoded.eventName === 'TransferSingle') {
        ids = [decoded.args.id]; values = [decoded.args.value];
        if (encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [decoded.args.id, decoded.args.value]).toLowerCase() !== log.data.toLowerCase()) throw new Error('INVALID_TRANSFER');
      } else { ids = [decoded.args.tokenId]; values = [1n]; if (log.data !== '0x') throw new Error('INVALID_TRANSFER'); }
      if (values.some(value => value < 1n) || transfers.length + ids.length > 1000) throw new Error('INVALID_TRANSFER');
      ids.forEach((id, subIndex) => transfers.push({ collection: log.address.toLowerCase(), tokenId: id.toString(), quantity: values[subIndex]!.toString(), from: args.from.toLowerCase(), to: args.to.toLowerCase(), logIndex: log.logIndex, ...(decoded.eventName === 'TransferBatch' ? { subIndex, batch: true as const } : {}) }));
    } catch { throw new Error('EXTERNAL_NFT_LOG_INVALID'); }
  }
  return { transfers, issues };
}

/** Historical accounting of a successful direct self-paid known SeaDrop mint.
 * The public chain event, exact decoded call and all acquired NFT logs agree;
 * nothing here reuses the source authorization or grants execution authority. */
export function parseExternalSeaDropMintCost(input: { to: string | null; from: string; value: bigint; data: string; logs: readonly ExternalChainLog[]; transfers: readonly ExternalNftTransfer[] }): { mintCost?: ExternalMintCost; issues: string[] } {
  if (!input.to || !same(input.to, SEADROP_V1_ADDRESS)) return { issues: [] };
  const fail = () => ({ issues: ['EXTERNAL_SEADROP_MINT_COST_UNPROVEN'] });
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(input.data) || input.data.length > 40_000) return fail();
  try {
    const abi = [...EXTERNAL_PUBLIC_MINT_ABI, ...ALLOWLIST_MINT_ABI, ...SIGNED_MINT_ABI];
    const decoded = decodeFunctionData({ abi, data: input.data as Hex });
    const [nft, feeRecipient, minter, quantity] = decoded.args;
    const params = decoded.functionName === 'mintPublic' ? undefined : decoded.args[4];
    if ((!same(minter, zeroAddress) && !same(minter, input.from)) || quantity < 1n || encodeFunctionData({ abi, functionName: decoded.functionName, args: decoded.args }).toLowerCase() !== input.data.toLowerCase()) return fail();
    const mints = input.logs.filter(log => same(log.address, SEADROP_V1_ADDRESS)).flatMap(log => {
      try { const event = decodeEventLog({ abi: SEADROP_EVENTS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true }); return event.eventName === 'SeaDropMint' ? [event.args] : []; } catch { return []; }
    });
    if (mints.length !== 1) return fail(); const mint = mints[0]!;
    if (!same(mint.nftContract, nft) || !same(mint.feeRecipient, feeRecipient) || !same(mint.minter, input.from) || !same(mint.payer, input.from) || mint.quantityMinted !== quantity || mint.unitMintPrice * quantity !== input.value || params && params.mintPrice !== mint.unitMintPrice || !input.transfers.length || new Set(input.transfers.map(row => row.tokenId)).size !== input.transfers.length || input.transfers.some(row => !same(row.collection, nft) || !same(row.from, zeroAddress) || !same(row.to, input.from) || row.quantity !== '1' || !input.logs.some(log => log.logIndex === row.logIndex && log.topics.length === 4 && log.topics[0]?.toLowerCase() === TRANSFER.toLowerCase())) || input.transfers.reduce((sum, row) => sum + BigInt(row.quantity), 0n) !== quantity) return fail();
    return { mintCost: { protocol: 'seadrop-direct-v1', method: decoded.functionName, collection: nft.toLowerCase(), minter: input.from.toLowerCase(), quantity: quantity.toString(), totalValueWei: input.value.toString(), transferLogIndices: input.transfers.map(row => row.logIndex).sort((a, b) => a - b) }, issues: [] };
  } catch { return fail(); }
}

/** One listing sale and one NFT only. Bundles, bids, aggregators, criteria and
 * unknown currencies are deliberately not assigned invented consideration. */
export function parseExternalSeaportSettlement(input: { receipt: ExternalChainReceipt; transfers: readonly ExternalNftTransfer[]; seaportAddresses: readonly string[]; wethAddress?: string; transactionValue: bigint }): { settlements: ExternalSaleSettlement[]; issues: string[] } {
  const fail = () => ({ settlements: [], issues: ['EXTERNAL_SEAPORT_ECONOMICS_UNSUPPORTED'] });
  const orders = input.receipt.logs.filter(log => log.topics[0]?.toLowerCase() === ORDER.toLowerCase());
  if (!orders.length) return { settlements: [], issues: [] };
  if (orders.length !== 1 || input.transfers.length !== 1 || !input.seaportAddresses.some(address => same(address, orders[0]!.address)) || !input.receipt.to || !same(input.receipt.to, orders[0]!.address)) return fail();
  try {
    const log = orders[0]!;
    const decoded = decodeEventLog({ abi: EXTERNAL_SEAPORT_ABI, data: log.data as `0x${string}`, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], strict: true });
    const { offerer, recipient, offer, consideration } = decoded.args;
    const nft = offer[0]; const transfer = input.transfers[0]!;
    if (transfer.batch === true || (transfer.subIndex ?? 0) !== 0 || !nft || offer.length !== 1 || ![2, 3].includes(nft.itemType) || !same(recipient, input.receipt.from) || same(offerer, recipient) || !same(nft.token, transfer.collection) || nft.identifier.toString() !== transfer.tokenId || nft.amount.toString() !== transfer.quantity || !same(offerer, transfer.from) || !same(recipient, transfer.to) || !consideration.length || consideration.length > 30) return fail();
    const first = consideration[0]!;
    const native = first.itemType === 0 && same(first.token, zeroAddress);
    const wrapped = first.itemType === 1 && input.wethAddress !== undefined && same(first.token, input.wethAddress);
    if (!native && !wrapped || consideration.some(row => row.itemType !== first.itemType || !same(row.token, first.token) || row.identifier !== 0n || row.amount <= 0n || same(row.recipient, zeroAddress))) return fail();
    const gross = consideration.reduce((sum, row) => sum + row.amount, 0n);
    const sellerNet = consideration.filter(row => same(row.recipient, offerer)).reduce((sum, row) => sum + row.amount, 0n);
    if (sellerNet <= 0n || gross >= 2n ** 256n || native && input.transactionValue !== gross || wrapped && input.transactionValue !== 0n) return fail();
    if (wrapped) {
      const expected = new Map<string, bigint>(); const actual = new Map<string, bigint>();
      for (const row of consideration) expected.set(row.recipient.toLowerCase(), (expected.get(row.recipient.toLowerCase()) ?? 0n) + row.amount);
      for (const payment of input.receipt.logs.filter(row => same(row.address, first.token) && row.topics[0]?.toLowerCase() === TRANSFER.toLowerCase())) {
        const decodedPayment = decodeEventLog({ abi: ERC20_TRANSFER, data: payment.data as `0x${string}`, topics: payment.topics as [`0x${string}`, ...`0x${string}`[]], strict: true });
        if (!same(decodedPayment.args.from, input.receipt.from)) return fail();
        const destination = decodedPayment.args.to.toLowerCase(); actual.set(destination, (actual.get(destination) ?? 0n) + decodedPayment.args.value);
      }
      if (actual.size !== expected.size || [...expected].some(([recipient, amount]) => actual.get(recipient) !== amount)) return fail();
    }
    return { settlements: [{ protocol: 'seaport-single-nft-v1', transferLogIndex: transfer.logIndex, seller: offerer.toLowerCase(), buyer: recipient.toLowerCase(), currency: native ? 'ETH' : 'WETH', grossWei: gross.toString(), feesWei: (gross - sellerNet).toString() }], issues: [] };
  } catch { return fail(); }
}

/** Two independently configured readers must agree on selected public facts.
 * No signer, sendTransaction, trace endpoint or API-reported sale value is used. */
export function createExternalAnalyticsChainPort(options: ExternalAnalyticsChainOptions): ExternalAnalyticsChainPort {
  const timeout = options.timeoutMs ?? 20_000;
  if (![1, 8453, 4663].includes(options.chainId) || options.readers.length < 2 || options.readers[0]!.client === options.readers[1]!.client || options.readers.slice(0, 2).some(reader => !/^[a-z0-9.-]{1,253}$/.test(reader.identity)) || same(options.readers[0]!.identity, options.readers[1]!.identity) || options.seaportAddresses.length > 10 || options.seaportAddresses.some(address => !ADDRESS.test(address) || same(address, zeroAddress)) || options.wethAddress !== undefined && (!ADDRESS.test(options.wethAddress) || same(options.wethAddress, zeroAddress)) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error('EXTERNAL_ANALYTICS_INDEPENDENT_READERS_REQUIRED');
  const readers = options.readers.slice(0, 2);
  const read = async (hash: string): Promise<ExternalTransactionEvidence> => {
    if (!HASH.test(hash)) throw new Error('EXTERNAL_ANALYTICS_HASH_INVALID');
    const views = await Promise.all(readers.map(async ({ client }) => {
      const [chainId, tx, raw] = await Promise.all([client.getChainId(), client.getTransaction({ hash: hash as `0x${string}` }), client.getTransactionReceipt({ hash: hash as `0x${string}` })]);
      if (chainId !== options.chainId || !tx.blockNumber || !tx.blockHash || tx.blockNumber !== raw.blockNumber || !same(tx.blockHash, raw.blockHash) || !same(tx.hash, hash) || !same(raw.transactionHash, hash) || !same(tx.from, raw.from) || tx.to?.toLowerCase() !== raw.to?.toLowerCase() || raw.status !== 'success' || raw.logs.length > 10_000) throw new Error('EXTERNAL_ANALYTICS_RECEIPT_INVALID');
      const block = await client.getBlock({ blockNumber: raw.blockNumber });
      if (!block.hash || !same(block.hash, raw.blockHash)) throw new Error('EXTERNAL_ANALYTICS_REORGED');
      const extension = raw as unknown as Record<string, unknown>;
      const fee = (key: string): string | null => typeof extension[key] === 'bigint' && extension[key] >= 0n ? extension[key].toString() : null;
      const receipt: ExternalChainReceipt = { transactionHash: raw.transactionHash.toLowerCase(), from: raw.from.toLowerCase(), to: raw.to?.toLowerCase() ?? null, blockNumber: raw.blockNumber, blockHash: raw.blockHash.toLowerCase(), status: raw.status, transactionIndex: raw.transactionIndex, gasUsed: raw.gasUsed, effectiveGasPrice: raw.effectiveGasPrice, l1Fee: fee('l1Fee'), operatorFee: fee('operatorFee'), logs: raw.logs.map(log => ({ address: log.address.toLowerCase(), topics: log.topics.map(topic => topic.toLowerCase()), data: log.data.toLowerCase(), logIndex: log.logIndex, transactionHash: log.transactionHash.toLowerCase(), blockHash: log.blockHash.toLowerCase(), blockNumber: log.blockNumber, removed: log.removed ?? false })) };
      const indices = new Set<number>();
      for (const log of receipt.logs) {
        if (!ADDRESS.test(log.address) || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || indices.has(log.logIndex) || !same(log.transactionHash, hash) || log.blockNumber !== receipt.blockNumber || !same(log.blockHash, receipt.blockHash) || log.removed || log.topics.some(topic => !HASH.test(topic)) || !/^0x(?:[0-9a-f]{2})*$/.test(log.data)) throw new Error('EXTERNAL_ANALYTICS_LOG_BINDING_INVALID');
        indices.add(log.logIndex);
      }
      if (receipt.gasUsed < 0n || receipt.effectiveGasPrice < 0n) throw new Error('EXTERNAL_ANALYTICS_FEES_INVALID');
      return { receipt, value: tx.value, input: tx.input, timestamp: block.timestamp };
    }));
    const json = (value: unknown): string => JSON.stringify(value, (_key, row: unknown) => typeof row === 'bigint' ? row.toString() : row);
    if (json(views[0]) !== json(views[1])) throw new Error('EXTERNAL_ANALYTICS_RPC_DISAGREEMENT');
    const view = views[0]!;
    const { receipt } = view;
    let finalized = false;
    if (options.chainId === 1) { const heads = await Promise.all(readers.map(({ client }) => client.getBlock({ blockTag: 'finalized' }))); finalized = heads.every(block => block.number !== null && block.number >= receipt.blockNumber); }
    if (options.finality && (options.chainId !== 1 || finalized)) finalized = await options.finality({ chainId: options.chainId, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, readers });
    if (!finalized) throw new Error('EXTERNAL_ANALYTICS_FINALITY_UNPROVEN');
    // Finality may await an L1 observer; reconfirm chain/hash after that wait.
    const current = await Promise.all(readers.map(async ({ client }) => ({ chainId: await client.getChainId(), hash: (await client.getBlock({ blockNumber: receipt.blockNumber })).hash })));
    if (current.some(row => row.chainId !== options.chainId || !row.hash || !same(row.hash, receipt.blockHash))) throw new Error('EXTERNAL_ANALYTICS_REORGED');
    const transfers = parseExternalNftTransfers(receipt.logs);
    const mint = parseExternalSeaDropMintCost({ to: receipt.to, from: receipt.from, value: view.value, data: view.input, logs: receipt.logs, transfers: transfers.transfers });
    const settlement = parseExternalSeaportSettlement({ receipt, transfers: transfers.transfers, seaportAddresses: options.seaportAddresses, wethAddress: options.wethAddress, transactionValue: view.value });
    const executionFee = receipt.gasUsed * receipt.effectiveGasPrice;
    const fee = options.chainId === 1 ? executionFee : options.totalFeeWei ? options.totalFeeWei(options.chainId, receipt) : null;
    if (fee !== null && (typeof fee !== 'bigint' || fee < executionFee || fee >= 2n ** 256n)) throw new Error('EXTERNAL_ANALYTICS_FEES_INVALID');
    return { chainId: options.chainId, transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(), transactionIndex: receipt.transactionIndex, from: receipt.from, valueWei: view.value.toString(), at: new Date(Number(view.timestamp) * 1000).toISOString(), finality: 'finalized', readerIdentities: [readers[0]!.identity, readers[1]!.identity], transactionFeeWei: fee?.toString() ?? null, transfers: transfers.transfers, settlements: settlement.settlements, ...(mint.mintCost ? { mintCost: mint.mintCost } : {}), issues: [...new Set([...transfers.issues, ...settlement.issues, ...mint.issues])] };
  };
  return { async observe(hash) { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([read(hash), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('EXTERNAL_ANALYTICS_RPC_TIMEOUT')), timeout); })]); } catch (error) { throw new Error(error instanceof Error && SAFE_CODES.has(error.message) ? error.message : 'EXTERNAL_ANALYTICS_CHAIN_UNAVAILABLE'); } finally { if (timer) clearTimeout(timer); } } };
}
