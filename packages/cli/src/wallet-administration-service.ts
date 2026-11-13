import { createHash } from 'node:crypto';
import type { BackendStore, EventRecord, WalletAdministrationAuthority, WalletAdministrationRequestInput } from '@mint-bot/backend';
import type { createWalletAdministration } from '@mint-bot/backend';

export type WalletAdministrationService = ReturnType<typeof createWalletAdministration>;
export function hasWalletAdministrationSensitiveArguments(args: readonly string[]): boolean {
  return args.some(value => /(?:encappedPublic|ciphertext|encryptedBundle|private[_-]?key|mnemonic|passphrase|api[_-]?key)/i.test(value) || /(?:^|[^a-f0-9])0x[a-f0-9]{64}(?:$|[^a-f0-9])/i.test(value) || /^[a-f0-9]{64}$/i.test(value));
}
export function validateWalletAdministrationOperatorArguments(action: string, args: readonly string[]): void {
  const lengths: Readonly<Record<string, readonly number[]>> = { status: [0], inventory: [0], groups: [0], generate: [3], import: [3], group: [4], assign: [2], enroll: [2, 3], retire: [2], reconcile: [1] };
  if (!lengths[action]?.includes(args.length) || args.some(value => typeof value !== 'string' || value.length > 2048) || hasWalletAdministrationSensitiveArguments(args)) throw new Error('WALLET_ADMIN_PUBLIC_ARGUMENTS_REQUIRED');
}
export interface WalletAdministrationApproval extends WalletAdministrationAuthority { sessionId: string; }
export interface WalletAdministrationQueuedRequest {
  request: WalletAdministrationRequestInput;
  ownerId: string;
  approval: WalletAdministrationApproval;
  approvedAt: string;
  expiresAt: string;
  state: 'queued' | 'started' | 'completed' | 'ambiguous' | 'expired' | 'owner-action-required';
  code: string;
  digest: string;
}
const QUEUE = 'wallet_administration_operator_request';
const ID = /^[A-Za-z0-9_.:-]{1,180}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const CODE = /^[A-Z][A-Z0-9_]{2,90}$/;
const stable = (value: unknown): string => JSON.stringify(value, (_key, row: unknown) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);
const hash = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && ID.test(value) && !/^0x[0-9a-f]{64}$/i.test(value);
const spec = (row: WalletAdministrationQueuedRequest) => ({ request: row.request, ownerId: row.ownerId, approval: row.approval, approvedAt: row.approvedAt, expiresAt: row.expiresAt });

export function validateWalletAdministrationPublicRequest(input: WalletAdministrationRequestInput): WalletAdministrationRequestInput {
  if (!input || Object.keys(input).some(key => !['requestId', 'kind', 'chainIds', 'count', 'expectedAddresses'].includes(key)) || !validId(input.requestId) || !['generate', 'import'].includes(input.kind) || !Array.isArray(input.chainIds) || input.chainIds.length < 1 || input.chainIds.length > 3 || input.chainIds.some(id => ![1, 8453, 4663].includes(id)) || new Set(input.chainIds).size !== input.chainIds.length) throw new Error('WALLET_ADMIN_PUBLIC_REQUEST_INVALID');
  if (input.kind === 'generate' && (!Number.isSafeInteger(input.count) || input.count! < 1 || input.count! > 10 || input.expectedAddresses !== undefined) || input.kind === 'import' && (input.count !== undefined || !Array.isArray(input.expectedAddresses) || input.expectedAddresses.length < 1 || input.expectedAddresses.length > 10 || input.expectedAddresses.some(address => !ADDRESS.test(address)) || new Set(input.expectedAddresses.map(address => address.toLowerCase())).size !== input.expectedAddresses.length)) throw new Error('WALLET_ADMIN_PUBLIC_REQUEST_INVALID');
  return { requestId: input.requestId, kind: input.kind, chainIds: [...input.chainIds].sort((a, b) => a - b), ...(input.kind === 'generate' ? { count: input.count } : { expectedAddresses: input.expectedAddresses!.map(address => address.toLowerCase()) }) };
}
export function readWalletAdministrationQueue(events: readonly EventRecord[]): WalletAdministrationQueuedRequest[] {
  const rows = new Map<string, { revision: number; request: WalletAdministrationQueuedRequest }>();
  for (const event of events) {
    if (event.type !== QUEUE || event.data.version !== 1 || !Number.isSafeInteger(event.data.revision) || Number(event.data.revision) < 1 || !event.data.payload || typeof event.data.payload !== 'object') continue;
    const value = event.data.payload as WalletAdministrationQueuedRequest;
    try { validateWalletAdministrationPublicRequest(value.request); } catch { continue; }
    if (!validId(value.ownerId) || !value.approval || value.approval.ownerId !== value.ownerId || !validId(value.approval.sessionId) || !['owner-cli', 'telegram'].includes(value.approval.channel) || !['queued', 'started', 'completed', 'ambiguous', 'expired', 'owner-action-required'].includes(value.state) || !CODE.test(value.code) || !Number.isFinite(Date.parse(value.approvedAt)) || !Number.isFinite(Date.parse(value.expiresAt)) || !Number.isFinite(Date.parse(value.approval.expiresAt)) || Date.parse(value.expiresAt) <= Date.parse(value.approvedAt) || Date.parse(value.expiresAt) - Date.parse(value.approvedAt) > 300_000 || Date.parse(value.expiresAt) > Date.parse(value.approval.expiresAt) || hash(spec(value)) !== value.digest || hash(value) !== event.data.payloadDigest) continue;
    const prior = rows.get(value.request.requestId); if (!prior || Number(event.data.revision) > prior.revision) rows.set(value.request.requestId, { revision: Number(event.data.revision), request: value });
  }
  return [...rows.values()].map(row => structuredClone(row.request));
}
function append(events: EventRecord[], request: WalletAdministrationQueuedRequest, at: Date): void {
  const prior = events.filter(event => event.type === QUEUE && (event.data.payload as WalletAdministrationQueuedRequest | undefined)?.request?.requestId === request.request.requestId).sort((a, b) => Number(a.data.revision) - Number(b.data.revision)).at(-1);
  const payloadDigest = hash(request); if (prior?.data.payloadDigest === payloadDigest) return;
  events.push({ id: `wallet_operator_${hash({ payloadDigest, previous: prior?.id ?? null })}`, type: QUEUE, at: at.toISOString(), data: { version: 1, revision: Number(prior?.data.revision ?? 0) + 1, payload: request, payloadDigest } });
}
export async function reconcileWalletAdministrationOperatorRequest(options: { store: BackendStore; ownerId: string; administration: WalletAdministrationService; requestId: string; now?: () => Date }) {
  const result = await options.administration.reconcile(options.requestId);
  await options.store.transaction(state => {
    const current = readWalletAdministrationQueue(state.events).find(row => row.request.requestId === options.requestId && row.ownerId === options.ownerId);
    if (current) append(state.events, { ...current, state: result.state === 'completed' ? 'completed' : 'ambiguous', code: result.code }, (options.now ?? (() => new Date()))());
  });
  return result;
}

