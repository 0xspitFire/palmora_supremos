import { decodeAbiParameters, encodeAbiParameters, getContractAddress, keccak256, stringToHex, type Hex } from 'viem';

export type NFTObservedStandard = 'erc721' | 'erc1155';
export interface NFTMonitorCandidate {
  version: 1; kind: 'mint' | 'deployment'; chainId: number; transactionHash: string;
  blockNumber: string; blockHash: string; logIndex?: number; contract?: string; wallet?: string; standard?: NFTObservedStandard;
}
export interface NFTMonitorObservation {
  version: 1; kind: 'mint' | 'deployment'; chainId: number; identity: string; contract: string;
  standard: NFTObservedStandard; transactionHash: string; blockNumber: string; blockHash: string;
  blockTimestamp: string; observedAt: string; sender: string; wallet?: string;
  tokenIds: readonly string[]; quantities: readonly string[]; quantity: string;
  strategy: 'unsupported'; priceWei: null; stage: 'unknown'; factoryCoverage: 'not-observed';
}
export interface NFTMonitorContinuation {
  fromBlock: string; toBlock: string; watchlistDigest: string; phase: 'logs' | 'deployments';
  queryIndex: number; offset: number; deploymentBlockIndex: number; rangeEndHash?: string;
}
export interface NFTMonitorScan {
  fromBlock: string; toBlock: string; settledHead: string; candidates: NFTMonitorCandidate[];
  continuation?: NFTMonitorContinuation; partialReasons: string[];
  deploymentBlocksInspected: string[]; deploymentBlocksOmitted: string; factoryCoverage: 'not-observed'; callsUsed: number;
}
export type NFTMonitorVerification = { status: 'verified'; observation: NFTMonitorObservation } | { status: 'rejected' | 'unavailable'; code: string };
export interface NFTObservedLog { address: string; topics: readonly string[]; data: string; logIndex: number; transactionHash: string; blockNumber: bigint; blockHash: string; removed?: boolean; }
export interface NFTObservedTransaction { hash: string; from: string; to: string | null; nonce: number; blockNumber: bigint | null; blockHash: string | null; }
export interface NFTObservedReceipt { transactionHash: string; from: string; to: string | null; contractAddress: string | null; status: 'success' | 'reverted'; blockNumber: bigint; blockHash: string; logs: readonly NFTObservedLog[]; }
export interface NFTObservedBlock { number: bigint; hash: string; timestamp: bigint; transactions?: readonly NFTObservedTransaction[]; }
/** Each method is exactly one read-only JSON-RPC call; adapters must disable transport retries. */
export interface NFTDiscoveryReader {
  chainId(signal: AbortSignal): Promise<number>; head(signal: AbortSignal): Promise<bigint>;
  block(number: bigint, transactions: boolean, signal: AbortSignal): Promise<NFTObservedBlock>;
  logs(input: { fromBlock: bigint; toBlock: bigint; topics: readonly (string | readonly string[] | null)[] }, signal: AbortSignal): Promise<readonly NFTObservedLog[]>;
  transaction(hash: string, signal: AbortSignal): Promise<NFTObservedTransaction>;
  receipt(hash: string, signal: AbortSignal): Promise<NFTObservedReceipt>;
  code(address: string, block: bigint, signal: AbortSignal): Promise<string>;
  supportsInterface(address: string, interfaceId: string, block: bigint, signal: AbortSignal): Promise<boolean>;
}
export interface NFTDiscoveryLimits { maxCalls?: number; maxRange?: bigint; watchedChunk?: number; deploymentBlocks?: number; maxRawLogs?: number; callTimeoutMs?: number; initialLookback?: bigint; }
const TRANSFER = keccak256(stringToHex('Transfer(address,address,uint256)'));
const SINGLE = keccak256(stringToHex('TransferSingle(address,address,address,uint256,uint256)'));
const BATCH = keccak256(stringToHex('TransferBatch(address,address,address,uint256[],uint256[])'));
const ZERO = `0x${'0'.repeat(64)}`;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const seenVerified = new WeakSet<object>();
const same = (a: string | null | undefined, b: string | null | undefined) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fail = (code: string): never => { throw new Error(`NFT_MONITOR_${code}`); };
const topicAddress = (address: string) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
function fromTopic(topic: string | undefined): string | undefined { return typeof topic === 'string' && /^0x0{24}[a-f0-9]{40}$/i.test(topic) ? `0x${topic.slice(26)}`.toLowerCase() : undefined; }
export function nftMonitorCandidateIdentity(candidate: NFTMonitorCandidate): string { return `${candidate.chainId}:${candidate.transactionHash.toLowerCase()}:${candidate.kind === 'deployment' ? 'creation' : `${candidate.logIndex}:${candidate.standard}`}`; }
export function assertVerifiedNFTObservation(value: NFTMonitorObservation): void { if (!seenVerified.has(value)) fail('VERIFIED_OBSERVATION_REQUIRED'); }
function parsedMint(log: NFTObservedLog): { standard: NFTObservedStandard; wallet: string; tokenIds: string[]; quantities: string[] } | undefined {
  if (log.removed === true || !ADDRESS.test(log.address) || !HASH.test(log.transactionHash) || !HASH.test(log.blockHash) || typeof log.blockNumber !== 'bigint' || log.blockNumber < 0n || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || log.topics.length !== 4 || log.topics.some(topic => !HASH.test(topic)) || typeof log.data !== 'string' || log.data.length > 16_514) return undefined;
  if (same(log.topics[0], TRANSFER)) {
    const wallet = fromTopic(log.topics[2]);
    if (!same(log.topics[1], ZERO) || !wallet || log.data !== '0x') return undefined;
    return { standard: 'erc721', wallet, tokenIds: [BigInt(log.topics[3]!).toString()], quantities: ['1'] };
  }
  const wallet = fromTopic(log.topics[3]);
  if (!wallet || !fromTopic(log.topics[1]) || !same(log.topics[2], ZERO)) return undefined;
  try {
    if (same(log.topics[0], SINGLE)) {
      const parameters = [{ type: 'uint256' }, { type: 'uint256' }] as const;
      const decoded = decodeAbiParameters(parameters, log.data as Hex);
      if (decoded[1] < 1n || encodeAbiParameters(parameters, decoded).toLowerCase() !== log.data.toLowerCase()) return undefined;
      return { standard: 'erc1155', wallet, tokenIds: [decoded[0].toString()], quantities: [decoded[1].toString()] };
    }
    if (same(log.topics[0], BATCH)) {
      const parameters = [{ type: 'uint256[]' }, { type: 'uint256[]' }] as const;
      const decoded = decodeAbiParameters(parameters, log.data as Hex);
      if (!decoded[0].length || decoded[0].length > 64 || decoded[0].length !== decoded[1].length || decoded[1].some(value => value < 1n) || encodeAbiParameters(parameters, decoded).toLowerCase() !== log.data.toLowerCase()) return undefined;
      return { standard: 'erc1155', wallet, tokenIds: decoded[0].map(value => value.toString()), quantities: decoded[1].map(value => value.toString()) };
    }
  } catch { return undefined; }
  return undefined;
}

