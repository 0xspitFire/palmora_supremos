/**
 * @module secrets
 *
 * Read-only project secret-REFERENCE resolver.
 *
 * This module resolves configuration VALUES from the project-local secret store
 * (Rets/MINT_BOT_SECRETS.env for mainnet, Rets/TEST_BOT.env for testnet) by their
 * approved non-secret KEY NAMES. It never logs, prints, persists, interpolates,
 * or exposes secret values. Callers receive the resolved value only at runtime.
 *
 * Hard rule: no secret value may appear in logs, errors, serialization, or git.
 */

import { readFile } from 'node:fs/promises';

/** Approved non-secret reference names. Never add TEST_WALLET_PK* private-key names here. */
export type SecretName =
  | 'ETHEREUM_RPC_URL'
  | 'ETHEREUM_RPC_FBACK'
  | 'ETHEREUM_RPC_FBACK_II'
  | 'ROBINHOOD_RPC_URL'
  | 'ROBINHOOD_RPC_FBACK'
  | 'ROBINHOOD_ARCHIVE_RPC'
  | 'BASE_RPC_URL'
  | 'BASE_RPC_FBACK'
  | 'BASE_RPC_FBACK_II'
  | 'BASE_SEQUENCER_URL'
  | 'ANVIL_FORK_RPC'
  | 'FLASHBOTS_KEY_PATH'
  | 'WALLET_KEYSTORE_PATH'
  | 'TEST_WALLET_ADDR';

export type SecretScope = 'mainnet' | 'testnet';

/** Default project-local secret store location. */
export const SECRET_ROOT = 'Rets';

const SCOPE_FILE: Record<SecretScope, string> = {
  mainnet: 'MINT_BOT_SECRETS.env',
  testnet: 'TEST_BOT.env',
};

/**
 * Resolve a single value from the selected secret file, by approved key name.
 * Throws if the reference is missing or empty. The value is returned to the caller
 * and never emitted into logs or error messages.
 */
export async function readSecret(
  name: SecretName,
  scope: SecretScope,
  root: string = SECRET_ROOT,
): Promise<string> {
  const content = await readFile(`${root}/${SCOPE_FILE[scope]}`, 'utf8');
  const line = content
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => {
      if (!entry || entry.startsWith('#')) return false;
      const separator = entry.indexOf('=');
      return separator > 0 && entry.slice(0, separator).trim() === name;
    });

  if (!line) {
    throw new Error(`Missing configured secret reference: ${name}`);
  }
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (!value) {
    throw new Error(`Empty configured secret reference: ${name}`);
  }
  return value;
}

/**
 * Resolve a single reference while never exposing its value. Returns only whether
 * the reference exists and is non-empty (used for readiness gating).
 */
export async function hasSecret(
  name: SecretName,
  scope: SecretScope,
  root: string = SECRET_ROOT,
): Promise<boolean> {
  try {
    const value = await readSecret(name, scope, root);
    return value.length > 0;
  } catch {
    return false;
  }
}

/** Resolve a comma-separated endpoint list reference (e.g. RPC URL sets). */
export async function readSecretList(
  name: SecretName,
  scope: SecretScope,
  root: string = SECRET_ROOT,
): Promise<string[]> {
  const value = await readSecret(name, scope, root);
  return value
    .split(',')
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);
}

/**
 * Collect all configured RPC endpoints for a chain from its approved references.
 * The returned URL list is consumed by the RPC client; it is never logged.
 */
export async function resolveChainEndpoints(
  refs: readonly SecretName[],
  scope: SecretScope,
  root: string = SECRET_ROOT,
): Promise<string[]> {
  const endpoints: string[] = [];
  for (const ref of refs) {
    // Endpoint collection is best-effort: a missing reference merely yields no
    // endpoints for that slot rather than failing the whole chain resolution.
    try {
      const values = await readSecretList(ref, scope, root);
      endpoints.push(...values);
    } catch {
      // Missing reference for this slot — skip.
    }
  }
  return [...new Set(endpoints)];
}
