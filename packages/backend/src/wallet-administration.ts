import { createHash } from 'node:crypto';
import { campaignInputDigest } from './evidence.js';
import type { BackendStore } from './store.js';
import type { BackendState, EventRecord, ExecutionChainId } from './types.js';

export interface WalletAdministrationAuthority { ownerId: string; channel: 'owner-cli' | 'telegram'; expiresAt: string; }
export interface WalletAdministrationKey { keyId: string; label: string; address: string | null; usable: boolean; issues: string[]; }
export interface WalletAdministrationInventory { organizationId: string; keys: WalletAdministrationKey[]; complete: boolean; issues: string[]; }
export interface WalletAdministrationReference { keyId: string; address: string; chainId: ExecutionChainId; }
export interface WalletAdministrationMutationResult { activityId: string; keys: WalletAdministrationKey[]; }
/** Administrative capability is injected only into an attended owner process.
 * This port deliberately has no signer, policy, funding or key-export methods. */
export interface WalletAdministrationPort {
  capability(): Promise<{ ownerAdminAvailable: boolean; organizationId: string; code: string }>;
  inventory(): Promise<WalletAdministrationInventory>;
  generate(input: { labels: readonly string[] }): Promise<WalletAdministrationMutationResult>;
  importSealed(input: { label: string; expectedAddress: string; encryptedBundle: string }): Promise<WalletAdministrationMutationResult>;
}
export interface WalletAdministrationRequestInput {
  requestId: string;
  kind: 'generate' | 'import';
  chainIds: readonly ExecutionChainId[];
  count?: number;
  expectedAddresses?: readonly string[];
}
export interface WalletAdministrationRequest {
  requestId: string; kind: 'generate' | 'import'; organizationId: string;
  chainIds: ExecutionChainId[];
  items: Array<{ index: number; label: string; expectedAddress?: string }>;
  state: 'planned' | 'started' | 'ambiguous' | 'completed';
  keys: WalletAdministrationKey[];
  activityIds: string[];
  code: string;
  specDigest: string;
}
export interface WalletAdministrationOptions {
  store: BackendStore;
  ownerId: string;
  authorize(): Promise<WalletAdministrationAuthority>;
  provider?: WalletAdministrationPort;
  authorizedWallets(): Promise<readonly WalletAdministrationReference[]>;
  now?: () => Date;
}
const ID = /^[A-Za-z0-9_.:-]{1,180}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const CODE = /^[A-Z][A-Z0-9_]{2,90}$/;
const REQUEST = 'wallet_administration_request';
const GROUP = 'wallet_administration_group';
const stable = (value: unknown): string => JSON.stringify(value, (_key, row: unknown) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);
const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
const isChain = (value: unknown): value is ExecutionChainId => value === 1 || value === 8453 || value === 4663;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const SAFE_OUTCOME_CODES = new Set(['WALLET_OWNER_CLI_ADMIN_REQUIRED', 'WALLET_OWNER_AUTHORITY_REQUIRED', 'WALLET_OWNER_ADMIN_CLIENT_REQUIRED', 'WALLET_PROVIDER_IDENTITY_INVALID', 'WALLET_PROVIDER_ACTIVITY_INVALID', 'WALLET_PROVIDER_CREATED_KEY_MISMATCH', 'WALLET_PROVIDER_INVENTORY_INCOMPLETE', 'WALLET_PROVIDER_INVENTORY_INVALID', 'WALLET_PROVIDER_ORGANIZATION_CHANGED', 'WALLET_PROVIDER_OUTCOME_AMBIGUOUS', 'WALLET_PROVIDER_RECONCILIATION_REQUIRED']);
const safeCode = (error: unknown): string => error instanceof Error && SAFE_OUTCOME_CODES.has(error.message) ? error.message : 'WALLET_PROVIDER_OUTCOME_AMBIGUOUS';

