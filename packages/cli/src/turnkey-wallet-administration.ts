import type { WalletAdministrationInventory, WalletAdministrationKey, WalletAdministrationMutationResult, WalletAdministrationPort } from '@mint-bot/backend';

/** Structural subset of installed @turnkey/sdk-server 8.5.0. SDK command bodies
 * use standalone secp256k1 Private Keys, not HD wallet accounts. The owner
 * process supplies this client; the mint runtime never gains an admin stamp.
 */
export interface TurnkeyWalletAdministrationClient {
  getWhoami(input: { organizationId: string }): Promise<unknown>;
  getPrivateKeys(input: { organizationId: string }): Promise<unknown>;
  createPrivateKeys?(input: { organizationId: string; privateKeys: Array<{ privateKeyName: string; curve: 'CURVE_SECP256K1'; privateKeyTags: string[]; addressFormats: ['ADDRESS_FORMAT_ETHEREUM'] }>; generateAppProofs: boolean }): Promise<unknown>;
  importPrivateKey?(input: { organizationId: string; userId: string; privateKeyName: string; encryptedBundle: string; curve: 'CURVE_SECP256K1'; addressFormats: ['ADDRESS_FORMAT_ETHEREUM']; generateAppProofs: boolean }): Promise<unknown>;
}
export interface TurnkeyWalletAdministrationOptions {
  client: TurnkeyWalletAdministrationClient;
  organizationId: string;
  ownerUserId: string;
  /** Must be explicitly supplied by the attended owner composition. The
   * presence of SDK methods alone never makes a mint runtime an admin. */
  credentialPurpose?: 'mint-runtime' | 'owner-admin';
  timeoutMs?: number;
}
const ID = /^[A-Za-z0-9_.:-]{1,180}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const LABEL = /^[A-Za-z0-9_.:-]{1,180}$/;
const SAFE_CODES = new Set(['WALLET_PROVIDER_OUTCOME_AMBIGUOUS', 'WALLET_PROVIDER_IDENTITY_INVALID', 'WALLET_OWNER_ADMIN_CLIENT_REQUIRED', 'WALLET_PROVIDER_INVENTORY_INCOMPLETE', 'WALLET_PROVIDER_ACTIVITY_INVALID', 'WALLET_PROVIDER_CREATED_KEY_MISMATCH', 'WALLET_PROVIDER_GENERATION_INVALID', 'WALLET_PROVIDER_IMPORT_INVALID', 'WALLET_SEALED_IMPORT_REQUIRED']);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const stable = (value: unknown): string => JSON.stringify(value, (_key, row: unknown) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);

function addressFrom(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.map(object).filter(row => row?.format === 'ADDRESS_FORMAT_ETHEREUM');
  return rows.length === 1 && typeof rows[0]!.address === 'string' && ADDRESS.test(rows[0]!.address) ? rows[0]!.address.toLowerCase() : undefined;
}

export function parseTurnkeyWalletAdministrationInventory(value: unknown, organizationId: string): WalletAdministrationInventory {
  const body = object(value); if (!ID.test(organizationId) || !Array.isArray(body?.privateKeys) || body.privateKeys.length > 500) throw new Error('WALLET_PROVIDER_INVENTORY_INCOMPLETE');
  const keys: WalletAdministrationKey[] = []; let incomplete = false;
  for (const raw of body.privateKeys) {
    const row = object(raw);
    if (!row || typeof row.privateKeyId !== 'string' || !ID.test(row.privateKeyId)) { incomplete = true; continue; }
    const address = addressFrom(row.addresses) ?? null; const issues: string[] = [];
    if (row.curve !== 'CURVE_SECP256K1') issues.push('WALLET_KEY_CURVE_UNSUPPORTED');
    if (row.exported !== false) issues.push('WALLET_KEY_EXPORT_STATE_UNSAFE');
    if (!address) issues.push('WALLET_KEY_ADDRESS_INVALID');
    const label = typeof row.privateKeyName === 'string' && row.privateKeyName.length <= 180 && /^[A-Za-z0-9 ._:-]*$/.test(row.privateKeyName) ? row.privateKeyName : '[unavailable-label]';
    if (label === '[unavailable-label]') issues.push('WALLET_KEY_LABEL_UNAVAILABLE');
    keys.push({ keyId: row.privateKeyId, label, address, usable: issues.length === 0, issues });
  }
  if (new Set(keys.map(key => key.keyId)).size !== keys.length) incomplete = true;
  const addresses = new Map<string, number>(); for (const key of keys) if (key.address) addresses.set(key.address, (addresses.get(key.address) ?? 0) + 1);
  for (const key of keys) if (key.address && addresses.get(key.address)! > 1) { key.usable = false; key.issues.push('WALLET_KEY_ADDRESS_DUPLICATE'); }
  return { organizationId, keys, complete: !incomplete, issues: incomplete ? ['WALLET_PROVIDER_INVENTORY_INCOMPLETE'] : [] };
}