/** Public intent only. Telegram never supplies an encrypted bundle, plaintext
 * key or provider credential. Reusing an id never refreshes its approval. */
export async function queueWalletAdministrationRequest(options: { store: BackendStore; ownerId: string; authority: WalletAdministrationApproval; request: WalletAdministrationRequestInput; now?: () => Date }): Promise<WalletAdministrationQueuedRequest> {
  const current = (options.now ?? (() => new Date()))(); const approval = options.authority;
  if (!validId(options.ownerId) || approval.ownerId !== options.ownerId || !validId(approval.sessionId) || !['telegram', 'owner-cli'].includes(approval.channel) || !Number.isFinite(current.getTime()) || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= current.getTime() || Date.parse(approval.expiresAt) - current.getTime() > 12 * 3600_000) throw new Error('WALLET_ADMIN_APPROVAL_REQUIRED');
  const request = validateWalletAdministrationPublicRequest(options.request);
  const expiresAt = new Date(Math.min(Date.parse(approval.expiresAt), current.getTime() + 300_000)).toISOString();
  const immutable = { request, ownerId: options.ownerId, approval: { ownerId: approval.ownerId, channel: approval.channel, sessionId: approval.sessionId, expiresAt: approval.expiresAt }, approvedAt: current.toISOString(), expiresAt };
  const row: WalletAdministrationQueuedRequest = { ...immutable, state: 'queued', code: 'WALLET_OWNER_ADMIN_WORKER_REQUIRED', digest: hash(immutable) };
  let saved = row;
  await options.store.transaction(state => {
    const previous = readWalletAdministrationQueue(state.events).find(item => item.request.requestId === request.requestId);
    if (previous) { if (previous.ownerId !== options.ownerId || stable(previous.request) !== stable(request)) throw new Error('WALLET_ADMIN_IDEMPOTENCY_CONFLICT'); saved = previous; return; }
    append(state.events, row, current);
  });
  return saved;
}

export interface WalletAdministrationWorkerOptions {
  store: BackendStore;
  ownerId: string;
  /** The factory MUST pass this callback to createWalletAdministration. It
   * retains the original approval expiry across every awaited provider step. */
  administration(authorize: () => Promise<WalletAdministrationAuthority>): Promise<WalletAdministrationService> | WalletAdministrationService;
  approvalCurrent(approval: WalletAdministrationApproval): Promise<boolean>;
  sealedImports?(request: WalletAdministrationQueuedRequest): Promise<readonly { index: number; encryptedBundle: string }[] | undefined>;
  now?: () => Date;
  intervalMs?: number;
  maxRequests?: number;
  requestId?: string;
  /** Standalone admin CLI worker owns the event loop; embedded callers do not. */
  keepAlive?: boolean;
  record?(code: string): void;
}
const REQUIRED_ACTION = new Set(['WALLET_ADMIN_OS_ISOLATION_REQUIRED', 'WALLET_OWNER_ADMIN_CLIENT_REQUIRED', 'WALLET_ADMIN_CREDENTIAL_PROFILE_REQUIRED', 'WALLET_ADMIN_SIGNED_POLICY_REQUIRED', 'WALLET_ADMIN_SIGNED_POLICY_INVALID_OR_EXPIRED', 'WALLET_ADMIN_PROFILE_BINDING_REQUIRED', 'WALLET_SEALED_IMPORT_OWNER_INPUT_REQUIRED']);
function workerCode(error: unknown): string { return error instanceof Error && REQUIRED_ACTION.has(error.message) ? error.message : 'WALLET_ADMIN_WORKER_OUTCOME_AMBIGUOUS'; }

