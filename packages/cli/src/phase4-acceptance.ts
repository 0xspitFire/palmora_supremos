import type { SqliteDatabase } from '@mint-bot/database';
import { campaignInputDigest, type Campaign, type EventRecord } from '@mint-bot/backend';

export interface ReplicationAuditRequest {
  id: string; campaignId: string; authorityId: string; wallets: string[]; simulationIds: string[];
  maxFeeGwei: number; requestedAt: string; approvalId?: string; expiresAt?: string;
}
export interface ReplicationAuditAttempt {
  id: string; runId: string; executionId: string; campaignId: string; wallet: string; hash: string | null;
  at: string; reservationId: string | null; valueWei: string; feeBudgetWei: string; campaignDigest?: string;
}
export interface ReplicationAuditReservation {
  id: string; executionId: string; campaignId: string; wallet: string; amountWei: string; createdAt: string;
}
export interface ReplicationAuditSimulation {
  id: string; campaignId: string; wallet: string; success: boolean; checkedAt: string; expiresAt: string; inputDigest?: string;
}

/** Read-only evidence review. A clean report is not permission to arm, sign, or broadcast. */
export function phase4AcceptanceReport(input: {
  events: readonly EventRecord[];
  requests: readonly ReplicationAuditRequest[];
  simulations: readonly ReplicationAuditSimulation[];
  campaigns?: readonly { id: string; chainId: number; contract: string }[];
  runs?: readonly { id: string; campaignId: string; requestKey: string }[];
  attempts?: readonly ReplicationAuditAttempt[];
  reservations?: readonly ReplicationAuditReservation[];
  minimumWallets?: number;
  windowMs?: number;
}) {
  const minimumWallets = input.minimumWallets ?? 2;
  const windowMs = input.windowMs ?? 6 * 60 * 60_000;
  if (!Number.isSafeInteger(minimumWallets) || minimumWallets < 2 || !Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('PHASE4_REPLAY_CONFIG_INVALID');
  const address = /^0x[0-9a-fA-F]{40}$/;
  const hash = /^0x[0-9a-fA-F]{64}$/;
  const evidence = input.events.filter((event) => event.type === 'watched_wallet_mint'
    && [1, 8453, 4663].includes(Number(event.data.chainId))
    && address.test(String(event.data.contract)) && address.test(String(event.data.wallet))
    && hash.test(String(event.data.txHash)) && /^\d+$/.test(String(event.data.sourceBlock))
    && Number.isFinite(Date.parse(event.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const groups = new Map<string, EventRecord[]>();
  const history = new Map<string, { chainId: number; wallet: string; transactions: number; contracts: Set<string>; lastObservedAt: string }>();
  const seen = new Set<string>();
  const convergence: Array<{ chainId: number; contract: string; at: string; wallets: string[]; eventIds: string[] }> = [];
  for (const event of evidence) {
    // Repeated scans of a wallet's same transaction must not inflate convergence.
    const identity = `${event.data.chainId}:${String(event.data.txHash).toLowerCase()}:${String(event.data.wallet).toLowerCase()}:${String(event.data.contract).toLowerCase()}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const wallet = String(event.data.wallet).toLowerCase();
    const historyKey = `${event.data.chainId}:${wallet}`;
    const stats = history.get(historyKey) ?? { chainId: Number(event.data.chainId), wallet, transactions: 0, contracts: new Set<string>(), lastObservedAt: event.at };
    stats.transactions += 1;
    stats.contracts.add(String(event.data.contract).toLowerCase());
    stats.lastObservedAt = event.at;
    history.set(historyKey, stats);
    const key = `${event.data.chainId}:${String(event.data.contract).toLowerCase()}`;
    const prior = (groups.get(key) ?? []).filter((row) => Date.parse(event.at) - Date.parse(row.at) <= windowMs);
    prior.push(event);
    groups.set(key, prior);
    const wallets = [...new Set(prior.map((row) => String(row.data.wallet).toLowerCase()))].sort();
    if (wallets.length >= minimumWallets) convergence.push({ chainId: Number(event.data.chainId), contract: String(event.data.contract).toLowerCase(), at: event.at, wallets, eventIds: prior.map((row) => row.id) });
  }
  const byId = new Map(input.events.map((event) => [event.id, event]));
  const simulations = new Map(input.simulations.map((simulation) => [simulation.id, simulation]));
  const findings: Array<{ requestId: string; problems: string[] }> = [];
  for (const request of input.requests) {
    const problems: string[] = [];
    const authority = byId.get(request.authorityId);
    const at = Date.parse(request.requestedAt);
    if (!authority || authority.type !== 'replication_prepared' || authority.data.campaignId !== request.campaignId
      || authority.data.policyVersion !== 'free-watched-v1' || authority.data.mintPriceWei !== '0'
      || typeof authority.data.score !== 'number' || authority.data.score < 70 || authority.data.score > 100
      || !Number.isFinite(at) || !Number.isFinite(Date.parse(authority.at)) || Date.parse(authority.at) > at) problems.push('AUTHORITY_MISSING_OR_INVALID');
    const source = authority && byId.get(String(authority.data.sourceEventId));
    const campaign = input.campaigns?.find((row) => row.id === request.campaignId);
    if (!campaign || source?.data.chainId !== campaign.chainId || String(source?.data.contract).toLowerCase() !== campaign.contract.toLowerCase()) problems.push('CAMPAIGN_SOURCE_BINDING_UNVERIFIED');
    if (!source || !evidence.some((row) => row.id === source.id)
      || String(source.data.wallet).toLowerCase() !== String(authority?.data.sourceWallet).toLowerCase()
      || String(source.data.txHash).toLowerCase() !== String(authority?.data.sourceTxHash).toLowerCase()
      || at - Date.parse(source.at) < 0 || at - Date.parse(source.at) > 15 * 60_000) problems.push('SOURCE_MISSING_OR_STALE');
    const score = authority && byId.get(String(authority.data.scoreEventId));
    const scores = input.events.filter((row) => ['opportunity_scored', 'opportunity_notified'].includes(row.type)
      && row.data.chainId === campaign?.chainId && String(row.data.contract).toLowerCase() === campaign?.contract.toLowerCase()
      && Date.parse(row.at) <= at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
    if (!score || !['opportunity_scored', 'opportunity_notified'].includes(score.type) || scores.at(-1)?.id !== score.id
      || score.data.chainId !== campaign?.chainId || String(score.data.contract).toLowerCase() !== campaign?.contract.toLowerCase()
      || typeof score.data.score !== 'number' || score.data.score < 70 || score.data.score > 100 || score.data.score !== authority?.data.score
      || score.data.blocked === true || typeof score.data.scoreVersion !== 'string' || !score.data.scoreVersion
      || !Number.isFinite(Date.parse(score.at)) || at - Date.parse(score.at) < 0 || at - Date.parse(score.at) > 15 * 60_000
      || !(Date.parse(String(score.data.expiresAt)) > at)) problems.push('SCORE_MISSING_OR_STALE');
    const allowed = authority?.data.wallets;
    const wallets = request.wallets.map((wallet) => wallet.toLowerCase());
    if (!wallets.length || new Set(wallets).size !== wallets.length || wallets.some((wallet) => !address.test(wallet))
      || !Array.isArray(allowed) || wallets.some((wallet) => !allowed.some((item) => typeof item === 'string' && item.toLowerCase() === wallet))
      || !Number.isFinite(request.maxFeeGwei) || request.maxFeeGwei <= 0
      || typeof authority?.data.maxFeeGwei !== 'number' || !Number.isFinite(authority.data.maxFeeGwei)
      || request.maxFeeGwei > authority.data.maxFeeGwei) problems.push('REQUEST_SCOPE_INVALID');
    const matched = new Set<string>();
    for (const id of request.simulationIds) {
      const simulation = simulations.get(id);
      if (simulation?.success && simulation.campaignId === request.campaignId && wallets.includes(simulation.wallet.toLowerCase())
        && Date.parse(simulation.checkedAt) <= at && Date.parse(simulation.expiresAt) > at) matched.add(simulation.wallet.toLowerCase());
    }
    if (matched.size !== wallets.length || request.simulationIds.length !== wallets.length) problems.push('SIMULATION_MISSING_OR_STALE');
    if (problems.length) findings.push({ requestId: request.id, problems });
  }
  const executionFindings: Array<{ attemptId?: string; requestId?: string; runId?: string; problems: string[] }> = [];
  const results = input.events.filter((event) => event.type === 'live_request_result');
  for (const result of results) {
    const request = input.requests.find((row) => row.id === result.data.requestId);
    if (request && result.data.state === 'finished' && (!result.runId || !input.runs?.some((row) => row.id === result.runId && row.requestKey === `live-request:${request.id}`))) executionFindings.push({ requestId: request.id, ...(result.runId ? { runId: result.runId } : {}), problems: ['RESULT_RUN_LINK_MISSING'] });
  }
  for (const attempt of input.attempts ?? []) {
    const problems: string[] = [];
    const run = input.runs?.find((row) => row.id === attempt.runId);
    const request = input.requests.find((row) => run?.requestKey === `live-request:${row.id}`);
    const at = Date.parse(attempt.at);
    if (!run || !request || request.campaignId !== attempt.campaignId || run.campaignId !== attempt.campaignId
      || !Number.isFinite(at) || !request.wallets.some((wallet) => wallet.toLowerCase() === attempt.wallet.toLowerCase())
      || !results.some((row) => row.data.requestId === request.id && row.runId === run.id)) problems.push('EXECUTION_REQUEST_LINK_INVALID');
    if (request) {
      if (findings.some((row) => row.requestId === request.id)) problems.push('EXECUTION_AUTHORITY_INVALID');
      if (!(Date.parse(request.requestedAt) <= at) || !(Date.parse(String(request.expiresAt)) > at)) problems.push('EXECUTION_REQUEST_EXPIRED');
      const authority = byId.get(request.authorityId);
      if (!attempt.campaignDigest || authority?.data.campaignDigest !== attempt.campaignDigest) problems.push('EXECUTION_CAMPAIGN_DIGEST_MISMATCH');
      const source = byId.get(String(authority?.data.sourceEventId));
      const campaign = input.campaigns?.find((row) => row.id === attempt.campaignId);
      const score = input.events.filter((row) => ['opportunity_scored', 'opportunity_notified'].includes(row.type)
        && row.data.chainId === campaign?.chainId && String(row.data.contract).toLowerCase() === campaign?.contract.toLowerCase()
        && Date.parse(row.at) <= at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id)).at(-1);
      if (!score || typeof score.data.score !== 'number' || score.data.score < 70 || score.data.score > 100
        || score.data.blocked === true || !(Date.parse(String(score.data.expiresAt)) > at)
        || at - Date.parse(score.at) > 15 * 60_000 || !source || at - Date.parse(source.at) > 15 * 60_000) problems.push('EXECUTION_SIGNAL_STALE');
      const approval = byId.get(String(request.approvalId));
      if (!approval || approval.type !== 'campaign_approved' || approval.data.campaignId !== request.campaignId
        || !(Date.parse(approval.at) <= at) || !Array.isArray(approval.data.wallets)
        || !approval.data.wallets.some((wallet) => typeof wallet === 'string' && wallet.toLowerCase() === attempt.wallet.toLowerCase())
        || !Array.isArray(approval.data.simulationIds) || request.simulationIds.some((id) => !(approval.data.simulationIds as unknown[]).includes(id))) problems.push('EXECUTION_APPROVAL_UNVERIFIED');
      if (!request.simulationIds.some((id) => {
        const simulation = simulations.get(id);
        return simulation?.success && simulation.campaignId === attempt.campaignId && simulation.wallet.toLowerCase() === attempt.wallet.toLowerCase()
          && simulation.inputDigest === attempt.campaignDigest
          && Date.parse(simulation.checkedAt) <= at && Date.parse(simulation.expiresAt) > at;
      })) problems.push('EXECUTION_SIMULATION_MISSING_OR_STALE');
    }
    const reservation = input.reservations?.find((row) => row.id === attempt.reservationId && row.executionId === attempt.executionId
      && row.campaignId === attempt.campaignId && row.wallet.toLowerCase() === attempt.wallet.toLowerCase());
    const uint = /^\d+$/;
    if (!reservation || !(Date.parse(reservation.createdAt) <= at)
      || ![reservation.amountWei, attempt.valueWei, attempt.feeBudgetWei].every((value) => uint.test(value))
      || BigInt(reservation.amountWei) <= 0n
      || BigInt(reservation.amountWei) < BigInt(attempt.valueWei) + BigInt(attempt.feeBudgetWei)) problems.push('EXECUTION_RESERVATION_MISSING_OR_INSUFFICIENT');
    if (problems.length) executionFindings.push({ attemptId: attempt.id, ...(request ? { requestId: request.id } : {}), runId: attempt.runId, problems });
  }
  return {
    version: 'phase4-acceptance-v1',
    timeBasis: 'recorded_observation_time',
    observedMintTransactions: seen.size,
    walletHistory: [...history.values()].map(({ contracts, ...row }) => ({ ...row, collectionsMinted: contracts.size })).sort((a, b) => a.chainId - b.chainId || a.wallet.localeCompare(b.wallet)),
    convergence: { minimumWallets, windowMs, matches: convergence },
    replicationAudit: { requestsChecked: input.requests.length, findings, result: findings.length ? 'findings' : input.requests.length ? 'clean' : 'no_samples' },
    executionAudit: { attemptsChecked: input.attempts?.length ?? 0, findings: executionFindings, result: executionFindings.length ? 'findings' : input.attempts?.length ? 'clean' : 'no_samples' },
    note: 'Retained observation replay and structural request/execution provenance only. This does not prove chain-time convergence, historical remote signing state, current readiness or production certification. Missing retained evidence is reported, never assumed valid.',
  };
}

/** Caller must open an existing database read-only; all reads share one SQLite snapshot. */
export function readPhase4AcceptanceReport(db: SqliteDatabase) {
  return db.transaction(() => {
    const auditEvents: EventRecord[] = (db.prepare("SELECT id, new_state, occurred_at, policy_snapshot_json FROM audit_event WHERE new_state IN ('watched_wallet_mint', 'replication_prepared', 'opportunity_scored', 'opportunity_notified', 'campaign_approved', 'live_request_result') ORDER BY occurred_at, id").all() as Array<{ id: string; new_state: string; occurred_at: string; policy_snapshot_json: string }>).map((row) => ({ id: row.id, type: row.new_state, at: row.occurred_at, ...((JSON.parse(row.policy_snapshot_json) as { runId?: string }).runId ? { runId: (JSON.parse(row.policy_snapshot_json) as { runId: string }).runId } : {}), data: (JSON.parse(row.policy_snapshot_json) as { eventData: Record<string, unknown> }).eventData }));
    const domainEvents: EventRecord[] = (db.prepare("SELECT id, event_type, occurred_at, payload_json FROM event WHERE event_type IN ('watched_wallet_mint', 'replication_prepared', 'opportunity_scored', 'opportunity_notified', 'campaign_approved', 'live_request_result') ORDER BY occurred_at, id").all() as Array<{ id: string; event_type: string; occurred_at: string; payload_json: string }>).map((row) => ({ id: row.id, type: row.event_type, at: row.occurred_at, data: JSON.parse(row.payload_json) as Record<string, unknown> }));
    const events = [...new Map([...domainEvents, ...auditEvents].map((event) => [event.id, event])).values()];
    const requests = (db.prepare('SELECT id, campaign_id, automation_event_id, wallets_json, simulation_ids_json, max_fee_gwei, requested_at, approval_id, expires_at FROM live_run_request WHERE automation_event_id IS NOT NULL').all() as Array<{ id: string; campaign_id: string; automation_event_id: string; wallets_json: string; simulation_ids_json: string; max_fee_gwei: string; requested_at: string; approval_id: string; expires_at: string }>).map((row) => ({ id: row.id, campaignId: row.campaign_id, authorityId: row.automation_event_id, wallets: JSON.parse(row.wallets_json) as string[], simulationIds: JSON.parse(row.simulation_ids_json) as string[], maxFeeGwei: Number(row.max_fee_gwei), requestedAt: row.requested_at, approvalId: row.approval_id, expiresAt: row.expires_at }));
    const simulations = (db.prepare('SELECT s.id, s.campaign_id, w.address, s.outcome, s.checked_at, s.freshness_seconds, s.details_json FROM simulation s JOIN wallet w ON w.id = s.wallet_id').all() as Array<{ id: string; campaign_id: string; address: string; outcome: string; checked_at: string; freshness_seconds: number; details_json: string }>).map((row) => ({ id: row.id, campaignId: row.campaign_id, wallet: row.address, success: row.outcome === 'pass', checkedAt: row.checked_at, expiresAt: new Date(Date.parse(row.checked_at) + row.freshness_seconds * 1000).toISOString(), inputDigest: (JSON.parse(row.details_json) as { inputDigest?: string }).inputDigest }));
    const campaigns = db.prepare('SELECT c.id, cp.chain_id AS chainId, ct.address AS contract FROM campaign c JOIN "drop" d ON d.id = c.drop_id JOIN collection cl ON cl.id = d.collection_id JOIN contract ct ON ct.id = cl.contract_id JOIN chain_profile cp ON cp.id = ct.chain_profile_id').all() as Array<{ id: string; chainId: number; contract: string }>;
    const runs = db.prepare('SELECT id, campaign_id AS campaignId, request_id AS requestKey FROM execution_run').all() as Array<{ id: string; campaignId: string; requestKey: string }>;
    const attempts = db.prepare(`SELECT a.id, ti.run_id AS runId, a.execution_id AS executionId, ti.campaign_id AS campaignId,
      w.address AS wallet, a.tx_hash AS hash, a.attempted_at AS at, e.reservation_id AS reservationId,
      ti.value_wei AS valueWei, json_extract(ti.policy_snapshot_json, '$.campaignSnapshot.feePolicy.totalFeeBudgetWei') AS feeBudgetWei,
      ti.policy_snapshot_json AS policySnapshotJson
      FROM transaction_attempt a JOIN transaction_intent ti ON ti.id = a.transaction_intent_id
      JOIN wallet w ON w.id = ti.wallet_id LEFT JOIN execution e ON e.id = a.execution_id
      WHERE a.tx_hash IS NOT NULL AND (
        EXISTS (SELECT 1 FROM live_run_request q WHERE q.campaign_id = ti.campaign_id AND q.automation_event_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM event pe WHERE pe.event_type = 'replication_prepared' AND json_extract(pe.payload_json, '$.campaignId') = ti.campaign_id AND json_extract(pe.payload_json, '$.mintPriceWei') = '0')
      ) AND NOT EXISTS (
        SELECT 1 FROM execution_run attended_run JOIN live_run_request attended
          ON attended_run.request_id = 'live-request:' || attended.id
        WHERE attended_run.id = ti.run_id AND attended.campaign_id = ti.campaign_id
          AND attended.execution_provenance = 'attended' AND attended.automation_event_id IS NULL
      )`).all() as Array<ReplicationAuditAttempt & { policySnapshotJson: string }>;
    for (const attempt of attempts) {
      if (typeof attempt.feeBudgetWei === 'string') attempt.feeBudgetWei = attempt.feeBudgetWei.replace(/n$/, '');
      try {
        const snapshot = JSON.parse(attempt.policySnapshotJson, (_key, value: unknown) => typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value) as { campaignSnapshot: Campaign };
        // Database JSON sorts keys and stores bigint as decimal text; rebuild
        // the same ordered policy shape used by canonical campaign hydration.
        const c = snapshot.campaignSnapshot;
        const fee = c.feePolicy;
        c.feePolicy = { kind: fee.kind, configuredPriorityFeeWei: BigInt(fee.configuredPriorityFeeWei),
          ...(fee.freeTotalSpendCapWei === undefined ? {} : { freeTotalSpendCapWei: BigInt(fee.freeTotalSpendCapWei) }),
          l2ExecutionGasBudgetWei: BigInt(fee.l2ExecutionGasBudgetWei ?? 0), l1DataGasBudgetWei: BigInt(fee.l1DataGasBudgetWei ?? 0), totalFeeBudgetWei: BigInt(fee.totalFeeBudgetWei ?? 0) };
        if (c.custodyPolicy) { const custody = c.custodyPolicy; c.custodyPolicy = { provider: custody.provider, policyReference: custody.policyReference, policyDigest: custody.policyDigest, recordDigest: custody.recordDigest }; }
        attempt.campaignDigest = campaignInputDigest(snapshot.campaignSnapshot);
      } catch { /* absent or damaged snapshots remain an explicit unverified digest */ }
    }
    const reservations = db.prepare('SELECT r.id, r.execution_id AS executionId, r.campaign_id AS campaignId, w.address AS wallet, r.reserved_amount_wei AS amountWei, r.created_at AS createdAt FROM spend_reservation r JOIN wallet w ON w.id = r.wallet_id').all() as ReplicationAuditReservation[];
    return phase4AcceptanceReport({ events, requests, simulations, campaigns, runs, attempts, reservations });
  })();
}
