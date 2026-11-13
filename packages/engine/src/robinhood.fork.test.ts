import { beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, decodeFunctionData, encodeFunctionData, http, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildSignedMint, signedMintTypedData, verifySignedWalletAuthorization, type SignedMintAuthorityClient, type SignedWalletAuthorization } from './signed-mint-authority.js';
import { ROBINHOOD_SEADROP_POSITIVE_FIXTURE } from './robinhood-evidence.js';
import { getChainConfig } from './chains.js';

/**
 * Real archive-backed Robinhood replay suite. The fork endpoint must be an
 * Anvil instance started from the approved archive reference. This suite uses
 * only unlocked local Anvil accounts for local zero-value replacement/reorg
 * mechanics; it never signs or broadcasts to Robinhood itself.
 */

type Rpc = (method: string, params?: unknown[]) => Promise<any>;
let fork: Rpc;
let setupError: Error | undefined;
const replayEnabled = process.env.MINT_BOT_FORK_REPLAY === 'true';
const rpcUrl = process.env.ANVIL_ROBINHOOD_RPC_URL ?? process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const forkBlockText = process.env.ROBINHOOD_FORK_BLOCK;
const nft = process.env.ROBINHOOD_SEADROP_NFT;
const feeRecipient = process.env.ROBINHOOD_SEADROP_FEE_RECIPIENT;
const mintValueWei = process.env.ROBINHOOD_SEADROP_MINT_VALUE_WEI;
const mintSignedAbi = [{
  type: 'function',
  name: 'mintSigned',
  stateMutability: 'payable',
  inputs: [
    { name: 'nftContract', type: 'address' },
    { name: 'feeRecipient', type: 'address' },
    { name: 'minterIfNotPayer', type: 'address' },
    { name: 'quantity', type: 'uint256' },
    {
      name: 'mintParams',
      type: 'tuple',
      components: [
        { name: 'mintPrice', type: 'uint256' },
        { name: 'maxTotalMintableByWallet', type: 'uint256' },
        { name: 'startTime', type: 'uint256' },
        { name: 'endTime', type: 'uint256' },
        { name: 'dropStageIndex', type: 'uint256' },
        { name: 'maxTotalMintableByWalletPerStage', type: 'uint256' },
        { name: 'feeBps', type: 'uint256' },
        { name: 'restrictFeeRecipients', type: 'bool' },
      ],
    },
    { name: 'salt', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
  outputs: [],
}] as const;

async function localEoaAccounts(): Promise<string[]> {
  const accounts = await fork('eth_accounts') as string[];
  const code = await Promise.all(accounts.map((account) => fork('eth_getCode', [account, 'latest'])));
  return accounts.filter((_, index) => code[index] === '0x');
}

async function makeRpc(url: string): Promise<Rpc> {
  let id = 0;
  return async (method, params = []) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? `RPC error: ${method}`);
    return body.result;
  };
}

function requireSetup(): void {
  if (setupError) throw new Error(`Archive-backed Robinhood fork unavailable: ${setupError.message}`);
}