function requests(events: readonly EventRecord[]): Map<string, WalletAdministrationRequest> {
  const result = new Map<string, WalletAdministrationRequest>();
  const revisions = new Map<string, number>();
  for (const event of events) {
    const data = event.data;
    if (event.type !== REQUEST || data.version !== 1 || typeof data.payloadDigest !== 'string' || !data.request || typeof data.request !== 'object') continue;
    if (digest(data.request) !== data.payloadDigest) continue;
    const row = data.request as WalletAdministrationRequest;
    if (!ID.test(row.requestId) || !ID.test(row.organizationId) || !['generate', 'import'].includes(row.kind) || !['planned', 'started', 'ambiguous', 'completed'].includes(row.state) || !Array.isArray(row.items) || !Array.isArray(row.keys) || !Array.isArray(row.chainIds) || row.chainIds.some(chain => !isChain(chain))) continue;
    if (!Number.isSafeInteger(data.revision) || Number(data.revision) <= (revisions.get(row.requestId) ?? 0)) continue;
    result.set(row.requestId, row); revisions.set(row.requestId, Number(data.revision));
  }
  return result;
}
function appendRequest(state: BackendState, row: WalletAdministrationRequest, at: string): void {
  const payloadDigest = digest(row); const prior = state.events.filter(event => event.type === REQUEST && (event.data.request as WalletAdministrationRequest | undefined)?.requestId === row.requestId).sort((a, b) => Number(a.data.revision) - Number(b.data.revision)).at(-1);
  if (prior?.data.payloadDigest === payloadDigest) return;
  state.events.push({ id: `wallet_admin_${digest({ payloadDigest, previous: prior?.id ?? null })}`, type: REQUEST, at, data: { version: 1, revision: Number(prior?.data.revision ?? 0) + 1, request: row, payloadDigest } });
}
function referencesChecked(rows: readonly WalletAdministrationReference[]): void {
  if (!Array.isArray(rows) || rows.length > 30 || rows.some(row => !isChain(row.chainId) || !ID.test(row.keyId) || !ADDRESS.test(row.address)) || new Set(rows.map(row => `${row.chainId}:${row.address.toLowerCase()}`)).size !== rows.length) throw new Error('WALLET_AUTHORIZED_INVENTORY_INVALID');
}
function inventoryChecked(value: WalletAdministrationInventory): void {
  if (!value || !ID.test(value.organizationId) || value.complete !== true || !Array.isArray(value.keys) || value.keys.length > 500 || !Array.isArray(value.issues) || value.issues.some(code => !CODE.test(code)) || value.keys.some(row => !ID.test(row.keyId) || typeof row.label !== 'string' || row.label.length > 180 || typeof row.usable !== 'boolean' || !Array.isArray(row.issues) || row.issues.some(code => !CODE.test(code)) || row.address !== null && !ADDRESS.test(row.address)) || new Set(value.keys.map(row => row.keyId)).size !== value.keys.length) throw new Error('WALLET_PROVIDER_INVENTORY_INCOMPLETE');
  const usable = value.keys.filter(key => key.usable);
  if (usable.some(key => key.address === null || key.issues.length > 0) || new Set(usable.map(row => row.address!.toLowerCase())).size !== usable.length) throw new Error('WALLET_PROVIDER_INVENTORY_INVALID');
}
/** Only the official HPKE envelope format is accepted. No plaintext or
 * mnemonic conversion happens here; bundles remain in the owner process. */
export function validateWalletSealedImport(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('WALLET_SEALED_IMPORT_REQUIRED');
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error('WALLET_SEALED_IMPORT_REQUIRED'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('WALLET_SEALED_IMPORT_REQUIRED');
  const row = parsed as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || typeof row.encappedPublic !== 'string' || !/^04[0-9a-f]{128}$/i.test(row.encappedPublic) || typeof row.ciphertext !== 'string' || !/^[0-9a-f]{96}$/i.test(row.ciphertext)) throw new Error('WALLET_SEALED_IMPORT_REQUIRED');
}
function pendingReasons(state: BackendState, addresses: Set<string>): string[] {
  const reasons = new Set<string>();
  if (state.reservations.some(row => addresses.has(row.wallet.toLowerCase()) && (row.status === 'reserved' || row.status === 'reorged'))) reasons.add('WALLET_PENDING_EXPOSURE');
  for (const run of state.runs.filter(row => row.state === 'Armed' || row.state === 'Active')) {
    const intent = state.intents.find(row => row.id === run.intentId && row.runId === run.id);
    if (!intent || intent.wallets.some(wallet => addresses.has(wallet.toLowerCase()))) reasons.add('WALLET_ACTIVE_RUN');
  }
  if (state.attempts.some(row => addresses.has(row.wallet.toLowerCase()) && !['Confirmed', 'Failed', 'Aborted'].includes(row.state))) reasons.add('WALLET_UNRESOLVED_ATTEMPT');
  return [...reasons].sort();
}

/** Public durable state only. It never changes the active fleet, provider
 * policies, offline approvals, funding, campaign approvals or execution caps. */
