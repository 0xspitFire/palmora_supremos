import { turnkeyPolicyRecordDigest, turnkeyPolicySelection, type TurnkeyCanonicalPolicyRecord, type TurnkeyPolicySelection } from '@mint-bot/engine';

export interface VerifiedCompensatingPolicies {
  activeRecord: TurnkeyCanonicalPolicyRecord;
  records: readonly TurnkeyCanonicalPolicyRecord[];
}
export interface SelectedCompensatingPolicy {
  record: TurnkeyCanonicalPolicyRecord;
  selection: TurnkeyPolicySelection;
}

/**
 * Diagnostic selection only. The loader must verify local owner signatures before
 * returning records; provider observations never supply authority. Inspection
 * (signer creation, provider/RPC probes and rehearsal reads) starts only after the
 * selected signed record uniquely matches the requested chain.
 */
export async function inspectCompensatingPolicy<T>(
  request: { chainId: number; policyId?: string },
  readVerified: () => Promise<VerifiedCompensatingPolicies>,
  inspect: (selected: SelectedCompensatingPolicy) => Promise<T>,
): Promise<T> {
  if (![1, 8453, 4663].includes(request.chainId)) throw new Error('COMPENSATING_POLICY_CHAIN_INVALID');
  const { activeRecord, records } = await readVerified();
  const activeDigest = turnkeyPolicyRecordDigest(activeRecord);
  if (!records.some(record => turnkeyPolicyRecordDigest(record) === activeDigest)) throw new Error('TURNKEY_PROVIDER_POLICY_CATALOG_ACTIVE_RECORD_MISSING');
  const wanted = request.policyId === undefined ? activeRecord.providerPolicy.policyId : request.policyId;
  const matches = records.filter(record => record.providerPolicy.policyId === wanted);
  if (matches.length === 0) throw new Error('COMPENSATING_POLICY_SELECTION_NOT_FOUND');
  if (matches.length !== 1) throw new Error('COMPENSATING_POLICY_SELECTION_AMBIGUOUS');
  const record = matches[0]!;
  if (record.enforcementPolicy.transaction.chainId !== request.chainId) throw new Error('COMPENSATING_POLICY_CHAIN_MISMATCH');
  return inspect({ record, selection: turnkeyPolicySelection(record) });
}