describe.skipIf(!replayEnabled || !forkBlockText || !nft || !feeRecipient || !mintValueWei)('Robinhood archive-backed fork replay', () => {
  beforeAll(async () => {
    try {
      const parsedUrl = new URL(rpcUrl);
      if (parsedUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname)) {
        throw new Error('ANVIL_ROBINHOOD_RPC_URL must target loopback Anvil');
      }
      if (!/^\d+$/.test(forkBlockText!)) throw new Error('ROBINHOOD_FORK_BLOCK must be a decimal block number');
      if (!/^0x[0-9a-fA-F]{40}$/.test(nft!) || !/^0x[0-9a-fA-F]{40}$/.test(feeRecipient!)) throw new Error('Robinhood NFT and fee-recipient inputs must be addresses');
      if (!/^\d+$/.test(mintValueWei!)) throw new Error('ROBINHOOD_SEADROP_MINT_VALUE_WEI must be an integer');
      if (BigInt(forkBlockText!) < ROBINHOOD_SEADROP_POSITIVE_FIXTURE.blockNumber) throw new Error('ROBINHOOD_FORK_BLOCK must include the approved positive fixture');
      fork = await makeRpc(rpcUrl);
      let client: string;
      try {
        client = await fork('web3_clientVersion') as string;
      } catch {
        throw new Error('Anvil fork endpoint unreachable');
      }
      if (!client.toLowerCase().includes('anvil')) throw new Error('Local Robinhood endpoint is not Anvil');
      const chainId = await fork('eth_chainId');
      if (chainId !== '0x1237') throw new Error('Fork chain mismatch: expected 4663');
    } catch (error) {
      setupError = error instanceof Error ? error : new Error('fork setup failed');
    }
  });

  it('replays the historical positive SeaDrop transaction and receipt', async () => {
    requireSetup();
    const historicalBlock = `0x${ROBINHOOD_SEADROP_POSITIVE_FIXTURE.blockNumber.toString(16)}`;
    const block = await fork('eth_getBlockByNumber', [historicalBlock, false]);
    expect(block).not.toBeNull();
    const receipt = await fork('eth_getTransactionReceipt', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    const tx = await fork('eth_getTransactionByHash', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(receipt?.status).toBe('0x1');
    expect(receipt?.transactionHash.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash.toLowerCase());
    expect(tx?.chainId).toBe('0x1237');
    expect(tx?.from.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.wallet.toLowerCase());
    expect(tx?.to.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.seaDropAddress.toLowerCase());
    expect(BigInt(tx?.value)).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.mintAmountWei);
    expect(typeof tx?.input).toBe('string');
    expect(tx?.input.length).toBeGreaterThan(10);
    expect(nft?.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.nftContract.toLowerCase());
    expect(BigInt(mintValueWei!)).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.mintAmountWei);
    const decoded = decodeFunctionData({ abi: mintSignedAbi, data: tx.input as Hex });
    expect(decoded.functionName).toBe('mintSigned');
    expect(decoded.args?.[0].toLowerCase()).toBe(nft?.toLowerCase());
    expect(decoded.args?.[1].toLowerCase()).toBe(feeRecipient?.toLowerCase());
    expect(decoded.args?.[3]).toBe(1n);
    expect(decoded.args?.[6]).toMatch(/^0x[0-9a-fA-F]+$/);
    expect((decoded.args?.[6] as string).length).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.signatureHexLength);
    expect(receipt?.from.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.wallet.toLowerCase());
    expect(receipt?.blockNumber).toBe(historicalBlock);
  });

  it('replays a failed signed-mint call with an invalid value without writing state', async () => {
    requireSetup();
    const tx = await fork('eth_getTransactionByHash', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(tx).not.toBeNull();
    expect(tx?.chainId).toBe('0x1237');
    expect(tx?.from.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.wallet.toLowerCase());
    expect(tx?.to.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.seaDropAddress.toLowerCase());
    expect(tx?.input.length).toBeGreaterThan(10);
    await expect(fork('eth_call', [{
      from: tx.from,
      to: tx.to,
      data: tx.input,
      value: '0x1',
    }, tx.blockNumber])).rejects.toThrow();
  });

  it('replays duplicate submission semantics as a failed call after the positive mint', async () => {
    requireSetup();
    const tx = await fork('eth_getTransactionByHash', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(tx).not.toBeNull();
    expect(tx?.chainId).toBe('0x1237');
    expect(tx?.to.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.seaDropAddress.toLowerCase());
    await expect(fork('eth_call', [{
      from: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
    }, 'latest'])).rejects.toThrow();
  });

  it('verifies and consumes a fresh own-wallet server authorization on the real SeaDrop fork', async () => {
    requireSetup();
    // All mutations below are sent only through the beforeAll-checked loopback
    // Anvil. Impersonation and the ephemeral issuer never touch production.
    const snapshot = await fork('evm_snapshot');
    const nftAddress = nft as Address;
    const seaDrop = ROBINHOOD_SEADROP_POSITIVE_FIXTURE.seaDropAddress as Address;
    const recipient = feeRecipient as Address;
    const ownerAbi = parseAbi([
      'function owner() view returns (address)',
      'function getMintStats(address minter) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)',
      'function updateSignedMintValidationParams(address seaDropImpl,address signer,(uint80 minMintPrice,uint24 maxMaxTotalMintableByWallet,uint40 minStartTime,uint40 maxEndTime,uint40 maxMaxTokenSupplyForStage,uint16 minFeeBps,uint16 maxFeeBps) signedMintValidationParams)',
      'function updateAllowedFeeRecipient(address seaDropImpl,address feeRecipient,bool allowed)',
      'function getFeeRecipientIsAllowed(address nftContract,address feeRecipient) view returns (bool)',
    ]);
    const publicClient = () => createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }), cacheTime: 0 });
    const first = publicClient(); const second = publicClient();
    let owner: Address | undefined;
    try {
      // The archived L2 fork header omits Ethereum blob fields. Mine local
      // headers before executing calls in Anvil's EVM; no chain state is patched.
      await fork('anvil_mine', ['0x2']);
      owner = await first.readContract({ address: nftAddress, abi: ownerAbi, functionName: 'owner' });
      if (owner.toLowerCase() === zeroAddress) throw new Error('SIGNED_FORK_FIXTURE_OWNER_RENOUNCED');
      const accounts = await localEoaAccounts();
      expect(accounts.length).toBeGreaterThan(0);
      const minter = accounts[0] as Address;
      const stats = await first.readContract({ address: nftAddress, abi: ownerAbi, functionName: 'getMintStats', args: [minter] });
      expect(stats[1] + 1n).toBeLessThanOrEqual(stats[2]);
      const issuer = privateKeyToAccount(generatePrivateKey());
      const latest = await first.getBlock();
      const startTime = latest.timestamp - 1n;
      const endTime = latest.timestamp + 3600n;
      const stageSupply = stats[2];
      if (stageSupply >= 2n ** 40n) throw new Error('SIGNED_FORK_FIXTURE_SUPPLY_EXCEEDS_SIGNER_BOUND');
      await fork('anvil_impersonateAccount', [owner]);
      await fork('anvil_setBalance', [owner, '0x56bc75e2d63100000']);
      const gasPrice = await fork('eth_gasPrice');
      const configure = async (data: Hex): Promise<void> => {
        const tx = await fork('eth_sendTransaction', [{ from: owner, to: nftAddress, value: '0x0', gas: '0xf4240', gasPrice, data }]);
        await fork('evm_mine');
        const receipt = await fork('eth_getTransactionReceipt', [tx]);
        expect(receipt?.status).toBe('0x1');
      };
      // Exact owner forwarders from ProjectOpenSea/seadrop ERC721SeaDrop.sol,
      // not storage edits or a mocked signature-verification contract.
      await configure(encodeFunctionData({ abi: ownerAbi, functionName: 'updateSignedMintValidationParams', args: [seaDrop, issuer.address, { minMintPrice: 0n, maxMaxTotalMintableByWallet: 10, minStartTime: Number(startTime), maxEndTime: Number(endTime), maxMaxTokenSupplyForStage: Number(stageSupply), minFeeBps: 0, maxFeeBps: 1000 }] }));
      const feeAlreadyAllowed = await first.readContract({ address: seaDrop, abi: ownerAbi, functionName: 'getFeeRecipientIsAllowed', args: [nftAddress, recipient] });
      if (!feeAlreadyAllowed) await configure(encodeFunctionData({ abi: ownerAbi, functionName: 'updateAllowedFeeRecipient', args: [seaDrop, recipient, true] }));
      // Both authority readers select min(head)-2, so include both updates in it.
      await fork('anvil_mine', ['0x2']);
      const current = await first.getBlock();
      const now = new Date(Number(current.timestamp) * 1000);
      const raw: SignedWalletAuthorization = { chainId: 4663, nftContract: nftAddress, wallet: minter, feeRecipient: recipient, mintParams: { mintPrice: 0n, maxTotalMintableByWallet: 10n, startTime, endTime, dropStageIndex: 1n, maxTokenSupplyForStage: stageSupply, feeBps: 250n, restrictFeeRecipients: true }, salt: 115n, signature: '0x', source: { chainId: 4663, nftContract: nftAddress, wallet: minter, stageIndex: '1', sourceId: 'loopback-fork-platform-fixture', contentDigest: `sha256:${'0'.repeat(64)}` } };
      raw.signature = await issuer.signTypedData(signedMintTypedData(raw));
      const clients = [first, second] as unknown as SignedMintAuthorityClient[];
      const proof = await verifySignedWalletAuthorization(raw, clients, 1, now);
      expect(proof.signer).toBe(issuer.address);
      const ownMint = buildSignedMint(proof, minter, 1, now);
      expect(ownMint.data.slice(0, 10)).toBe('0x4b61cd6f');
      await expect(fork('eth_call', [{ from: minter, to: ownMint.to, data: ownMint.data, value: '0x0' }, 'latest'])).resolves.toBe('0x');
      const txHash = await fork('eth_sendTransaction', [{ from: minter, to: ownMint.to, data: ownMint.data, value: '0x0', gas: '0x7a120', gasPrice }]);
      await fork('evm_mine');
      const receipt = await fork('eth_getTransactionReceipt', [txHash]);
      expect(receipt?.status).toBe('0x1');
      const after = await first.readContract({ address: nftAddress, abi: ownerAbi, functionName: 'getMintStats', args: [minter] });
      expect(after[0]).toBe(stats[0] + 1n);
      expect(after[1]).toBe(stats[1] + 1n);
      // This rejects through the real contract's consumed-digest check even
      // while the common-block snapshot still precedes the local mint.
      await expect(verifySignedWalletAuthorization(raw, clients, 1, now)).rejects.toThrow('SIGNED_MINT_AUTHORITY_UNAVAILABLE');
    } finally {
      if (owner && owner.toLowerCase() !== zeroAddress) await fork('anvil_stopImpersonatingAccount', [owner]);
      expect(await fork('evm_revert', [snapshot])).toBe(true);
    }
  }, 120_000);

  it('records a replacement outcome using local Anvil accounts only', async () => {
    requireSetup();
    const accounts = await localEoaAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    const from = accounts[0];
    await fork('evm_setAutomine', [false]);
    try {
      const nonceHex = await fork('eth_getTransactionCount', [from, 'pending']);
      const first = await fork('eth_sendTransaction', [{ from, to: from, value: '0x0', gas: '0x5208', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x3b9aca00', nonce: nonceHex }]);
      const replacement = await fork('eth_sendTransaction', [{ from, to: from, value: '0x0', gas: '0x5208', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x77359400', nonce: nonceHex }]);
      expect(replacement).not.toBe(first);
      await fork('anvil_mine', ["0x1"]);
      const firstReceipt = await fork('eth_getTransactionReceipt', [first]);
      const replacementReceipt = await fork('eth_getTransactionReceipt', [replacement]);
      expect(Boolean(firstReceipt) !== Boolean(replacementReceipt)).toBe(true);
    } finally {
      await fork('evm_setAutomine', [true]);
    }
  });

  it('replays receipt disappearance across an Anvil reorg', async () => {
    requireSetup();
    const accounts = await localEoaAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    const from = accounts[0];
    const snapshot = await fork('evm_snapshot');
    const gasPrice = await fork('eth_gasPrice');
    // Use a plain recipient. Forked Anvil accounts may carry EIP-7702 code;
    // sending to that account as the recipient would execute delegated code
    // and turn this neutral reorg probe into an unrelated contract revert.
    const recipient = '0x000000000000000000000000000000000000dEaD';
    const hash = await fork('eth_sendTransaction', [{ from, to: recipient, value: '0x0', gas: '0x5208', gasPrice }]);
    // The approved Anvil invocation may run with automine disabled; explicitly
    // mine so the test proves receipt disappearance rather than pending state.
    await fork('evm_mine');
    const beforeReorg = await fork('eth_getTransactionReceipt', [hash]);
    expect(beforeReorg?.status).toBe('0x1');
    await fork('evm_revert', [snapshot]);
    const afterReorg = await fork('eth_getTransactionReceipt', [hash]);
    expect(afterReorg).toBeNull();
  });

  it('captures the staged-finality replay anchor without claiming finality', async () => {
    requireSetup();
    const receipt = await fork('eth_getTransactionReceipt', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(receipt?.blockNumber).toBeDefined();
    const block = await fork('eth_getBlockByNumber', [receipt.blockNumber, false]);
    expect(block?.hash).toBeDefined();
    const policy = getChainConfig(4663).finalityPolicy;
    expect(policy.stages).toEqual(['soft', 'posted', 'ethereum_final']);
  });
});