export function createWalletAdministration(options: WalletAdministrationOptions) {
  const now = options.now ?? (() => new Date());
  if (!ID.test(options.ownerId)) throw new Error('WALLET_OWNER_AUTHORITY_REQUIRED');
  const authorize = async (ownerCli = false): Promise<WalletAdministrationAuthority> => {
    const authority = await options.authorize(); const current = now().getTime(); const expires = Date.parse(authority.expiresAt);
    if (authority.ownerId !== options.ownerId || !['owner-cli', 'telegram'].includes(authority.channel) || !Number.isFinite(current) || !Number.isFinite(expires) || expires <= current || expires - current > 12 * 3600_000 || ownerCli && authority.channel !== 'owner-cli') throw new Error(ownerCli ? 'WALLET_OWNER_CLI_ADMIN_REQUIRED' : 'WALLET_OWNER_AUTHORITY_REQUIRED');
    return authority;
  };
  const inventory = async (): Promise<WalletAdministrationInventory> => {
    await authorize(); if (!options.provider) throw new Error('WALLET_OWNER_ADMIN_CLIENT_REQUIRED');
    const value = await options.provider.inventory(); inventoryChecked(value); return value;
  };
  const requestById = (id: string): WalletAdministrationRequest => { const row = requests(options.store.snapshot().events).get(id); if (!row) throw new Error('WALLET_ADMIN_REQUEST_NOT_FOUND'); return row; };
  const storeResult = async (id: string, update: (row: WalletAdministrationRequest) => WalletAdministrationRequest): Promise<WalletAdministrationRequest> => {
    let saved!: WalletAdministrationRequest;
    await options.store.transaction(state => { const current = requests(state.events).get(id); if (!current) throw new Error('WALLET_ADMIN_REQUEST_NOT_FOUND'); saved = update(current); appendRequest(state, saved, now().toISOString()); });
    return saved;
  };
  const reconcile = async (id: string): Promise<WalletAdministrationRequest> => {
    await authorize(); const row = requestById(id); if (row.state === 'planned') return row;
    const current = await inventory(); await authorize(); if (current.organizationId !== row.organizationId) throw new Error('WALLET_PROVIDER_ORGANIZATION_CHANGED');
    const matched = row.items.map(item => current.keys.filter(key => key.label === item.label && key.usable && key.address && (!item.expectedAddress || same(key.address, item.expectedAddress))));
    // Inventory matches permit a public enrollment draft, not an assertion that
    // an otherwise lost provider activity receipt was observed.
    if (matched.some(keys => keys.length !== 1)) return storeResult(id, request => ({ ...request, state: 'ambiguous', code: 'WALLET_PROVIDER_RECONCILIATION_REQUIRED' }));
    return storeResult(id, request => ({ ...request, state: 'completed', keys: matched.map(keys => keys[0]!), code: request.activityIds.length === (request.kind === 'generate' ? 1 : request.items.length) ? 'WALLET_PROVIDER_KEYS_VERIFIED' : 'WALLET_INVENTORY_LABELS_RECONCILED_OWNER_REVIEW' }));
  };
  const groups = (events: readonly EventRecord[]) => {
    const result = new Map<string, { id: string; chainId: ExecutionChainId; name: string; addresses: string[] }>();
    const revisions = new Map<string, number>();
    for (const event of events) if (event.type === GROUP && typeof event.data.id === 'string' && isChain(event.data.chainId) && typeof event.data.name === 'string' && Array.isArray(event.data.addresses) && Number(event.data.revision) > (revisions.get(event.data.id) ?? 0)) { result.set(event.data.id, { id: event.data.id, chainId: event.data.chainId, name: event.data.name, addresses: event.data.addresses as string[] }); revisions.set(event.data.id, Number(event.data.revision)); }
    return result;
  };
  return {
    inventory,
    async status() { await authorize(); const events = options.store.snapshot().events; return { requests: [...requests(events).values()], groups: [...groups(events).values()], campaignSelections: events.filter(event => event.type === 'wallet_administration_campaign_selection').map(event => event.data), enrollmentDrafts: events.filter(event => event.type === 'wallet_administration_enrollment_draft').map(event => event.data), retirementDrafts: events.filter(event => event.type === 'wallet_administration_retirement_draft').map(event => event.data), activeFleetMutated: false as const }; },
    async request(input: WalletAdministrationRequestInput): Promise<WalletAdministrationRequest> {
      const authority = await authorize();
      if (!input || Object.keys(input).some(key => !['requestId', 'kind', 'chainIds', 'count', 'expectedAddresses'].includes(key)) || !ID.test(input.requestId) || !['generate', 'import'].includes(input.kind) || !Array.isArray(input.chainIds) || input.chainIds.length < 1 || input.chainIds.length > 3 || input.chainIds.some(chain => !isChain(chain)) || new Set(input.chainIds).size !== input.chainIds.length) throw new Error('WALLET_ADMIN_REQUEST_INVALID');
      if (input.kind === 'import' && authority.channel !== 'owner-cli') throw new Error('WALLET_OWNER_CLI_ADMIN_REQUIRED');
      const count = input.kind === 'generate' ? input.count : input.expectedAddresses?.length;
      if (!Number.isSafeInteger(count) || count! < 1 || count! > 10 || input.kind === 'generate' && input.expectedAddresses !== undefined || input.kind === 'import' && (input.count !== undefined || input.expectedAddresses!.some(address => !ADDRESS.test(address)) || new Set(input.expectedAddresses!.map(address => address.toLowerCase())).size !== count)) throw new Error('WALLET_ADMIN_REQUEST_INVALID');
      const current = await inventory(); await authorize(); const chainIds = [...input.chainIds].sort((a, b) => a - b);
      const items = Array.from({ length: count! }, (_, index) => ({ index, label: `mintbot-admin-${digest({ id: input.requestId, org: current.organizationId }).slice(0, 32)}-${index}`, ...(input.kind === 'import' ? { expectedAddress: input.expectedAddresses![index]!.toLowerCase() } : {}) }));
      const spec = { requestId: input.requestId, kind: input.kind, organizationId: current.organizationId, chainIds, items }; const specDigest = digest(spec);
      const row: WalletAdministrationRequest = { ...spec, state: 'planned', keys: [], activityIds: [], code: 'WALLET_OWNER_PROVIDER_ACTION_PENDING', specDigest };
      await options.store.transaction(state => { const existing = requests(state.events).get(input.requestId); if (existing && existing.specDigest !== specDigest) throw new Error('WALLET_ADMIN_IDEMPOTENCY_CONFLICT'); if (!existing) appendRequest(state, row, now().toISOString()); });
      return requestById(input.requestId);
    },
    async execute(id: string, input: { sealedImports?: readonly { index: number; encryptedBundle: string }[] } = {}): Promise<WalletAdministrationRequest> {
      await authorize(true); let row = requestById(id);
      if (row.state !== 'planned') return reconcile(id);
      if (!options.provider) throw new Error('WALLET_OWNER_ADMIN_CLIENT_REQUIRED');
      const capability = await options.provider.capability();
      if (!capability.ownerAdminAvailable) throw new Error('WALLET_OWNER_ADMIN_CLIENT_REQUIRED');
      if (capability.organizationId !== row.organizationId) throw new Error('WALLET_PROVIDER_ORGANIZATION_CHANGED');
      if (Object.keys(input).some(key => key !== 'sealedImports')) throw new Error('WALLET_SEALED_IMPORT_REQUIRED');
      const bundles = input.sealedImports ?? [];
      if (row.kind === 'generate' && bundles.length || row.kind === 'import' && (bundles.length !== row.items.length || new Set(bundles.map(item => item.index)).size !== row.items.length || bundles.some(item => !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= row.items.length || Object.keys(item).some(key => !['index', 'encryptedBundle'].includes(key))))) throw new Error('WALLET_SEALED_IMPORT_REQUIRED');
      for (const item of bundles) validateWalletSealedImport(item.encryptedBundle);
      const before = await inventory(); await authorize(true);
      if (before.organizationId !== row.organizationId) throw new Error('WALLET_PROVIDER_ORGANIZATION_CHANGED');
      if (before.keys.some(key => row.items.some(item => item.label === key.label || item.expectedAddress && key.address && same(item.expectedAddress, key.address)))) throw new Error('WALLET_PROVIDER_LABEL_OR_ADDRESS_ALREADY_EXISTS');
      // Both sessions/processes can read inventory, but only one may make the
      // irreversible provider call after this durable claim.
      let claimed = false;
      await options.store.transaction(state => { const current = requests(state.events).get(id); if (current?.state === 'planned') { appendRequest(state, { ...current, state: 'started', code: 'WALLET_PROVIDER_OUTCOME_PENDING' }, now().toISOString()); claimed = true; } });
      if (!claimed) return requestById(id);
      try {
        await authorize(true);
        if (row.kind === 'generate') {
          const result = await options.provider.generate({ labels: row.items.map(item => item.label) });
          if (!ID.test(result.activityId)) throw new Error('WALLET_PROVIDER_ACTIVITY_INVALID');
          row = await storeResult(id, current => ({ ...current, activityIds: [result.activityId], keys: [], code: 'WALLET_PROVIDER_INVENTORY_CHECK_PENDING' }));
        } else {
          for (const item of row.items) {
            await authorize(true);
            const result = await options.provider.importSealed({ label: item.label, expectedAddress: item.expectedAddress!, encryptedBundle: bundles.find(bundle => bundle.index === item.index)!.encryptedBundle });
            if (!ID.test(result.activityId)) throw new Error('WALLET_PROVIDER_ACTIVITY_INVALID');
            row = await storeResult(id, current => ({ ...current, activityIds: [...current.activityIds, result.activityId], keys: [], code: 'WALLET_PROVIDER_INVENTORY_CHECK_PENDING' }));
          }
        }
        return await reconcile(id);
      } catch (error) { return storeResult(id, current => ({ ...current, state: 'ambiguous', code: safeCode(error) })); }
    },
    reconcile,
    async saveGroup(input: { id: string; chainId: ExecutionChainId; name: string; addresses: readonly string[] }) {
      await authorize();
      if (!ID.test(input.id) || !isChain(input.chainId) || typeof input.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(input.name) || !Array.isArray(input.addresses) || input.addresses.length > 50 || input.addresses.some(address => !ADDRESS.test(address)) || new Set(input.addresses.map(address => address.toLowerCase())).size !== input.addresses.length) throw new Error('WALLET_GROUP_INVALID');
      const current = await inventory(); await authorize(); const known = new Set(current.keys.filter(key => key.usable && key.address).map(key => key.address!.toLowerCase()));
      if (input.addresses.some(address => !known.has(address.toLowerCase()))) throw new Error('WALLET_GROUP_CUSTODY_REFERENCE_UNKNOWN');
      const data = { id: input.id, chainId: input.chainId, name: input.name, addresses: input.addresses.map(address => address.toLowerCase()) };
      await options.store.transaction(state => { const prior = groups(state.events).get(input.id); if (prior && prior.chainId !== input.chainId) throw new Error('WALLET_GROUP_CHAIN_IMMUTABLE'); const previous = state.events.filter(event => event.type === GROUP && event.data.id === input.id).sort((a, b) => Number(a.data.revision) - Number(b.data.revision)).at(-1); if (stable(prior) !== stable(data)) state.events.push({ id: `wallet_group_${digest({ data, previous: previous?.id ?? null })}`, type: GROUP, at: now().toISOString(), data: { ...data, revision: Number(previous?.data.revision ?? 0) + 1 } }); });
      return data;
    },
    async assignCampaign(input: { campaignId: string; groupId: string }) {
      await authorize();
      const group = groups(options.store.snapshot().events).get(input.groupId); if (!group) throw new Error('WALLET_GROUP_NOT_FOUND');
      const authorized = await options.authorizedWallets(); await authorize(); referencesChecked(authorized);
      if (!group.addresses.length || group.addresses.length > 10 || group.addresses.some(address => !authorized.some(key => key.chainId === group.chainId && same(key.address, address)))) throw new Error('WALLET_CAMPAIGN_ENROLLMENT_REQUIRED');
      let data!: { campaignId: string; groupId: string; chainId: ExecutionChainId; addresses: string[]; campaignDigest: string; mutation: 'selection-draft-only' };
      await options.store.transaction(state => {
        const campaign = state.campaigns.find(row => row.id === input.campaignId);
        if (!campaign || campaign.chainId !== group.chainId || campaign.state !== 'Draft') throw new Error('WALLET_CAMPAIGN_DRAFT_REQUIRED');
        if (stable(groups(state.events).get(group.id)) !== stable(group)) throw new Error('WALLET_GROUP_CHANGED');
        data = { campaignId: campaign.id, groupId: group.id, chainId: group.chainId, addresses: [...group.addresses], campaignDigest: campaignInputDigest(campaign), mutation: 'selection-draft-only' };
        const id = `wallet_assignment_${digest(data)}`; if (!state.events.some(event => event.id === id)) state.events.push({ id, type: 'wallet_administration_campaign_selection', at: now().toISOString(), data });
      });
      return data;
    },
    async selectEnrollment(input: { requestId: string; keyIds: readonly string[]; replaceKeyIds?: readonly string[] }) {
      await authorize(); const request = requestById(input.requestId); if (request.state !== 'completed') throw new Error('WALLET_PROVIDER_RECONCILIATION_REQUIRED');
      const current = await inventory(); await authorize(); if (current.organizationId !== request.organizationId) throw new Error('WALLET_PROVIDER_ORGANIZATION_CHANGED');
      const selected = input.keyIds.map(id => current.keys.find(key => key.keyId === id && key.usable && request.keys.some(saved => saved.keyId === key.keyId && saved.address && key.address && same(saved.address, key.address))));
      if (!selected.length || selected.length > 10 || selected.some(key => !key) || new Set(input.keyIds).size !== selected.length) throw new Error('WALLET_ENROLLMENT_SELECTION_INVALID');
      const authorized = await options.authorizedWallets(); await authorize(); referencesChecked(authorized); const replace = input.replaceKeyIds ?? [];
      if (new Set(replace).size !== replace.length || replace.some(id => !authorized.some(key => key.keyId === id))) throw new Error('WALLET_ENROLLMENT_REPLACEMENT_INVALID');
      const removing = new Set(authorized.filter(key => replace.includes(key.keyId)).map(key => key.address.toLowerCase()));
      const chains = request.chainIds.map(chainId => {
        const keep = authorized.filter(key => key.chainId === chainId && !replace.includes(key.keyId));
        const refs = [...keep.map(key => ({ address: key.address.toLowerCase(), signWith: key.keyId })), ...selected.map(key => ({ address: key!.address!.toLowerCase(), signWith: key!.keyId }))];
        if (refs.length > 10 || new Set(refs.map(key => key.address)).size !== refs.length) throw new Error('WALLET_ENROLLMENT_DRAFT_FLEET_LIMIT');
        return { chainId, wallets: refs.map((key, index) => ({ index, ...key })) };
      });
      const data = { requestId: request.requestId, chains, replacedKeyIds: [...replace], state: 'pending-owner-policy-rebind', activeFleetChanged: false, requiresOfflineOwnerApproval: true };
      await options.store.transaction(state => { const blockers = pendingReasons(state, removing); if (blockers.length) throw new Error(blockers[0]); const id = `wallet_enrollment_${digest(data)}`; if (!state.events.some(event => event.id === id)) state.events.push({ id, type: 'wallet_administration_enrollment_draft', at: now().toISOString(), data }); });
      return data;
    },
    async draftRetirement(input: { requestId: string; keyIds: readonly string[] }) {
      await authorize(); if (!ID.test(input.requestId) || !Array.isArray(input.keyIds) || !input.keyIds.length || input.keyIds.length > 50 || input.keyIds.some(id => !ID.test(id)) || new Set(input.keyIds).size !== input.keyIds.length) throw new Error('WALLET_RETIREMENT_INVALID');
      const current = await inventory(); const retiring = input.keyIds.map(id => current.keys.find(key => key.keyId === id));
      if (retiring.some(key => !key?.address)) throw new Error('WALLET_RETIREMENT_REFERENCE_UNKNOWN');
      const authorized = await options.authorizedWallets(); await authorize(); referencesChecked(authorized);
      const authorizedKeys = input.keyIds.filter(id => authorized.some(key => key.keyId === id));
      const addresses = new Set(retiring.map(key => key!.address!.toLowerCase()));
      const data = { requestId: input.requestId, keyIds: [...input.keyIds], addresses: [...addresses].sort(), organizationId: current.organizationId, state: authorizedKeys.length ? 'pending-owner-rebind-revoke' : 'ready-for-owner-retirement', currentlyAuthorizedKeyIds: authorizedKeys, providerKeysDeleted: false, activeFleetChanged: false };
      await options.store.transaction(state => { const blockers = pendingReasons(state, addresses); if (blockers.length) throw new Error(blockers[0]); const prior = state.events.find(event => event.type === 'wallet_administration_retirement_draft' && event.data.requestId === input.requestId); if (prior && stable(prior.data) !== stable(data)) throw new Error('WALLET_ADMIN_IDEMPOTENCY_CONFLICT'); if (!prior) state.events.push({ id: `wallet_retirement_${digest(data)}`, type: 'wallet_administration_retirement_draft', at: now().toISOString(), data }); });
      return data;
    },
  };
}
