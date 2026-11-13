import { createTurnkeyFundingRecord, turnkeyFundingWalletSetDigest, turnkeyFundingBudgetProfileDigest } from './turnkey-funding-policy.js';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, type Hex } from 'viem';
import { assertTurnkeyFundingProviderState, signTurnkeyFundingRecord, turnkeyFundingProviderPolicy, TurnkeyFundingSigner, verifyTurnkeyFundingRecord, type TurnkeyFundingRecord } from './turnkey-funding-policy.js';
import type { TurnkeySignerClient } from './turnkey-signer.js';
import type { TransactionIntent } from './types.js';
const PAIR = generateKeyPairSync('ed25519');
const PRIVATE = PAIR.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const PUBLIC = PAIR.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const NOW = new Date('2026-11-13T10:00:00Z');
const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const TO = `0x${'22'.repeat(20)}` as Hex;
function record(): TurnkeyFundingRecord { return createTurnkeyFundingRecord({ version: 1, kind: 'native-fleet-topup-v1', organizationId: 'funding-org', mintOrganizationId: 'mint-org', userId: 'funding-user', keyId: 'hub-key', policyId: 'hub-policy', chainId: 1, hub: ACCOUNT.address, recipients: [TO], issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 86400000).toISOString(), maxTransferWei: '4100000000000000', rollingPrincipalCapWei: '8500000000000000', rollingFeeCapWei: '200000000000000', maxTransferFeeWei: '20000000000000', hubMaxBalanceWei: '8700000000000000', recipientMaxBalanceWei: '4100000000000000', fleetMaxBalanceWei: '8500000000000000', gasLimitMax: '21000', maxFeePerGas: '200000000', maxPriorityFeePerGas: '100000000' }, NOW); }
function provider(r = record()) { return { whoami: { organizationId: r.organizationId, userId: r.userId }, organization: { configs: { quorum: { threshold: 1, userIds: ['offline-owner'] } } }, policies: [{ policyId: r.policyId, ...turnkeyFundingProviderPolicy(r) }], privateKeys: [{ privateKeyId: r.keyId, curve: 'CURVE_SECP256K1', isExported: false, addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: r.hub }] }] }; }
function intent(): TransactionIntent { return { chainId: 1, from: ACCOUNT.address, to: TO, value: 1000n, data: '0x', gasLimit: 21000n, maxFeePerGas: 200000000n, maxPriorityFeePerGas: 100000000n, nonce: 0 }; }
function fixture(options: { mutateResult?: (r: unknown) => unknown; expiredDuringProbe?: boolean } = {}) {
  const r = record(), envelope = signTurnkeyFundingRecord(r, PRIVATE, NOW); let at = NOW; let signs = 0; let checkpoints = 0;
  const state = provider(r);
  const client = {
    getWhoami: async () => state.whoami,
    getOrganizationConfigs: async () => state.organization,
    getPolicies: async () => state,
    getPrivateKeys: async () => { if (options.expiredDuringProbe) at = new Date(r.expiresAt); return state; },
    signTransaction: async (input: { signWith: string; unsignedTransaction: Hex }) => {
      signs += 1;
      const signed = await ACCOUNT.signTransaction(parseTransaction(input.unsignedTransaction) as never);
      const result = { signedTransaction: signed, activity: { id: 'public-activity-id', fingerprint: 'public-fingerprint', organizationId: r.organizationId, status: 'ACTIVITY_STATUS_COMPLETED', type: 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2', intent: { signTransactionIntentV2: { ...input, type: 'TRANSACTION_TYPE_ETHEREUM' } }, result: { signTransactionResult: { signedTransaction: signed } } } };
      return options.mutateResult ? options.mutateResult(result) : result;
    },
  } as unknown as TurnkeySignerClient;
  return { signer: new TurnkeyFundingSigner({ catalog: [envelope], publicKey: PUBLIC, chainId: 1, client, now: () => at }), current: async () => { checkpoints += 1; }, signs: () => signs, checkpoints: () => checkpoints };
}
describe('separate owner-signed funding custody', () => {
  it('pins canonical whole-fleet and budget bindings before offline signing', () => {
    const r = record();
    expect(r.walletSetDigest).toBe(turnkeyFundingWalletSetDigest(r.chainId, r.recipients));
    expect(r.budgetProfileDigest).toBe(turnkeyFundingBudgetProfileDigest(r));
    expect(turnkeyFundingWalletSetDigest(1, [TO, ACCOUNT.address])).toBe(turnkeyFundingWalletSetDigest(1, [ACCOUNT.address.toLowerCase(), TO.toUpperCase()]));
    expect(turnkeyFundingWalletSetDigest(8453, r.recipients)).not.toBe(r.walletSetDigest);
    expect(() => signTurnkeyFundingRecord({ ...r, recipients: [ACCOUNT.address] }, PRIVATE, NOW)).toThrow('RECIPIENTS_INVALID');
    expect(() => signTurnkeyFundingRecord({ ...r, maxTransferWei: '1000' }, PRIVATE, NOW)).toThrow('BINDING_REQUIRED');
  });

  it('binds exact native scope and rejects edited recipients, budgets, role and expired records', () => {
    const r = record(), signed = signTurnkeyFundingRecord(r, PRIVATE, NOW);
    expect(verifyTurnkeyFundingRecord(signed, PUBLIC, NOW).record).toEqual(r);
    for (const change of [{ recipients: [ACCOUNT.address] }, { maxTransferWei: '9999999999999999' }, { organizationId: 'mint-org' }, { chainId: 4663 }, { policyId: 'other' }]) expect(() => verifyTurnkeyFundingRecord({ ...signed, record: { ...r, ...change } }, PUBLIC, NOW)).toThrow();
    expect(() => verifyTurnkeyFundingRecord(signed, PUBLIC, new Date(r.expiresAt))).toThrow('EXPIRED');
    expect(() => verifyTurnkeyFundingRecord({ ...signed, record: { ...r, unexpected: true } }, PUBLIC, NOW)).toThrow();
  });
  it('provider policy is a closed native EOA-transfer role, with no nullable time', () => {
    const p = turnkeyFundingProviderPolicy(record());
    expect(p.condition).toContain("eth.tx.data == '0x'"); expect(p.condition).toContain("private_key.id == 'hub-key'"); expect(p).not.toHaveProperty('time');
  });
  it('rejects provider drift, unknown ALLOW inventory, wrong account and exported hub', () => {
    const r = record();
    expect(() => assertTurnkeyFundingProviderState([r], provider())).not.toThrow();
    for (const state of [{ ...provider(), organization: { configs: { quorum: { threshold: 1, userIds: [r.userId] } } } }, { ...provider(), whoami: { organizationId: 'other', userId: r.userId } }, { ...provider(), policies: [...provider().policies, { effect: 'EFFECT_ALLOW' }] }, { ...provider(), policies: [{ ...provider().policies[0], condition: 'true' }] }, { ...provider(), privateKeys: [{ ...provider().privateKeys[0], isExported: true }] }]) expect(() => assertTurnkeyFundingProviderState([r], state)).toThrow();
  });
  it('validates actual signed activity and recovered transaction, without sending anything', async () => {
    const f = fixture(); const signed = await f.signer.sign(intent(), f.current);
    expect(parseTransaction(signed)).toMatchObject({ chainId: 1, value: 1000n, gas: 21000n }); expect(parseTransaction(signed).data ?? '0x').toBe('0x'); expect(f.signs()).toBe(1); expect(f.checkpoints()).toBe(2);
  });
  it('never calls signing for wrong chain, arbitrary recipient, calldata or expired probe', async () => {
    for (const change of [{ chainId: 8453 }, { to: ACCOUNT.address }, { data: '0x1234' }, { value: 0n }]) { const f = fixture(); await expect(f.signer.sign({ ...intent(), ...change } as TransactionIntent, f.current)).rejects.toThrow('TURNKEY_FUNDING_'); expect(f.signs()).toBe(0); }
    const expired = fixture({ expiredDuringProbe: true }); await expect(expired.signer.sign(intent(), expired.current)).rejects.toThrow('EXPIRED'); expect(expired.signs()).toBe(0);
  });
  it('rejects a provider activity that is not bound to this exact unsigned request', async () => {
    const f = fixture({ mutateResult: raw => { const r = raw as { activity: { organizationId: string } }; r.activity.organizationId = 'other'; return r; } });
    await expect(f.signer.sign(intent(), f.current)).rejects.toThrow('SIGNATURE_ACTIVITY_INVALID');
  });
});

it('refuses an offline private approval key in the live public-verification slot', () => {
 const signed = signTurnkeyFundingRecord(record(), PRIVATE, NOW);
 expect(() => verifyTurnkeyFundingRecord(signed, PRIVATE, NOW)).toThrow('PUBLIC_APPROVAL_KEY_REQUIRED');
});
