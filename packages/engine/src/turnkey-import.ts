import { encryptPrivateKeyToBundle } from '@turnkey/crypto';
import type { Address, Hex } from 'viem';
import type { TurnkeyWalletReference } from './turnkey-signer.js';

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
  }>;
}

export interface TurnkeyPrivateKeyImport {
  name: string;
  address: Address;
  privateKey: Hex;
}

export async function importPrivateKeyToTurnkey(
  client: TurnkeyImportClient,
  organizationId: string,
  userId: string,
  input: TurnkeyPrivateKeyImport,
): Promise<TurnkeyWalletReference> {
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
  const address = result.addresses.find((candidate) => candidate.format === 'ADDRESS_FORMAT_ETHEREUM')?.address
    ?? result.addresses.find((candidate) => candidate.address)?.address;
  if (!address || address.toLowerCase() !== input.address.toLowerCase()) throw new Error('TURNKEY_IMPORTED_ADDRESS_MISMATCH');
  if (!result.privateKeyId) throw new Error('TURNKEY_IMPORTED_KEY_REFERENCE_MISSING');
  return { index: 0, address: input.address, signWith: result.privateKeyId };
}
