import { encryptPrivateKeyToBundle } from '@turnkey/crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { TurnkeyWalletReference } from './turnkey-signer.js';
import type { TurnkeyEnvironment } from './turnkey-policy.js';

export interface TurnkeyImportBinding {
  readonly organizationId: string;
  readonly userId: string;
  readonly environment: TurnkeyEnvironment;
}

export interface TurnkeyImportClient {
  initImportPrivateKey(input: {
    organizationId: string;
    userId: string;
    generateAppProofs?: boolean;
  }): Promise<{ importBundle: string }>;
  importPrivateKey(input: {
    organizationId: string;
    userId: string;
    privateKeyName: string;
    encryptedBundle: string;
    curve: 'CURVE_SECP256K1';
    addressFormats: ['ADDRESS_FORMAT_ETHEREUM'];
    generateAppProofs?: boolean;
  }): Promise<{
    privateKeyId: string;
    addresses: Array<{ format?: string; address?: string }>;
    activity: {
      organizationId: string;
      status: string;
      type: string;
      intent: { importPrivateKeyIntent?: { userId?: string } };
      result: { importPrivateKeyResult?: { privateKeyId?: string; addresses?: Array<{ format?: string; address?: string }> } };
    };
  }>;
  getPrivateKeys(input: { organizationId: string }): Promise<{ privateKeys: unknown[] }>;
}

export interface TurnkeyPrivateKeyImport {
  name: string;
  address: Address;
  privateKey: Hex;
}

export function validateImportedTurnkeyKey(
  result: {
    privateKeyId: string;
    addresses: Array<{ format?: string; address?: string }>;
    activity: {
      organizationId: string;
      status: string;
      type: string;
      intent: { importPrivateKeyIntent?: { userId?: string } };
      result: { importPrivateKeyResult?: { privateKeyId?: string; addresses?: Array<{ format?: string; address?: string }> } };
    };
  },
  binding: TurnkeyImportBinding,
  expectedAddress: Address,
): TurnkeyWalletReference {
  const activityResult = result.activity.result.importPrivateKeyResult;
  if (
    result.activity.organizationId !== binding.organizationId
    || result.activity.status !== 'ACTIVITY_STATUS_COMPLETED'
    || result.activity.type !== 'ACTIVITY_TYPE_IMPORT_PRIVATE_KEY'
    || result.activity.intent.importPrivateKeyIntent?.userId !== binding.userId
    || activityResult?.privateKeyId !== result.privateKeyId
    || JSON.stringify(activityResult.addresses ?? []) !== JSON.stringify(result.addresses)
  ) throw new Error('TURNKEY_IMPORTED_KEY_BINDING_INVALID');
  const address = result.addresses.find((candidate) => candidate.format === 'ADDRESS_FORMAT_ETHEREUM')?.address
    ?? result.addresses.find((candidate) => candidate.address)?.address;
  if (!address || address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('TURNKEY_IMPORTED_ADDRESS_MISMATCH');
  if (!result.privateKeyId) throw new Error('TURNKEY_IMPORTED_KEY_REFERENCE_MISSING');
  return { index: 0, address: expectedAddress, signWith: result.privateKeyId };
}

export async function importPrivateKeyToTurnkey(
  client: TurnkeyImportClient,
  organizationId: string,
  userId: string,
  input: TurnkeyPrivateKeyImport,
  binding: TurnkeyImportBinding,
): Promise<TurnkeyWalletReference> {
  if (binding.organizationId !== organizationId || binding.userId !== userId || (binding.environment !== 'production' && binding.environment !== 'testnet')) {
    throw new Error('TURNKEY_IMPORT_PROVIDER_BINDING_INVALID');
  }
  if (!/^0x[0-9a-f]{64}$/i.test(input.privateKey) || privateKeyToAccount(input.privateKey).address.toLowerCase() !== input.address.toLowerCase()) {
    throw new Error('TURNKEY_IMPORT_ADDRESS_MISMATCH');
  }
  const init = await client.initImportPrivateKey({ organizationId, userId, generateAppProofs: true });
  const encryptedBundle = await encryptPrivateKeyToBundle({
    privateKey: input.privateKey,
    keyFormat: 'HEXADECIMAL',
    importBundle: init.importBundle,
    userId,
    organizationId,
  });
  const result = await client.importPrivateKey({
    organizationId,
    userId,
    privateKeyName: input.name,
    encryptedBundle,
    curve: 'CURVE_SECP256K1',
    addressFormats: ['ADDRESS_FORMAT_ETHEREUM'],
    generateAppProofs: true,
  });
  const reference = validateImportedTurnkeyKey(result, binding, input.address);
  const inventory = await client.getPrivateKeys({ organizationId });
  const persisted = inventory.privateKeys.find((key): key is { privateKeyId: string; curve: string; addresses: Array<{ format?: string; address?: string }>; exported: boolean } => Boolean(key) && typeof key === 'object' && (key as { privateKeyId?: unknown }).privateKeyId === reference.signWith && Array.isArray((key as { addresses?: unknown }).addresses));
  const persistedAddress = persisted?.addresses.find((candidate) => candidate.format === 'ADDRESS_FORMAT_ETHEREUM')?.address
    ?? persisted?.addresses.find((candidate) => candidate.address)?.address;
  if (!persisted || persisted.curve !== 'CURVE_SECP256K1' || persisted.exported !== false || persistedAddress?.toLowerCase() !== input.address.toLowerCase()) {
    throw new Error('TURNKEY_IMPORTED_KEY_INVENTORY_INVALID');
  }
  return reference;
}