/** Separate attended admin process only. Mint service composition must never
 * construct this worker with an admin credential. stop drains durable writes. */
export function startWalletAdministrationWorker(options: WalletAdministrationWorkerOptions): { tick(): Promise<void>; stop(): Promise<void> } {
  const now = options.now ?? (() => new Date()); const interval = options.intervalMs ?? 15_000; const limit = options.maxRequests ?? 1;
  if (!validId(options.ownerId) || options.requestId !== undefined && !validId(options.requestId) || !Number.isSafeInteger(interval) || interval < 5000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 3) throw new Error('WALLET_ADMIN_WORKER_CONFIG_INVALID');
  let stopped = false; let running: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  const update = async (id: string, state: WalletAdministrationQueuedRequest['state'], code: string): Promise<void> => {
    await options.store.transaction(snapshot => { const current = readWalletAdministrationQueue(snapshot.events).find(row => row.request.requestId === id); if (current && current.state !== 'completed') append(snapshot.events, { ...current, state, code }, now()); });
  };
  const work = async (): Promise<void> => {
    const requests = readWalletAdministrationQueue(options.store.snapshot().events).filter(row => row.ownerId === options.ownerId && (options.requestId === undefined || row.request.requestId === options.requestId) && ['queued', 'started', 'owner-action-required'].includes(row.state)).sort((a, b) => a.approvedAt.localeCompare(b.approvedAt) || a.request.requestId.localeCompare(b.request.requestId)).slice(0, limit);
    for (const row of requests) {
      const fresh = async (): Promise<void> => {
        const current = now().getTime();
        if (!Number.isFinite(current) || current < Date.parse(row.approvedAt) || current >= Date.parse(row.expiresAt) || !await options.approvalCurrent(row.approval)) throw new Error('WALLET_ADMIN_APPROVAL_EXPIRED_OR_REVOKED');
      };
      try { await fresh(); } catch { await update(row.request.requestId, 'expired', 'WALLET_ADMIN_APPROVAL_EXPIRED_OR_REVOKED'); continue; }
      try {
        const administration = await options.administration(async () => { await fresh(); return { ownerId: options.ownerId, channel: 'owner-cli', expiresAt: row.expiresAt }; });
        await fresh();
        if (row.state === 'started') {
          // A crash after the queue claim can only inspect the backend/provider
          // inventory. Never infer absence of delivery and call create again.
          const result = await administration.reconcile(row.request.requestId);
          await update(row.request.requestId, result.state === 'completed' ? 'completed' : 'ambiguous', result.code); continue;
        }
        const sealedImports = row.request.kind === 'import' ? await options.sealedImports?.(row) : undefined;
        if (row.request.kind === 'import' && !sealedImports) { await update(row.request.requestId, 'owner-action-required', 'WALLET_SEALED_IMPORT_OWNER_INPUT_REQUIRED'); continue; }
        await fresh(); let claimed = false;
        await options.store.transaction(snapshot => {
          const current = readWalletAdministrationQueue(snapshot.events).find(item => item.request.requestId === row.request.requestId);
          if (current && ['queued', 'owner-action-required'].includes(current.state) && current.digest === row.digest && Date.parse(current.expiresAt) > now().getTime()) { append(snapshot.events, { ...current, state: 'started', code: 'WALLET_ADMIN_WORKER_STARTED' }, now()); claimed = true; }
        });
        if (!claimed) continue;
        await fresh(); await administration.request(row.request); await fresh();
        const result = await administration.execute(row.request.requestId, sealedImports ? { sealedImports } : {});
        await update(row.request.requestId, result.state === 'completed' ? 'completed' : 'ambiguous', result.code);
      } catch (error) {
        const code = workerCode(error);
        await update(row.request.requestId, REQUIRED_ACTION.has(code) ? 'owner-action-required' : 'ambiguous', code);
        try { options.record?.(code); } catch { /* diagnostics contain only fixed codes */ }
      }
    }
  };
  const tick = async (): Promise<void> => { if (stopped || running) return; running = work().catch(() => { try { options.record?.('WALLET_ADMIN_WORKER_UNAVAILABLE'); } catch { /* fixed diagnostics only */ } }); try { await running; } finally { running = undefined; } };
  const schedule = (delay: number): void => { if (!stopped) { timer = setTimeout(() => { void tick().finally(() => schedule(interval)); }, delay); if (!options.keepAlive) timer.unref(); } };
  schedule(0);
  return { tick, async stop() { stopped = true; if (timer) clearTimeout(timer); await running; } };
}
