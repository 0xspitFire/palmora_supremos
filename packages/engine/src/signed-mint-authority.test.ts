import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, hashTypedData, keccak256, parseAbiParameters, concatHex, stringToHex, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildSignedMint, SIGNED_MINT_ABI, signedMintTypedData, verifySignedWalletAuthorization, type SignedMintAuthorityClient, type SignedWalletAuthorization } from './signed-mint-authority.js';
import { SEADROP_V1_ADDRESS } from './chains.js';
import { SeaDropV1SignedStrategy } from './strategies/seadrop-v1-signed.js';

const now = new Date('2026-11-07T00:00:00Z');
const seconds = BigInt(Math.floor(now.getTime() / 1000));
const wallet = '0x1111111111111111111111111111111111111111' as Address;
const other = '0x2222222222222222222222222222222222222222' as Address;
const nftContract = '0x3333333333333333333333333333333333333333' as Address;
const feeRecipient = '0x4444444444444444444444444444444444444444' as Address;
const blockHash = `0x${'a'.repeat(64)}` as Hex;
const issuer = privateKeyToAccount(generatePrivateKey());
async function input(): Promise<SignedWalletAuthorization> {
  const value: SignedWalletAuthorization = { chainId: 4663, nftContract, wallet, feeRecipient, mintParams: { mintPrice: 0n, maxTotalMintableByWallet: 10n, startTime: seconds - 60n, endTime: seconds + 600n, dropStageIndex: 1n, maxTokenSupplyForStage: 1000n, feeBps: 250n, restrictFeeRecipients: true }, salt: 123n, signature: '0x', source: { chainId: 4663, nftContract, wallet, stageIndex: '1', sourceId: 'official-platform', contentDigest: `sha256:${'a'.repeat(64)}` } };
  value.signature = await issuer.signTypedData(signedMintTypedData(value));
  return value;
}
function client(changes: { chain?: number; hash?: Hex; age?: bigint; bounds?: bigint[]; fee?: boolean; stats?: bigint[]; callError?: Error } = {}): SignedMintAuthorityClient {
  return { getBlockNumber: vi.fn(async () => 100n), getChainId: async () => changes.chain ?? 4663, getBlock: vi.fn(async () => ({ hash: changes.hash ?? blockHash, timestamp: seconds - (changes.age ?? 0n) })), readContract: vi.fn(async (request) => {
    if (request.functionName === 'getFeeRecipientIsAllowed') return changes.fee ?? true;
    if (request.functionName === 'getMintStats') return changes.stats ?? [0n, 100n, 2000n];
    if (request.args[1]?.toLowerCase() !== issuer.address.toLowerCase()) return [0n, 0n, 0n, 0n, 0n, 0n, 0n];
    return changes.bounds ?? [0n, 10n, seconds - 120n, seconds + 3600n, 1000n, 0n, 1000n];
  }), call: vi.fn(async () => { if (changes.callError) throw changes.callError; return { data: '0x' as Hex }; }) };
}
const verify = (value: SignedWalletAuthorization, first = client(), second = client()) => verifySignedWalletAuthorization(value, [first, second], 2, now);