/** Generic observed facts only; settled observations are not finality or execution permission.
 * Default 137-wallet tick: six head calls + two range-anchor calls + eighteen log calls + four sampled-block calls = 30.
 * One complete candidate verification costs 22, so the composed default uses at most 52;
 * all paths share a hard 64-call ceiling, 5s per-call deadline and resumable range state.
 * Distinct HTTPS hosts are checked, not provider ownership/operational independence.
 * Deployment counts describe this page only; earlier pages and factories are not claimed as covered.
 * No mint strategy, call builder, signer, relay or trace method exists here.
 */
export class NFTDiscoveryObserver {
  private calls = 0;
  private signal?: AbortSignal;
  private readonly readers: readonly NFTDiscoveryReader[];
  private readonly now: () => Date;
  private readonly limits: Required<NFTDiscoveryLimits>;
  public constructor(private readonly options: { chainId: 1 | 8453 | 4663; readers: readonly { endpoint: string; client: NFTDiscoveryReader }[]; now?: () => Date; limits?: NFTDiscoveryLimits }) {
    const limits = { maxCalls: 64, maxRange: 256n, watchedChunk: 64, deploymentBlocks: 2, maxRawLogs: 2000, callTimeoutMs: 5000, initialLookback: 32n, ...options.limits };
    if (![1, 8453, 4663].includes(options.chainId) || !Number.isSafeInteger(limits.maxCalls) || limits.maxCalls < 22 || limits.maxCalls > 64 || limits.maxRange < 1n || limits.maxRange > 500n || !Number.isSafeInteger(limits.watchedChunk) || limits.watchedChunk < 1 || limits.watchedChunk > 64 || !Number.isSafeInteger(limits.deploymentBlocks) || limits.deploymentBlocks < 0 || limits.deploymentBlocks > 2 || !Number.isSafeInteger(limits.maxRawLogs) || limits.maxRawLogs < 1 || limits.maxRawLogs > 2000 || !Number.isSafeInteger(limits.callTimeoutMs) || limits.callTimeoutMs < 1 || limits.callTimeoutMs > 10_000 || limits.initialLookback < 0n || limits.initialLookback > 500n) fail('CONFIG_INVALID');
    let hosts: string[];
    try { hosts = options.readers.map(row => { const url = new URL(row.endpoint); if (url.protocol !== 'https:') fail('INDEPENDENT_READERS_REQUIRED'); return url.hostname.toLowerCase().replace(/\.$/, ''); }); } catch { fail('INDEPENDENT_READERS_REQUIRED'); }
    if (options.readers.length !== 2 || !hosts![0] || hosts![0] === hosts![1] || options.readers[0]!.client === options.readers[1]!.client) fail('INDEPENDENT_READERS_REQUIRED');
    this.readers = options.readers.map(row => row.client); this.now = options.now ?? (() => new Date()); this.limits = limits;
  }
  public beginTick(signal?: AbortSignal): void { this.calls = 0; this.signal = signal; }
  public get callsUsed(): number { return this.calls; }
  public assertVerified(observation: NFTMonitorObservation): void { assertVerifiedNFTObservation(observation); }

