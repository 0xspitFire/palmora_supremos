import { baseReceiptFees } from '@mint-bot/engine';
import type { Address, Hash } from 'viem';

export interface TreasuryReturnInput {
  target: { chainId: number; address: string };
  baseline: { nonce: number; balanceWei: string; observedAt: string };
  reading: { nonce: number; balanceWei: bigint };
  ledger: { knownNextNonce: number | undefined; allowedFallWei: bigint };
  approvedRecipients: readonly string[];
  /** Aggregate fee allowance for the entire unexplained nonce interval. */
  feeAllowanceWei: bigint;
}

/** Standard RPC methods only. Both clients must be independently configured by the caller. */
export interface TreasuryReturnClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint; includeTransactions: true }): Promise<unknown>;
  getTransactionCount(args: { address: Address; blockNumber: bigint }): Promise<number>;
  getBalance(args: { address: Address; blockNumber: bigint }): Promise<bigint>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<unknown>;
  getTransactionReceipt(args: { hash: Hash }): Promise<unknown>;
}

export interface TreasuryReturnProof {
  chainId: number;
  address: string;
  fromNonce: number;
  /** Exclusive upper bound, equal to the observed nonce. */
  toNonce: number;
  nonce: number;
  balanceWei: bigint;
  baselineNonce: number;
  baselineBalanceWei: string;
  baselineObservedAt: string;
  hashes: string[];
  blockNumber: bigint;
  blockHash: string;
  totalValueWei: bigint;
  totalFeeWei: bigint;
}

type ObjectValue = Record<string, unknown>;
const MAX_LOOKBACK = 65_536n;
const MAX_GAP = 8;
const MAX_UINT256 = (1n << 256n) - 1n;
const addressPattern = /^0x[0-9a-f]{40}$/i;
const hashPattern = /^0x[0-9a-f]{64}$/i;
function requireProof(value: unknown): asserts value { if (!value) throw new Error('TREASURY_RETURN_NOT_PROVEN'); }
function object(value: unknown): ObjectValue {
  requireProof(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}
function lower(value: unknown): string { requireProof(typeof value === 'string'); return value.toLowerCase(); }
function amount(value: unknown): bigint {
  requireProof(typeof value === 'bigint' && value >= 0n && value <= MAX_UINT256);
  return value;
}
function quantity(value: unknown): bigint {
  if (typeof value === 'bigint') return amount(value);
  requireProof(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value));
  return amount(BigInt(value));
}
function nonce(value: unknown): number { requireProof(Number.isSafeInteger(value) && Number(value) >= 0); return value as number; }
function hash(value: unknown): string { const result = lower(value); requireProof(hashPattern.test(result)); return result; }
function addr(value: unknown): string { const result = lower(value); requireProof(addressPattern.test(result) && BigInt(result) !== 0n); return result; }
function emptyCode(value: unknown): boolean { return value === '0x'; }
function stable(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (typeof v === 'bigint') return { bigint: v.toString() };
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v)
      .filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, normalize(field)]));
    return v;
  };
  return JSON.stringify(normalize(value));
}

/**
 * Produces an exemption only for a complete, corroborated interval of successful plain
 * native-currency returns. Missing archive history or incomplete L2 fees are a refusal,
 * leaving the normal watcher and manual owner acknowledgement available.
 */