describe('bounded free SeaDrop server-signed authorization', () => {
  it('recovers the approved signer and builds only the own wallet mintSigned call after two common-block checks', async () => {
    const value = await input();
    const first = client(); const second = client();
    const proof = await verify(value, first, second);
    expect(proof.signer).toBe(issuer.address);
    const call = buildSignedMint(proof, wallet, 2, now);
    expect(call.to).toBe(SEADROP_V1_ADDRESS);
    expect(call.value).toBe(0n);
    expect(call.data.slice(0, 10)).toBe('0x4b61cd6f');
    const decoded = decodeFunctionData({ abi: SIGNED_MINT_ABI, data: call.data });
    expect(decoded.functionName).toBe('mintSigned');
    expect(decoded.args[2]).toBe('0x0000000000000000000000000000000000000000');
    expect(decoded.args[3]).toBe(2n);
    for (const provider of [first, second]) {
      expect(provider.getBlock).toHaveBeenCalledWith({ blockNumber: 98n });
      expect(provider.call).toHaveBeenCalledWith({ account: wallet, to: SEADROP_V1_ADDRESS, data: call.data, value: 0n, blockNumber: 98n });
    }
    expect(Object.isFrozen(proof.mintParams)).toBe(true);
  });
  it('matches Solidity abi.encode EIP712 digest rather than relying on a custom signing format', async () => {
    const value = await input(); const p = value.mintParams;
    const mintType = keccak256(stringToHex('MintParams(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)'));
    const signedType = keccak256(stringToHex('SignedMint(address nftContract,address minter,address feeRecipient,MintParams mintParams,uint256 salt)MintParams(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)'));
    const paramsHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool'), [mintType, p.mintPrice, p.maxTotalMintableByWallet, p.startTime, p.endTime, p.dropStageIndex, p.maxTokenSupplyForStage, p.feeBps, p.restrictFeeRecipients]));
    const structHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,address,address,address,bytes32,uint256'), [signedType, value.nftContract, value.wallet, value.feeRecipient, paramsHash, value.salt]));
    const domain = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,bytes32,uint256,address'), [keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(stringToHex('SeaDrop')), keccak256(stringToHex('1.0')), 4663n, SEADROP_V1_ADDRESS]));
    expect(hashTypedData(signedMintTypedData(value))).toBe(keccak256(concatHex(['0x1901', domain, structHash])));
  });
  it.each(['wallet', 'nftContract', 'feeRecipient', 'salt', 'chainId'] as const)('rejects a signature replay with a changed %s', async (field) => {
    const value = await input();
    const changed = { ...value, [field]: field === 'salt' ? 124n : field === 'chainId' ? 1 : other } as SignedWalletAuthorization;
    if (field === 'wallet' || field === 'nftContract' || field === 'chainId') changed.source = { ...changed.source, [field]: changed[field] };
    await expect(verify(changed)).rejects.toThrow(/SIGNED_MINT_/);
  });
  it('rejects changed parameters and a consumed digest without exposing provider details', async () => {
    const value = await input();
    await expect(verify({ ...value, mintParams: { ...value.mintParams, maxTotalMintableByWallet: 9n } })).rejects.toThrow('SIGNED_MINT_SIGNER_BOUNDS_INVALID');
    await expect(verify(value, client({ callError: new Error('SignatureAlreadyUsed https://rpc.example/synthetic-marker') }), client())).rejects.toThrow(/^SIGNED_MINT_AUTHORITY_UNAVAILABLE$/);
  });
  it.each([
    { mintPrice: 1n }, { restrictFeeRecipients: false }, { startTime: seconds + 1n }, { endTime: seconds - 1n }, { feeBps: 10001n },
  ])('rejects paid, unrestricted or invalid stage parameters before RPC', async (changes) => {
    const value = await input(); const first = client();
    await expect(verify({ ...value, mintParams: { ...value.mintParams, ...changes } }, first, client())).rejects.toThrow('SIGNED_MINT_AUTHORIZATION_INVALID');
    expect(first.getBlockNumber).not.toHaveBeenCalled();
  });
  it('rejects insufficient/disagreeing/stale authorities and lost wallet allowance', async () => {
    const value = await input(); const first = client();
    await expect(verifySignedWalletAuthorization(value, [first, first], 2, now)).rejects.toThrow('SIGNED_MINT_INDEPENDENT_AUTHORITY_REQUIRED');
    await expect(verify(value, client(), client({ hash: `0x${'b'.repeat(64)}` }))).rejects.toThrow('SIGNED_MINT_RPC_DISAGREEMENT');
    await expect(verify(value, client({ age: 301n }), client())).rejects.toThrow('SIGNED_MINT_AUTHORITY_INVALID');
    await expect(verify(value, client({ stats: [9n, 100n, 2000n] }), client())).rejects.toThrow('SIGNED_MINT_QUANTITY_UNAVAILABLE');
    await expect(verify(value, client({ fee: false }), client())).rejects.toThrow('SIGNED_MINT_AUTHORITY_INVALID');
  });
  it('does not accept unverified/deserialized objects, another wallet, changed quantity or stale evidence', async () => {
    const proof = await verify(await input());
    expect(() => buildSignedMint({ ...proof }, wallet, 2, now)).toThrow('SIGNED_MINT_OWN_WALLET_AUTHORIZATION_REQUIRED');
    expect(() => buildSignedMint(proof, other, 2, now)).toThrow('SIGNED_MINT_OWN_WALLET_AUTHORIZATION_REQUIRED');
    expect(() => buildSignedMint(proof, wallet, 3, now)).toThrow('SIGNED_MINT_OWN_WALLET_AUTHORIZATION_REQUIRED');
    expect(() => buildSignedMint(proof, wallet, 2, new Date(now.getTime() + 60001))).toThrow('SIGNED_MINT_OWN_WALLET_AUTHORIZATION_REQUIRED');
  });
  it('blocks a digest consumed after the common block even if historical eth_call passed', async () => {
    const value = await input();
    const provider = client();
    const call = provider.call;
    provider.call = async (request) => { if (request.blockNumber === undefined) throw new Error('SignatureAlreadyUsed'); return call(request); };
    await expect(verify(value, provider, client())).rejects.toThrow('SIGNED_MINT_AUTHORITY_UNAVAILABLE');
  });
  it('rejects high-s signatures and expiration crossed during provider reads', async () => {
    const value = await input();
    const highS = { ...value, signature: `${value.signature.slice(0, 66)}${'f'.repeat(64)}1b` as Hex };
    await expect(verify(highS)).rejects.toThrow('SIGNED_MINT_SIGNATURE_INVALID');
    const first = client(); const second = client();
    let late = false;
    const original = second.call;
    second.call = async (request) => { const result = await original(request); late = true; return result; };
    await expect(verifySignedWalletAuthorization(value, [first, second], 2, () => late ? new Date(now.getTime() + 601000) : now)).rejects.toThrow(/SIGNED_MINT_/);
  });
  it('aggregates separately fresh wallet snapshots without requiring identical per-wallet block heights', async () => {
    const one = await verify(await input());
    const raw = await input();
    raw.wallet = other; raw.source = { ...raw.source, wallet: other };
    raw.signature = await issuer.signTypedData(signedMintTypedData(raw));
    const newHash = `0x${'b'.repeat(64)}` as Hex;
    const two = await verify(raw, client({ hash: newHash, stats: [0n, 101n, 2000n] }), client({ hash: newHash, stats: [0n, 101n, 2000n] }));
    const strategy = new SeaDropV1SignedStrategy(async () => [one, two], () => now);
    const drop = await strategy.readDrop({} as PublicClient, nftContract, 4663);
    expect(drop.totalMinted).toBe(101n);
    expect(drop.maxTotalMintableByWallet).toBe(2);
    expect(strategy.buildCalldata(drop, wallet, 1).slice(0, 10)).toBe('0x4b61cd6f');
  });
  it('integrates only verified authorizations into the strategy and cannot borrow a watched wallet signature', async () => {
    const proof = await verify(await input());
    const strategy = new SeaDropV1SignedStrategy(async () => [proof], () => now);
    const drop = await strategy.readDrop({} as PublicClient, nftContract, 4663);
    expect(strategy.buildCalldata(drop, wallet, 2)).toBe(buildSignedMint(proof, wallet, 2, now).data);
    expect(() => strategy.buildCalldata(drop, other, 2)).toThrow('SIGNED_MINT_OWN_WALLET_AUTHORIZATION_REQUIRED');
    await expect(strategy.readDrop({} as PublicClient, nftContract, 1)).rejects.toThrow('SIGNED_MINT_FLEET_STAGE_MISMATCH');
  });
});
