import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi, toFunctionSelector, type Hex, type PublicClient } from 'viem';
import { SEADROP_MINT_TOPIC, SEADROP_V1_ADDRESS } from '@mint-bot/engine';
import { classifyMint, surveyErrorMessage, surveySeaDropMints } from './seadrop-survey.js';

const NFT_A = '0x5a5c9c3cd186d95eff4da56ce48a173c7e46455a';
const NFT_B = '0x8572dc3c69eb735c6dccc1e89d087820e51361af';
const topicFor = (address: string): Hex => `0x${'0'.repeat(24)}${address.slice(2)}` as Hex;
const publicInput = encodeFunctionData({ abi: parseAbi(['function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)']), functionName: 'mintPublic', args: [NFT_A, NFT_A, NFT_A, 1n] });
const signedSelector = toFunctionSelector('function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams, uint256 salt, bytes signature)');

describe('SeaDrop mint-method classification (T-013)', () => {
  it('recognises public, signed and allowlist mints sent to SeaDrop, and everything else as other', () => {
    expect(classifyMint(SEADROP_V1_ADDRESS, publicInput)).toBe('public');
    expect(classifyMint(SEADROP_V1_ADDRESS.toLowerCase(), `${signedSelector}${'00'.repeat(64)}`)).toBe('signed');
    expect(classifyMint(SEADROP_V1_ADDRESS, '0xdeadbeef00')).toBe('other');
    expect(classifyMint(NFT_A, publicInput)).toBe('other');
    expect(classifyMint(null, publicInput)).toBe('other');
    expect(classifyMint(SEADROP_V1_ADDRESS, '0x')).toBe('other');
  });
});

function fakeClient(logs: Array<{ tx: Hex; nft: string; block: bigint }>, inputs: Record<string, { to: string; input: string }>, options: { maxRange?: bigint; rateLimited?: boolean } = {}): { client: PublicClient; requests: Array<[bigint, bigint]> } {
  const requests: Array<[bigint, bigint]> = [];
  const client = {
    getLogs: async (request: { fromBlock: bigint; toBlock: bigint; topics: readonly Hex[] }) => {
      requests.push([request.fromBlock, request.toBlock]);
      expect(request.topics[0]).toBe(SEADROP_MINT_TOPIC);
      if (options.rateLimited) throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      if (options.maxRange !== undefined && request.toBlock - request.fromBlock + 1n > options.maxRange) throw new Error('Invalid parameters were provided to the RPC method.');
      return logs.filter((log) => log.block >= request.fromBlock && log.block <= request.toBlock).map((log) => ({ address: SEADROP_V1_ADDRESS, topics: [SEADROP_MINT_TOPIC, topicFor(log.nft), topicFor(log.nft)], transactionHash: log.tx, blockNumber: log.block }));
    },
    getTransaction: async ({ hash }: { hash: string }) => { const found = inputs[hash]; if (!found) throw new Error('not found'); return found; },
  } as unknown as PublicClient;
  return { client, requests };
}

const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