export async function verifyTrustedTreasuryReturns(
  input: TreasuryReturnInput,
  clients: readonly TreasuryReturnClient[],
  now: () => Date = () => new Date(),
): Promise<TreasuryReturnProof | undefined> {
  try {
    requireProof(clients.length === 2 && clients[0] !== clients[1]);
    // Independent of the injectable chain-freshness clock. The wrapper additionally
    // configures finite per-request timeouts; no new request starts after this budget.
    const deadline = Date.now() + 20_000;
    const bounded = async <T>(request: () => Promise<T>): Promise<T> => {
      requireProof(Date.now() < deadline);
      const result = await request();
      requireProof(Date.now() < deadline);
      return result;
    };
    const boundedClients: TreasuryReturnClient[] = clients.map(client => ({
      getChainId: () => bounded(() => client.getChainId()),
      getBlockNumber: () => bounded(() => client.getBlockNumber()),
      getBlock: args => bounded(() => client.getBlock(args)),
      getTransactionCount: args => bounded(() => client.getTransactionCount(args)),
      getBalance: args => bounded(() => client.getBalance(args)),
      getCode: args => bounded(() => client.getCode(args)),
      getTransactionReceipt: args => bounded(() => client.getTransactionReceipt(args)),
    }));
    const address = addr(input.target.address) as Address;
    requireProof([1, 8453, 4663].includes(input.target.chainId));
    const start = Math.max(nonce(input.baseline.nonce), nonce(input.ledger.knownNextNonce ?? input.baseline.nonce));
    const end = nonce(input.reading.nonce);
    requireProof(end > start && end - start <= MAX_GAP);
    requireProof(/^(0|[1-9][0-9]*)$/.test(input.baseline.balanceWei));
    const baselineBalance = amount(BigInt(input.baseline.balanceWei));
    amount(input.reading.balanceWei);
    amount(input.ledger.allowedFallWei);
    amount(input.feeAllowanceWei);
    const baselineTime = Date.parse(input.baseline.observedAt);
    requireProof(Number.isFinite(baselineTime));
    const recipients = new Set(input.approvedRecipients.map(addr));
    requireProof(recipients.size > 0);
    const heads = await Promise.all(boundedClients.map(async client => {
      requireProof(await client.getChainId() === input.target.chainId);
      return amount(await client.getBlockNumber());
    }));
    const minHead = heads.reduce((a, b) => a < b ? a : b);
    requireProof(minHead >= 2n);
    const blockNumber = minHead - 2n;
    const firstBlock = blockNumber > MAX_LOOKBACK ? blockNumber - MAX_LOOKBACK : 0n;

    const views = await Promise.all(boundedClients.map(async client => {
      const counts = new Map<bigint, number>();
      const blocks = new Map<bigint, ObjectValue>();
      const countAt = async (number: bigint): Promise<number> => {
        if (!counts.has(number)) counts.set(number, nonce(await client.getTransactionCount({ address, blockNumber: number })));
        return counts.get(number)!;
      };
      const blockAt = async (number: bigint): Promise<ObjectValue> => {
        if (!blocks.has(number)) {
          const block = object(await client.getBlock({ blockNumber: number, includeTransactions: true }));
          requireProof(block.number === number && Array.isArray(block.transactions));
          hash(block.hash);
          amount(block.timestamp);
          blocks.set(number, block);
        }
        return blocks.get(number)!;
      };
      const common = await blockAt(blockNumber);
      requireProof(await countAt(blockNumber) === end && await countAt(firstBlock) <= start);
      const balance = amount(await client.getBalance({ address, blockNumber }));
      requireProof(balance === input.reading.balanceWei && emptyCode(await client.getCode({ address, blockNumber })));
      let totalValueWei = 0n;
      let totalFeeWei = 0n;
      const transactions: ObjectValue[] = [];
      for (let n = start; n < end; n++) {
        // Locate the first block after this nonce was consumed, using archive state.
        let low = firstBlock;
        let high = blockNumber;
        requireProof(await countAt(low) <= n && await countAt(high) > n);
        for (let step = 0; low + 1n < high && step < 17; step++) {
          const middle = (low + high) / 2n;
          const count = await countAt(middle);
          requireProof(count >= await countAt(low) && count <= await countAt(high));
          if (count > n) high = middle; else low = middle;
        }
        requireProof(low + 1n === high && await countAt(low) <= n && await countAt(high) > n);
        const block = await blockAt(high);
        const matching = (block.transactions as unknown[]).map(object).filter(tx => lower(tx.from) === address && tx.nonce === n);
        requireProof(matching.length === 1);
        const tx = matching[0]!;
        const txHash = hash(tx.hash);
        const to = addr(tx.to) as Address;
        requireProof(recipients.has(to) && to !== address);
        requireProof(tx.blockNumber === high && hash(tx.blockHash) === hash(block.hash));
        requireProof(tx.chainId === input.target.chainId && nonce(tx.nonce) === n && tx.input === '0x');
        requireProof(['legacy', 'eip2930', 'eip1559', '0x0', '0x1', '0x2'].includes(String(tx.type)));
        requireProof(tx.authorizationList === undefined && tx.blobVersionedHashes === undefined && tx.maxFeePerBlobGas === undefined);
        requireProof(tx.accessList === undefined || Array.isArray(tx.accessList) && tx.accessList.length === 0);
        const value = amount(tx.value);
        requireProof(value > 0n);
        const receipt = object(await client.getTransactionReceipt({ hash: txHash as Hash }));
        requireProof(hash(receipt.transactionHash) === txHash && receipt.blockNumber === high && hash(receipt.blockHash) === hash(block.hash));
        requireProof(addr(receipt.from) === address && addr(receipt.to) === to && receipt.status === 'success' && receipt.contractAddress === null);
        const gasUsed = amount(receipt.gasUsed);
        const effectiveGasPrice = amount(receipt.effectiveGasPrice);
        requireProof(receipt.blobGasUsed === undefined && receipt.blobGasPrice === undefined);
        // No calldata or access list and both accounts are EOAs: an ordinary transfer is 21,000 gas.
        requireProof(gasUsed === 21_000n && gasUsed <= amount(tx.gas));
        if (tx.type === 'eip1559' || tx.type === '0x2') requireProof(effectiveGasPrice <= amount(tx.maxFeePerGas));
        else requireProof(effectiveGasPrice === amount(tx.gasPrice));
        requireProof(emptyCode(await client.getCode({ address: to, blockNumber: high })));
        requireProof(emptyCode(await client.getCode({ address: to, blockNumber })));
        requireProof(emptyCode(await client.getCode({ address, blockNumber: high })));
        let l1Fee = 0n;
        let operatorFee = 0n;
        // Blob/deposit/custom fee-bearing transactions never qualify. Unknown extra fee fields do not get ignored.
        for (const [key, field] of Object.entries(receipt)) {
          if (/fee/i.test(key) && !['effectiveGasPrice', 'l1Fee', 'l1DataFee', 'operatorFee', 'l1FeeScalar', 'l1BaseFeeScalar', 'l1BlobBaseFeeScalar', 'operatorFeeScalar', 'operatorFeeConstant'].includes(key)) {
            requireProof(field === undefined || field === null || field === 0n || field === '0x0');
          }
        }
        if (input.target.chainId === 8453) {
          const fees = baseReceiptFees(receipt, gasUsed);
          l1Fee = fees.l1DataFeeWei;
          operatorFee = fees.operatorFeeWei;
        } else if (input.target.chainId === 4663) {
          // An explicit charge is required: absent L2 fee data cannot establish the full wallet cost.
          requireProof(receipt.l1Fee !== undefined || receipt.l1DataFee !== undefined);
          l1Fee = quantity(receipt.l1DataFee ?? receipt.l1Fee);
          if (receipt.l1Fee !== undefined) requireProof(quantity(receipt.l1Fee) === l1Fee);
          operatorFee = receipt.operatorFee === undefined ? 0n : quantity(receipt.operatorFee);
          requireProof(receipt.operatorFeeScalar === undefined && receipt.operatorFeeConstant === undefined || receipt.operatorFee !== undefined);
        } else {
          for (const key of ['l1Fee', 'l1DataFee', 'operatorFee', 'operatorFeeScalar', 'operatorFeeConstant']) requireProof(receipt[key] === undefined);
        }
        const fee = gasUsed * effectiveGasPrice + l1Fee + operatorFee;
        totalValueWei += value;
        totalFeeWei += fee;
        requireProof(totalFeeWei <= input.feeAllowanceWei);
        transactions.push({
          hash: txHash, nonce: n, blockNumber: high, blockHash: hash(block.hash), from: address, to,
          chainId: tx.chainId, type: tx.type, input: tx.input, value, gas: tx.gas,
          gasPrice: tx.gasPrice, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          gasUsed, effectiveGasPrice, l1Fee, operatorFee,
          // Corroborate the complete responses, including metadata we do not use to
          // calculate the exemption. Schema differences conservatively refuse it.
          transactionResponse: tx, receiptResponse: receipt,
        });
      }
      const finalBlock = object(await client.getBlock({ blockNumber, includeTransactions: true }));
      requireProof(hash(finalBlock.hash) === hash(common.hash));
      return { blockHash: hash(common.hash), timestamp: amount(common.timestamp), balance, transactions, totalValueWei, totalFeeWei };
    }));
    requireProof(stable(views[0]) === stable(views[1]));
    requireProof(Date.now() < deadline);
    const view = views[0]!;
    const nowMs = now().getTime();
    requireProof(Number.isFinite(nowMs) && baselineTime <= nowMs);
    const ageMs = nowMs - Number(view.timestamp) * 1000;
    requireProof(ageMs >= 0 && ageMs <= 300_000);
    const fall = baselineBalance > input.reading.balanceWei ? baselineBalance - input.reading.balanceWei : 0n;
    requireProof(fall <= view.totalValueWei + view.totalFeeWei + input.ledger.allowedFallWei);
    return {
      chainId: input.target.chainId, address, fromNonce: start, toNonce: end,
      nonce: end, balanceWei: input.reading.balanceWei,
      baselineNonce: input.baseline.nonce, baselineBalanceWei: input.baseline.balanceWei, baselineObservedAt: input.baseline.observedAt,
      hashes: view.transactions.map(tx => String(tx.hash)), blockNumber, blockHash: view.blockHash,
      totalValueWei: view.totalValueWei, totalFeeWei: view.totalFeeWei,
    };
  } catch { return undefined; }
}
