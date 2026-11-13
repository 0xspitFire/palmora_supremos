import type { EventRecord } from '@mint-bot/backend';

/** A diagnostic projection only. It cannot turn an alert or a missing sample into permission. */
export function automationStatus(events: readonly EventRecord[], now = new Date()) {
  const recent = events.filter(event => {
    const age = now.getTime() - Date.parse(event.at);
    return Number.isFinite(age) && age >= 0 && age <= 24 * 3_600_000;
  });
  const count = (type: string) => recent.filter(event => event.type === type).length;
  return {
    observedAt: now.toISOString(), windowHours: 24,
    watchedMints: count('watched_wallet_mint'), claims: count('replication_claim'),
    prepared: count('replication_prepared'), requested: count('replication_requested'),
    decisions: recent.filter(event => event.type === 'replication_decision').slice(-20).map(event => ({
      at: event.at,
      chainId: [1, 8453, 4663].includes(Number(event.data.chainId)) ? Number(event.data.chainId) : null,
      contract: typeof event.data.contract === 'string' && /^0x[0-9a-fA-F]{40}$/.test(event.data.contract) ? event.data.contract.toLowerCase() : null,
      code: typeof event.data.code === 'string' && /^[A-Z][A-Z0-9_]{2,90}$/.test(event.data.code) ? event.data.code : 'REPLICATION_REASON_UNAVAILABLE',
      stage: ['source', 'qualification', 'preparation'].includes(String(event.data.stage)) ? String(event.data.stage) : 'unknown',
    })),
    note: 'Ready service health is not mint authorization. A high score still needs a fresh verified watched self-mint, a supported method, own-wallet eligibility, custody, simulation, funding and spend headroom. Missing historical decisions cannot establish why old opportunities did not run.',
  };
}

export function describeAutomation(events: readonly EventRecord[], now = new Date()): string {
  const report = automationStatus(events, now);
  return [`Automatic minting, last 24 hours: ${report.watchedMints} watched self-mint observations, ${report.claims} claims, ${report.prepared} prepared, ${report.requested} requests.`,
    ...report.decisions.slice(-3).map(item => `${item.at.slice(0, 16).replace('T', ' ')} UTC, chain ${item.chainId ?? 'unknown'}: ${item.code}`),
    report.note].join('\n');
}
