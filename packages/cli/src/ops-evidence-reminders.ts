type EvidenceKind = 'recovery' | 'rotation_revocation' | 'heap_core_dump' | 'backup_restore' | 'service_supervision';
const OPS_EVIDENCE_REMINDER_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;

export interface OpsEvidenceReport {
  humanEvidenceComplete: boolean;
  missing: string[];
  acceptance: string;
  acceptanceProblems: string[];
  acceptanceExpiresAt?: string | null;
  artifactExpiry?: Partial<Record<EvidenceKind, { completedAt: string | null; expiresAt: string | null }>>;
}

export interface OpsEvidenceReminder {
  dedupe: string;
  text: string;
  severity: 'periodic' | 'three_day' | 'expiry';
}

export interface OpsEvidenceReminderOptions {
  evaluate: () => Promise<OpsEvidenceReport>;
  alert: (input: { kind: 'status'; dedupe: string; text: string; priority: 'immediate'; at?: string }) => Promise<boolean>;
  intervalMs?: number;
  now?: () => Date;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

const DEFAULT_INTERVAL_MS = 60 * 60_000;
const KIND_LABEL: Record<EvidenceKind, string> = {
  recovery: 'recovery drill',
  rotation_revocation: 'wallet rotation and revocation drill',
  heap_core_dump: 'heap/core-dump evidence',
  backup_restore: 'backup and restore drill',
  service_supervision: 'service supervision evidence',
};

function nextAction(kind?: EvidenceKind): string {
  if (!kind) return 'review the five artifact digests and record a fresh owner acceptance.';
  return `re-run the ${KIND_LABEL[kind]}, collect the artifact, then record owner acceptance for all five digests.`;
}

function dateKey(now: Date): string { return now.toISOString().slice(0, 10); }

function remaining(expiresAt: string, now: Date): string {
  const ms = Date.parse(expiresAt) - now.getTime();
  if (ms <= 0) return 'expired';
  const days = Math.ceil(ms / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'} remaining`;
}

/** Build only actionable, administrator-facing reminders. No paths, digests, wallet addresses, or secrets are included. */
export function buildOpsEvidenceReminders(report: OpsEvidenceReport, now = new Date()): OpsEvidenceReminder[] {
  const reminders: OpsEvidenceReminder[] = [];
  const due: Array<{ kind?: EvidenceKind; expiresAt: string }> = [];
  for (const kind of Object.keys(KIND_LABEL) as EvidenceKind[]) {
    const expiry = report.artifactExpiry?.[kind]?.expiresAt;
    if (typeof expiry === 'string' && Number.isFinite(Date.parse(expiry))) due.push({ kind, expiresAt: expiry });
  }
  if (typeof report.acceptanceExpiresAt === 'string' && Number.isFinite(Date.parse(report.acceptanceExpiresAt))) due.push({ expiresAt: report.acceptanceExpiresAt });

  const stale = report.missing.length > 0 || report.acceptance !== 'accepted' || report.acceptanceProblems.length > 0;
  if (stale) {
    const problems = report.missing.length > 0 ? ` Missing: ${report.missing.join(', ')}.` : '';
    reminders.push({
      severity: 'periodic',
      dedupe: `ops-evidence:periodic:${dateKey(now)}`,
      text: `D-017 evidence needs action.${problems} Next action: ${nextAction()}`,
    });
  }

  for (const item of due) {
    const remainingMs = Date.parse(item.expiresAt) - now.getTime();
    if (remainingMs <= 0) {
      reminders.push({ severity: 'expiry', dedupe: `ops-evidence:expiry:${item.kind ?? 'acceptance'}:${item.expiresAt}`, text: `D-017 ${item.kind ? KIND_LABEL[item.kind] : 'owner acceptance'} expires today. Next action: ${nextAction(item.kind)} ` });
    } else if (remainingMs <= OPS_EVIDENCE_REMINDER_BEFORE_MS) {
      reminders.push({ severity: 'three_day', dedupe: `ops-evidence:three-day:${item.kind ?? 'acceptance'}:${item.expiresAt}`, text: `D-017 ${item.kind ? KIND_LABEL[item.kind] : 'owner acceptance'} is due in ${remaining(item.expiresAt, now)}. Next action: ${nextAction(item.kind)}` });
    }
  }

  // Keep the highest priority notice for the same item, while allowing one periodic summary alongside a specific expiry notice.
  const rank = { periodic: 1, three_day: 2, expiry: 3 };
  return [...new Map(reminders.map((item) => [item.dedupe.replace(/^(ops-evidence:(?:three-day|expiry)):/, 'ops-evidence:item:'), item])).values()]
    .sort((a, b) => rank[b.severity] - rank[a.severity]);
}

export function startOpsEvidenceReminders(options: OpsEvidenceReminderOptions): { stop(): void; checkNow(): Promise<number> } {
  const now = options.now ?? (() => new Date());
  let busy = false;
  const checkNow = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try {
      const reminders = buildOpsEvidenceReminders(await options.evaluate(), now());
      let sent = 0;
      for (const reminder of reminders) {
        if (await options.alert({ kind: 'status', dedupe: reminder.dedupe, text: reminder.text, priority: 'immediate', at: now().toISOString() })) sent += 1;
      }
      return sent;
    } catch (error) {
      options.logger?.warn({ error }, 'D-017 evidence reminder check failed');
      return 0;
    } finally { busy = false; }
  };
  const timer = setInterval(() => void checkNow(), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  void checkNow();
  return { stop: () => clearInterval(timer), checkNow };
}