  public async scan(input: { fromBlock?: string; watched: readonly string[]; maxCandidates: number; continuation?: NFTMonitorContinuation }): Promise<NFTMonitorScan> {
    try {
      const watched = this.wallets(input.watched);
      if (!Number.isSafeInteger(input.maxCandidates) || input.maxCandidates < 1 || input.maxCandidates > 128) fail('CONFIG_INVALID');
      const settledHead = await this.settledHead();
      const digest = keccak256(stringToHex(watched.join(',')));
      let from = input.fromBlock === undefined ? settledHead > this.limits.initialLookback ? settledHead - this.limits.initialLookback : 0n : this.blockNumber(input.fromBlock);
      if (from > settledHead) return { fromBlock: from.toString(), toBlock: settledHead.toString(), settledHead: settledHead.toString(), candidates: [], partialReasons: [], deploymentBlocksInspected: [], deploymentBlocksOmitted: '0', factoryCoverage: 'not-observed', callsUsed: this.calls };
      let to = from + this.limits.maxRange - 1n < settledHead ? from + this.limits.maxRange - 1n : settledHead;
      let cursor: NFTMonitorContinuation = { fromBlock: from.toString(), toBlock: to.toString(), watchlistDigest: digest, phase: 'logs', queryIndex: 0, offset: 0, deploymentBlockIndex: 0 };
      if (input.continuation) {
        this.validateContinuation(input.continuation);
        from = this.blockNumber(input.continuation.fromBlock); to = this.blockNumber(input.continuation.toBlock);
        if (to > settledHead || to - from + 1n > this.limits.maxRange) fail('CONTINUATION_INVALID');
        cursor = input.continuation.watchlistDigest === digest ? { ...input.continuation } : { ...cursor, fromBlock: from.toString(), toBlock: to.toString() };
      }
      const anchors = await Promise.all(this.readers.map(reader => this.call(signal => reader.block(to, false, signal))));
      if (json(anchors[0]) !== json(anchors[1]) || anchors[0]!.number !== to || !HASH.test(anchors[0]!.hash)) fail('RPC_DISAGREEMENT');
      const rangeEndHash = anchors[0]!.hash.toLowerCase();
      if (input.continuation && cursor.rangeEndHash !== rangeEndHash) cursor = { fromBlock: from.toString(), toBlock: to.toString(), watchlistDigest: digest, phase: 'logs', queryIndex: 0, offset: 0, deploymentBlockIndex: 0 };
      cursor.rangeEndHash = rangeEndHash;
      const candidates: NFTMonitorCandidate[] = []; const partialReasons: string[] = [];
      const inspected: string[] = [];
      const chunks: string[][] = []; for (let i = 0; i < watched.length; i += this.limits.watchedChunk) chunks.push(watched.slice(i, i + this.limits.watchedChunk));
      const queries = chunks.flatMap(chunk => [[TRANSFER, ZERO, chunk.map(topicAddress)], [SINGLE, null, ZERO, chunk.map(topicAddress)], [BATCH, null, ZERO, chunk.map(topicAddress)]]);
      if (cursor.queryIndex > queries.length || cursor.phase === 'deployments' && cursor.queryIndex !== queries.length) fail('CONTINUATION_INVALID');
      const result = (continuation?: NFTMonitorContinuation): NFTMonitorScan => ({ fromBlock: from.toString(), toBlock: to.toString(), settledHead: settledHead.toString(), candidates, ...(continuation ? { continuation } : {}), partialReasons, deploymentBlocksInspected: inspected, deploymentBlocksOmitted: (to - from + 1n - BigInt(inspected.length)).toString(), factoryCoverage: 'not-observed', callsUsed: this.calls });
      if (cursor.phase === 'logs') {
        for (let query = cursor.queryIndex; query < queries.length; query++) {
          if (this.calls + 2 > this.limits.maxCalls) return result({ ...cursor, queryIndex: query });
          let logs: readonly NFTObservedLog[];
          try {
            const results = await Promise.all(this.readers.map(reader => this.call(signal => reader.logs({ fromBlock: from, toBlock: to, topics: queries[query]! }, signal))));
            if (results.some(rows => rows.length > this.limits.maxRawLogs)) fail('RANGE_LIMIT');
            const normalized = results.map(rows => [...rows].sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));
            if (json(normalized[0]) !== json(normalized[1])) fail('RPC_DISAGREEMENT'); logs = normalized[0]!;
          } catch (error) {
            if (error instanceof Error && error.message === 'NFT_MONITOR_RANGE_LIMIT' && to > from) {
              to = from + (to - from) / 2n; partialReasons.push('LOG_RANGE_REDUCED');
              return result({ fromBlock: from.toString(), toBlock: to.toString(), watchlistDigest: digest, phase: 'logs', queryIndex: 0, offset: 0, deploymentBlockIndex: 0 });
            }
            throw error;
          }
          if (query === cursor.queryIndex && cursor.offset > logs.length) fail('CONTINUATION_INVALID');
          for (let offset = query === cursor.queryIndex ? cursor.offset : 0; offset < logs.length; offset++) {
            const log = logs[offset]!; const mint = parsedMint(log);
            if (!mint || !watched.includes(mint.wallet) || log.blockNumber < from || log.blockNumber > to) continue;
            candidates.push({ version: 1, kind: 'mint', chainId: this.options.chainId, transactionHash: log.transactionHash.toLowerCase(), blockNumber: log.blockNumber.toString(), blockHash: log.blockHash.toLowerCase(), logIndex: log.logIndex, contract: log.address.toLowerCase(), wallet: mint.wallet, standard: mint.standard });
            if (candidates.length >= input.maxCandidates) return result({ ...cursor, queryIndex: query, offset: offset + 1 });
          }
          cursor = { ...cursor, queryIndex: query + 1, offset: 0 };
        }
        cursor = { ...cursor, phase: 'deployments', offset: 0, deploymentBlockIndex: 0 };
      }
      const blocks = Array.from({ length: Math.min(Number(to - from + 1n), this.limits.deploymentBlocks) }, (_, index) => to - BigInt(index));
      for (let index = cursor.deploymentBlockIndex; index < blocks.length; index++) {
        if (this.calls + 2 > this.limits.maxCalls) return result({ ...cursor, deploymentBlockIndex: index });
        let block: NFTObservedBlock;
        try {
          const rows = await Promise.all(this.readers.map(reader => this.call(signal => reader.block(blocks[index]!, true, signal))));
          if (json(rows[0]) !== json(rows[1]) || rows[0]!.number !== blocks[index] || !HASH.test(rows[0]!.hash) || !rows[0]!.transactions || rows[0]!.transactions.length > 2000) fail('DEPLOYMENT_BLOCK_UNAVAILABLE');
          block = rows[0]!;
        } catch { partialReasons.push('DEPLOYMENT_BLOCK_UNAVAILABLE'); continue; }
        inspected.push(block.number.toString());
        const transactions = block.transactions!;
        if (index === cursor.deploymentBlockIndex && cursor.offset > transactions.length) fail('CONTINUATION_INVALID');
        for (let offset = index === cursor.deploymentBlockIndex ? cursor.offset : 0; offset < transactions.length; offset++) {
          const tx = transactions[offset]!;
          if (tx.to !== null || !HASH.test(tx.hash) || !ADDRESS.test(tx.from)) continue;
          candidates.push({ version: 1, kind: 'deployment', chainId: this.options.chainId, transactionHash: tx.hash.toLowerCase(), blockNumber: block.number.toString(), blockHash: block.hash.toLowerCase() });
          if (candidates.length >= input.maxCandidates) return result({ ...cursor, deploymentBlockIndex: index, offset: offset + 1 });
        }
        cursor = { ...cursor, deploymentBlockIndex: index + 1, offset: 0 };
      }
      if (to - from + 1n > BigInt(blocks.length)) partialReasons.push('DEPLOYMENT_BLOCK_SAMPLING');
      return result();
    } catch (error) { throw this.safe(error); }
  }

  public async verify(candidate: NFTMonitorCandidate, watchedInput: readonly string[]): Promise<NFTMonitorVerification> {
    try {
      this.validateCandidate(candidate); const watched = this.wallets(watchedInput);
      if (this.calls + 22 > this.limits.maxCalls) return { status: 'unavailable', code: 'NFT_MONITOR_CALL_BUDGET_EXHAUSTED' };
      const settled = await this.settledHead(); const number = this.blockNumber(candidate.blockNumber);
      if (number > settled) return { status: 'rejected', code: 'NFT_MONITOR_BLOCK_NOT_SETTLED' };
      const views = await Promise.all(this.readers.map(async reader => {
        const [tx, receipt, block] = await Promise.all([
          this.call(signal => reader.transaction(candidate.transactionHash, signal)), this.call(signal => reader.receipt(candidate.transactionHash, signal)), this.call(signal => reader.block(number, false, signal)),
        ]);
        if (!same(tx.hash, candidate.transactionHash) || !same(receipt.transactionHash, candidate.transactionHash) || receipt.status !== 'success' || !same(tx.from, receipt.from) || !ADDRESS.test(tx.from) || tx.blockNumber !== number || receipt.blockNumber !== number || !same(tx.blockHash, candidate.blockHash) || !same(receipt.blockHash, candidate.blockHash) || block.number !== number || !same(block.hash, candidate.blockHash) || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || !Array.isArray(receipt.logs) || receipt.logs.length > 2000) fail('RECEIPT_BINDING_INVALID');
        let contract: string; let mint: ReturnType<typeof parsedMint> = undefined;
        if (candidate.kind === 'deployment') {
          if (tx.to !== null || receipt.to !== null || !receipt.contractAddress || !ADDRESS.test(receipt.contractAddress) || !same(receipt.contractAddress, getContractAddress({ from: tx.from as `0x${string}`, nonce: BigInt(tx.nonce) }))) fail('CREATION_INVALID');
          contract = receipt.contractAddress!;
        } else {
          if (!watched.includes(candidate.wallet!) || !same(tx.from, candidate.wallet) || !same(receipt.from, candidate.wallet) || (tx.to === null ? receipt.to !== null : !same(tx.to, receipt.to))) fail('SELF_MINT_REQUIRED');
          const log = receipt.logs.filter(log => log.logIndex === candidate.logIndex && same(log.address, candidate.contract));
          if (log.length !== 1 || !same(log[0]!.transactionHash, candidate.transactionHash) || log[0]!.blockNumber !== number || !same(log[0]!.blockHash, candidate.blockHash)) fail('MINT_LOG_INVALID');
          mint = parsedMint(log[0]!);
          if (!mint || mint.standard !== candidate.standard || !same(mint.wallet, candidate.wallet)) fail('MINT_LOG_INVALID');
          contract = candidate.contract!;
        }
        const [code, erc165, invalid, erc721, erc1155] = await Promise.all([
          this.call(signal => reader.code(contract, number, signal)),
          this.call(signal => reader.supportsInterface(contract, '0x01ffc9a7', number, signal)),
          this.call(signal => reader.supportsInterface(contract, '0xffffffff', number, signal)),
          this.call(signal => reader.supportsInterface(contract, '0x80ac58cd', number, signal)),
          this.call(signal => reader.supportsInterface(contract, '0xd9b67a26', number, signal)),
        ]);
        if (!/^0x(?:[a-f0-9]{2})+$/i.test(code) || code.length > 100_002 || erc165 !== true || invalid !== false || erc721 !== true && erc1155 !== true || candidate.standard === 'erc721' && erc721 !== true || candidate.standard === 'erc1155' && erc1155 !== true) fail('NFT_INTERFACE_REQUIRED');
        const timestamp = Number(block.timestamp) * 1000;
        if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > this.now().getTime() || Number.isNaN(new Date(timestamp).getTime())) fail('BLOCK_TIME_INVALID');
        return { evidence: { tx, receipt, block, code, erc165, invalid, erc721, erc1155 }, contract: contract.toLowerCase(), standard: mint?.standard ?? (erc721 ? 'erc721' : 'erc1155') as NFTObservedStandard, sender: tx.from.toLowerCase(), blockTimestamp: new Date(timestamp).toISOString(), tokenIds: mint?.tokenIds ?? [], quantities: mint?.quantities ?? [] };
      }));
      if (json(views[0]) !== json(views[1])) fail('RPC_DISAGREEMENT');
      const { evidence: _evidence, ...view } = views[0]!;
      void _evidence;
      const observation: NFTMonitorObservation = Object.freeze({ version: 1, kind: candidate.kind, chainId: candidate.chainId, identity: nftMonitorCandidateIdentity(candidate), ...view, transactionHash: candidate.transactionHash.toLowerCase(), blockNumber: candidate.blockNumber, blockHash: candidate.blockHash.toLowerCase(), observedAt: this.now().toISOString(), ...(candidate.kind === 'mint' ? { wallet: candidate.wallet!.toLowerCase() } : {}), tokenIds: Object.freeze([...view.tokenIds]), quantities: Object.freeze([...view.quantities]), quantity: view.quantities.reduce((sum, value) => sum + BigInt(value), 0n).toString(), strategy: 'unsupported', priceWei: null, stage: 'unknown', factoryCoverage: 'not-observed' });
      seenVerified.add(observation); return { status: 'verified', observation };
    } catch (error) {
      const code = this.safe(error).message;
      return { status: ['RECEIPT_BINDING_INVALID', 'CREATION_INVALID', 'SELF_MINT_REQUIRED', 'MINT_LOG_INVALID', 'NFT_INTERFACE_REQUIRED', 'BLOCK_TIME_INVALID', 'CANDIDATE_INVALID'].some(reason => code === `NFT_MONITOR_${reason}`) ? 'rejected' : 'unavailable', code };
    }
  }
  private async settledHead(): Promise<bigint> {
    const rows = await Promise.all(this.readers.map(async reader => ({ chain: await this.call(signal => reader.chainId(signal)), head: await this.call(signal => reader.head(signal)) })));
    if (rows.some(row => row.chain !== this.options.chainId || typeof row.head !== 'bigint' || row.head < 2n)) fail('CHAIN_UNAVAILABLE');
    const number = (rows[0]!.head < rows[1]!.head ? rows[0]!.head : rows[1]!.head) - 2n;
    const headers = await Promise.all(this.readers.map(reader => this.call(signal => reader.block(number, false, signal))));
    if (json(headers[0]) !== json(headers[1]) || headers[0]!.number !== number || !HASH.test(headers[0]!.hash)) fail('RPC_DISAGREEMENT');
    const age = this.now().getTime() - Number(headers[0]!.timestamp) * 1000;
    if (!Number.isFinite(age) || age < -30_000 || age > 300_000) fail('HEAD_STALE');
    return number;
  }
  private wallets(values: readonly string[]): string[] {
    if (!values.length || values.length > 512 || values.some(value => !ADDRESS.test(value))) fail('WATCHLIST_INVALID');
    return [...new Set(values.map(value => value.toLowerCase()))].sort();
  }
  private blockNumber(value: string): bigint { if (!UINT.test(value)) fail('CANDIDATE_INVALID'); return BigInt(value); }
  private validateContinuation(value: NFTMonitorContinuation): void {
    if (this.blockNumber(value.fromBlock) > this.blockNumber(value.toBlock) || !HASH.test(value.watchlistDigest) || !['logs', 'deployments'].includes(value.phase) || ![value.queryIndex, value.offset, value.deploymentBlockIndex].every(number => Number.isSafeInteger(number) && number >= 0) || value.queryIndex > 1536 || value.offset > 2000 || value.deploymentBlockIndex > 2 || value.rangeEndHash !== undefined && !HASH.test(value.rangeEndHash)) fail('CONTINUATION_INVALID');
  }
  private validateCandidate(value: NFTMonitorCandidate): void {
    if (value.version !== 1 || value.chainId !== this.options.chainId || !['mint', 'deployment'].includes(value.kind) || !HASH.test(value.transactionHash) || !HASH.test(value.blockHash) || !UINT.test(value.blockNumber) || value.kind === 'mint' && (!Number.isSafeInteger(value.logIndex) || value.logIndex! < 0 || !ADDRESS.test(value.contract ?? '') || !ADDRESS.test(value.wallet ?? '') || !['erc721', 'erc1155'].includes(value.standard ?? ''))) fail('CANDIDATE_INVALID');
  }
  private async call<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.signal?.aborted) fail('ABORTED');
    if (this.calls >= this.limits.maxCalls) fail('CALL_BUDGET_EXHAUSTED');
    this.calls++;
    const controller = new AbortController(); const abort = () => controller.abort();
    this.signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([read(controller.signal), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('NFT_MONITOR_RPC_TIMEOUT')); }, this.limits.callTimeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); this.signal?.removeEventListener('abort', abort); }
  }
  private safe(error: unknown): Error { return new Error(error instanceof Error && /^NFT_MONITOR_[A-Z_]{1,70}$/.test(error.message) ? error.message : 'NFT_MONITOR_RPC_UNAVAILABLE'); }
}
