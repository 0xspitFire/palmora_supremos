import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const ALLOWED_FILES = new Set(['MINT_BOT_SECRETS', 'MINT_BOT_SECRETS.env', 'TEST_BOT', 'TEST_BOT.env']);

/**
 * Read one approved secret-store file without writing, interpolating, or
 * logging its values. Callers should retain only the value needed by an
 * immediate integration boundary.
 */
export async function loadSecretStore(filePath) {
  const absolutePath = resolve(filePath);
  if (basename(dirname(absolutePath)) !== 'Rets' || !ALLOWED_FILES.has(basename(absolutePath))) {
    throw new Error('Secret store filename is not approved');
  }

  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Secret store must be a regular file');
  }

  const source = await readFile(absolutePath, 'utf8');
  const values = new Map();
  for (const [lineNumber, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Invalid secret store line ${lineNumber + 1}`);
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !value) {
      throw new Error(`Invalid secret store entry at line ${lineNumber + 1}`);
    }
    if (values.has(name)) throw new Error(`Duplicate secret name: ${name}`);
    values.set(name, value);
  }
  return {
    has: (name) => values.has(name),
    get: (name) => values.get(name),
  };
}

export const SECRET_NAMES = Object.freeze([
  'ETHEREUM_RPC_URL',
  'ROBINHOOD_RPC_URL',
  'INK_RPC_URL',
  'BASE_RPC_URL',
  'OPENSEA_API',
  'ALCHEMY_API',
  'ROBINHOOD_ARCHIVE_RPC',
  'TEST_WALLET_PK',
  'TEST_WALLET_ADDR',
  'TG_BOT_TOKEN',
  'TG_CHAT_ID',
]);
