/**
 * @module flashbots-auth
 *
 * Flashbots relay authentication signer loader.
 *
 * The Flashbots relay requires a dedicated authentication key that is separate
 * from every funded minting wallet. The secret store holds only a PATH
 * reference (`FLASHBOTS_KEY_PATH`); the key material lives on disk and is read
 * here at runtime. The key value is never logged, persisted, interpolated, or
 * exposed — only its presence/absence is used for readiness gating.
 */

import { readFile } from 'node:fs/promises';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { FlashbotsAuthSigner } from './types.js';
import { readSecret, hasSecret, type SecretScope } from './secrets.js';

/**
 * Build a Flashbots auth signer from a key file path supplied through the
 * approved secret reference. Never call this with a key value from config.
 */
export async function buildFlashbotsAuthSigner(
  keyPathRef: string | 'FLASHBOTS_KEY_PATH',
  scope: SecretScope = 'mainnet',
  root: string = 'Rets',
): Promise<FlashbotsAuthSigner> {
  let keyPath: string;
  if (keyPathRef === 'FLASHBOTS_KEY_PATH') {
    const configured = await readSecret('FLASHBOTS_KEY_PATH', scope, root);
    if (!configured) {
      throw new Error('FLASHBOTS_KEY_PATH is empty; Flashbots authentication cannot be resolved');
    }
    keyPath = configured;
  } else {
    keyPath = keyPathRef;
  }

  const keyMaterial = (await readFile(keyPath, 'utf8')).trim();
  const privateKey = normalizePrivateKey(keyMaterial);
  const account = privateKeyToAccount(privateKey);

  const authSigner: FlashbotsAuthSigner = {
    address: account.address,
    signMessage: async (message: Hex): Promise<Hex> =>
      account.signMessage({ message: { raw: message } }),
  };

  // The private key string remains in the JS string until GC; the practical
  // boundary is that it never enters logs, errors, config, or serialization.
  return authSigner;
}

/** Whether Flashbots authentication is configured (path reference present and readable). */
export function isFlashbotsAuthConfigured(
  scope: SecretScope = 'mainnet',
  root: string = 'Rets',
): Promise<boolean> {
  return hasSecret('FLASHBOTS_KEY_PATH', scope, root);
}

function normalizePrivateKey(raw: string): Hex {
  const withoutPrefix = raw.startsWith('0x') ? raw.slice(2) : raw;
  const hex = withoutPrefix.replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Flashbots auth key file must contain a 32-byte hex private key');
  }
  return `0x${hex}` as Hex;
}

/** Resolve the Flashbots auth signer address without exposing the key. */
export async function resolveFlashbotsAuthAddress(
  scope: SecretScope = 'mainnet',
  root: string = 'Rets',
): Promise<Address> {
  const signer = await buildFlashbotsAuthSigner('FLASHBOTS_KEY_PATH', scope, root);
  return signer.address;
}