function sealedChecked(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('WALLET_SEALED_IMPORT_REQUIRED');
  let row: Record<string, unknown> | undefined;
  try { row = object(JSON.parse(value)); } catch { throw new Error('WALLET_SEALED_IMPORT_REQUIRED'); }
  if (!row || Object.keys(row).length !== 2 || typeof row.encappedPublic !== 'string' || !/^04[0-9a-f]{128}$/i.test(row.encappedPublic) || typeof row.ciphertext !== 'string' || !/^[0-9a-f]{96}$/i.test(row.ciphertext)) throw new Error('WALLET_SEALED_IMPORT_REQUIRED');
}

export function createTurnkeyWalletAdministration(options: TurnkeyWalletAdministrationOptions): WalletAdministrationPort {
  const timeout = options.timeoutMs ?? 20_000;
  if (!ID.test(options.organizationId) || !ID.test(options.ownerUserId) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error('WALLET_OWNER_ADMIN_CONFIGURATION_INVALID');
  const bounded = async <T,>(work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('WALLET_PROVIDER_OUTCOME_AMBIGUOUS')), timeout); })]); }
    catch (error) { throw new Error(error instanceof Error && SAFE_CODES.has(error.message) ? error.message : 'WALLET_PROVIDER_OUTCOME_AMBIGUOUS'); }
    finally { if (timer) clearTimeout(timer); }
  };
  const identity = async (): Promise<{ owner: boolean }> => {
    const response = object(await options.client.getWhoami({ organizationId: options.organizationId }));
    if (response?.organizationId !== options.organizationId || typeof response.userId !== 'string') throw new Error('WALLET_PROVIDER_IDENTITY_INVALID');
    return { owner: response.userId === options.ownerUserId };
  };
  const requireAdmin = async (): Promise<void> => { if (options.credentialPurpose !== 'owner-admin' || !(await identity()).owner) throw new Error('WALLET_OWNER_ADMIN_CLIENT_REQUIRED'); };
  const inventory = (): Promise<WalletAdministrationInventory> => bounded(async () => {
    await identity(); const result = parseTurnkeyWalletAdministrationInventory(await options.client.getPrivateKeys({ organizationId: options.organizationId }), options.organizationId); await identity(); return result;
  });
  const activityChecked = (value: unknown, type: string): Record<string, unknown> => {
    const activity = object(object(value)?.activity);
    if (!activity || typeof activity.id !== 'string' || !ID.test(activity.id) || activity.organizationId !== options.organizationId || activity.status !== 'ACTIVITY_STATUS_COMPLETED' || activity.type !== type || !object(activity.intent) || !object(activity.result)) throw new Error('WALLET_PROVIDER_ACTIVITY_INVALID');
    return activity;
  };
  const matchedKeys = async (ids: readonly string[], labels: readonly string[], addresses?: readonly string[]): Promise<WalletAdministrationKey[]> => {
    const current = await inventory(); if (!current.complete || ids.length !== labels.length || new Set(ids).size !== ids.length) throw new Error('WALLET_PROVIDER_INVENTORY_INCOMPLETE');
    return ids.map((id, index) => {
      const row = current.keys.find(key => key.keyId === id && key.label === labels[index] && key.usable && key.address && (!addresses || key.address === addresses[index]!.toLowerCase()));
      if (!row) throw new Error('WALLET_PROVIDER_CREATED_KEY_MISMATCH');
      return row;
    });
  };
  return {
    inventory,
    capability: () => bounded(async () => {
      const who = await identity();
      const ownerAdminAvailable = options.credentialPurpose === 'owner-admin' && who.owner && typeof options.client.createPrivateKeys === 'function' && typeof options.client.importPrivateKey === 'function';
      return { ownerAdminAvailable, organizationId: options.organizationId, code: ownerAdminAvailable ? 'WALLET_OWNER_ADMIN_AVAILABLE' : 'WALLET_OWNER_ADMIN_CLIENT_REQUIRED' };
    }),
    generate: input => bounded(async () => {
      await requireAdmin(); if (!options.client.createPrivateKeys) throw new Error('WALLET_OWNER_ADMIN_CLIENT_REQUIRED');
      if (!Array.isArray(input.labels) || input.labels.length < 1 || input.labels.length > 10 || input.labels.some(label => !LABEL.test(label)) || new Set(input.labels).size !== input.labels.length) throw new Error('WALLET_PROVIDER_GENERATION_INVALID');
      const parameters = input.labels.map(privateKeyName => ({ privateKeyName, curve: 'CURVE_SECP256K1' as const, privateKeyTags: [] as string[], addressFormats: ['ADDRESS_FORMAT_ETHEREUM'] as ['ADDRESS_FORMAT_ETHEREUM'] }));
      const response = object(await options.client.createPrivateKeys({ organizationId: options.organizationId, privateKeys: parameters, generateAppProofs: true }));
      const activity = activityChecked(response, 'ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2');
      const intent = object(object(activity.intent)?.createPrivateKeysIntentV2);
      const result = object(object(activity.result)?.createPrivateKeysResultV2);
      if (stable(intent?.privateKeys) !== stable(parameters) || !Array.isArray(response?.privateKeys) || response.privateKeys.length !== parameters.length || stable(result?.privateKeys) !== stable(response.privateKeys)) throw new Error('WALLET_PROVIDER_ACTIVITY_INVALID');
      const ids = response.privateKeys.map(raw => { const key = object(raw); if (!key || typeof key.privateKeyId !== 'string' || !ID.test(key.privateKeyId) || !addressFrom(key.addresses)) throw new Error('WALLET_PROVIDER_CREATED_KEY_MISMATCH'); return key.privateKeyId; });
      const keys = await matchedKeys(ids, input.labels, response.privateKeys.map(raw => addressFrom(object(raw)?.addresses)!));
      return { activityId: String(activity.id), keys } satisfies WalletAdministrationMutationResult;
    }),
    importSealed: input => bounded(async () => {
      await requireAdmin(); if (!options.client.importPrivateKey) throw new Error('WALLET_OWNER_ADMIN_CLIENT_REQUIRED');
      if (!LABEL.test(input.label) || !ADDRESS.test(input.expectedAddress)) throw new Error('WALLET_PROVIDER_IMPORT_INVALID'); sealedChecked(input.encryptedBundle);
      const parameters = { userId: options.ownerUserId, privateKeyName: input.label, encryptedBundle: input.encryptedBundle, curve: 'CURVE_SECP256K1' as const, addressFormats: ['ADDRESS_FORMAT_ETHEREUM'] as ['ADDRESS_FORMAT_ETHEREUM'] };
      const response = object(await options.client.importPrivateKey({ organizationId: options.organizationId, ...parameters, generateAppProofs: true }));
      const activity = activityChecked(response, 'ACTIVITY_TYPE_IMPORT_PRIVATE_KEY');
      const intent = object(object(activity.intent)?.importPrivateKeyIntent);
      const result = object(object(activity.result)?.importPrivateKeyResult);
      if (stable(intent) !== stable(parameters) || typeof response?.privateKeyId !== 'string' || !ID.test(response.privateKeyId) || result?.privateKeyId !== response.privateKeyId || stable(result?.addresses) !== stable(response.addresses) || addressFrom(response.addresses) !== input.expectedAddress.toLowerCase()) throw new Error('WALLET_PROVIDER_ACTIVITY_INVALID');
      const keys = await matchedKeys([response.privateKeyId], [input.label], [input.expectedAddress]);
      return { activityId: String(activity.id), keys } satisfies WalletAdministrationMutationResult;
    }),
  };
}