describe('surveySeaDropMints (T-013)', () => {
  it('counts methods per transaction and per contract, and reports the public share in plain words', async () => {
    const logs = [{ tx: tx(1), nft: NFT_A, block: 10n }, { tx: tx(1), nft: NFT_A, block: 10n }, { tx: tx(2), nft: NFT_A, block: 11n }, { tx: tx(3), nft: NFT_B, block: 12n }, { tx: tx(4), nft: NFT_B, block: 13n }];
    const inputs = { [tx(1)]: { to: SEADROP_V1_ADDRESS, input: publicInput }, [tx(2)]: { to: SEADROP_V1_ADDRESS, input: publicInput }, [tx(3)]: { to: SEADROP_V1_ADDRESS, input: `${signedSelector}00` }, [tx(4)]: { to: NFT_B, input: '0x1234567890' } };
    const { client } = fakeClient(logs, inputs);
    const result = await surveySeaDropMints(client, { fromBlock: 1n, toBlock: 20n });
    expect(result).toMatchObject({ mintEvents: 5, transactionsSampled: 4, sampleCapped: false, byMethod: { public: 2, signed: 1, allowlist: 0, other: 1 }, publicShare: 0.5, contracts: 2, contractsWithPublic: 1 });
    expect(result.summary).toBe('5 SeaDrop mint events in 4 sampled transaction(s): 50% public, 25% signed, 0% allowlist, 25% other. 1 of 2 contract(s) had public mints.');
    expect(result.topContracts[0]).toMatchObject({ nft: NFT_A, public: 2 });
  });

  it('caps the sample evenly across the window and says so', async () => {
    const logs = Array.from({ length: 50 }, (_, index) => ({ tx: tx(index + 1), nft: NFT_A, block: BigInt(index + 1) }));
    const inputs = Object.fromEntries(logs.map((log) => [log.tx, { to: SEADROP_V1_ADDRESS, input: publicInput }]));
    const { client } = fakeClient(logs, inputs);
    const result = await surveySeaDropMints(client, { fromBlock: 1n, toBlock: 60n, maxTransactions: 10 });
    expect(result).toMatchObject({ mintEvents: 50, transactionsSampled: 10, sampleCapped: true });
    expect(result.summary).toContain('Sample capped at 10 of 50 transactions.');
  });

  it('halves the log range when the provider rejects it, and gives up on a single rejected block without failing the survey', async () => {
    const logs = [{ tx: tx(1), nft: NFT_A, block: 5n }];
    const inputs = { [tx(1)]: { to: SEADROP_V1_ADDRESS, input: publicInput } };
    const limited = fakeClient(logs, inputs, { maxRange: 3n });
    const result = await surveySeaDropMints(limited.client, { fromBlock: 1n, toBlock: 10n, initialRange: 8n });
    expect(result.mintEvents).toBe(1);
    expect(limited.requests[0]).toEqual([1n, 8n]);
    const none = fakeClient(logs, inputs, { maxRange: 0n });
    const skipped = await surveySeaDropMints(none.client, { fromBlock: 1n, toBlock: 3n, initialRange: 2n });
    expect(skipped.skippedRanges).toBe(3);
    expect(skipped.summary).toBe('WARNING: 3 block range(s) and 0 transaction lookup(s) failed. No SeaDrop mints were found in blocks 1-3.');
  });

  it('stops and says so on rate limiting instead of hammering the provider, and refuses invalid options', async () => {
    const limited = fakeClient([], {}, { rateLimited: true });
    await expect(surveySeaDropMints(limited.client, { fromBlock: 1n, toBlock: 100n })).rejects.toThrow('SURVEY_RATE_LIMITED');
    expect(limited.requests).toHaveLength(1);
    await expect(surveySeaDropMints(fakeClient([], {}).client, { fromBlock: 10n, toBlock: 1n })).rejects.toThrow('SURVEY_OPTIONS_INVALID');
    await expect(surveySeaDropMints(fakeClient([], {}).client, { fromBlock: 1n, toBlock: 2n, maxTransactions: 0 })).rejects.toThrow('SURVEY_OPTIONS_INVALID');
  });

  it('stops with a clear message when the provider keeps rejecting single blocks, and flags partial counts', async () => {
    const broken = fakeClient([], {}, { maxRange: 0n });
    await expect(surveySeaDropMints(broken.client, { fromBlock: 1n, toBlock: 50n, initialRange: 2n })).rejects.toThrow('SURVEY_PROVIDER_KEEPS_REJECTING');
    const partial = fakeClient([{ tx: tx(1), nft: NFT_A, block: 9n }], { [tx(1)]: { to: SEADROP_V1_ADDRESS, input: publicInput } }, { maxRange: 1n });
    const ok = await surveySeaDropMints(partial.client, { fromBlock: 1n, toBlock: 10n, initialRange: 4n });
    expect(ok.skippedRanges).toBe(0);
    expect(ok.summary).not.toContain('WARNING');
  });

  it('counts failed transaction lookups separately instead of calling them other, and never prints an RPC URL or key', async () => {
    const fake = fakeClient([{ tx: tx(1), nft: NFT_A, block: 2n }, { tx: tx(2), nft: NFT_A, block: 3n }], { [tx(1)]: { to: SEADROP_V1_ADDRESS, input: publicInput } });
    const result = await surveySeaDropMints(fake.client, { fromBlock: 1n, toBlock: 5n });
    expect(result).toMatchObject({ transactionsSampled: 1, lookupFailures: 1, byMethod: { public: 1, other: 0 } });
    expect(result.summary).toContain('WARNING');
    const leaky = new Error('HTTP request failed.\n\nURL: https://eth-mainnet.example.com/v2/abcdefghijklmnopqrstuvwxyz0123456789\nRequest body: {}');
    expect(surveyErrorMessage(leaky)).not.toMatch(/example\.com|abcdefghijklmnop|https?:/);
    const refused = Object.assign(new Error('HTTP request failed.\n\nURL: https://secret.example/abc'), { name: 'HttpRequestError', cause: Object.assign(new Error('fetch failed https://secret.example'), { code: 'ENOTFOUND' }) });
    expect(surveyErrorMessage(refused)).toBe('SURVEY_FAILED: HTTP request failed. [HttpRequestError, ENOTFOUND]');
    expect(surveyErrorMessage(new Error('SURVEY_RATE_LIMITED: HTTP 429: Too Many Requests'))).toBe('SURVEY_RATE_LIMITED: HTTP 429: Too Many Requests');
    expect(surveyErrorMessage(new Error('RPC_MUST_BE_HTTPS'))).toBe('RPC_MUST_BE_HTTPS');
    expect(surveyErrorMessage(new Error('ROBINHOOD_RPC_UNAVAILABLE'))).toBe('ROBINHOOD_RPC_UNAVAILABLE');
    expect(surveyErrorMessage(new Error('URL: https://secret.example/key1234567890123456789012345678901234'))).toMatch(/^SURVEY_FAILED/);
  });
});
