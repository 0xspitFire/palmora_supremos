/**
 * @module signer
 *
 * Envelope-encrypted wallet signer for Phase 1 custody.
 *
 * Design (from §6 correction #4):
 * - Independent keys per wallet (NOT mnemonic-derived)
 * - Encrypted at rest with AES-256-GCM
 * - KEK derived from user passphrase via scrypt (Node.js native crypto)
 * - At runtime: passphrase → decrypt wallets → sign → zeroize after job
 * - The engine never accesses raw private keys directly
 * - Windows-safe: no reliance on Unix file permissions
 *
 * Phase 2 upgrade path: replace this with KMS/HSM-backed signing.
 * The Signer interface stays the same — only the implementation changes.
 */

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { type Address, type Hex, parseTransaction, serializeTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Signer as ISigner, WalletInfo, TransactionIntent } from './types.js';

// ─────────────────────────────────────────────────────────────
// Encryption Constants
// ─────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 2 ** 18, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface EncryptedWalletFile {
  version: 1;
  salt: string;      // hex
  iv: string;        // hex
  authTag: string;   // hex
  ciphertext: string; // hex-encoded encrypted JSON array of private keys
  wallets: Array<{ index: number; address: string }>;  // Public info only
}

interface DecryptedWallet {
  index: number;
  address: Address;
  account: ReturnType<typeof privateKeyToAccount>;
}

// ─────────────────────────────────────────────────────────────
// Wallet Generation
// ─────────────────────────────────────────────────────────────

/**
 * Generate N independent wallets and encrypt them to a file.
 *
 * Uses crypto.randomBytes for key generation (NOT mnemonic-derived).
 * Each wallet has an independent key — no shared secret.
 */
export async function generateAndEncryptWallets(
  count: number,
  passphrase: string,
  outputPath: string,
): Promise<WalletInfo[]> {
  if (count < 1 || count > 50) {
    throw new Error('Wallet count must be between 1 and 50');
  }
  if (passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters');
  }

  // Generate independent private keys
  const privateKeys: Hex[] = [];
  const walletInfos: WalletInfo[] = [];

  for (let i = 0; i < count; i++) {
    const keyBytes = randomBytes(32);
    const privateKey = `0x${keyBytes.toString('hex')}` as Hex;
    const account = privateKeyToAccount(privateKey);

    privateKeys.push(privateKey);
    walletInfos.push({
      index: i,
      address: account.address,
    });

    // Zero the raw bytes immediately
    keyBytes.fill(0);
  }

  // Encrypt private keys
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const kek = scryptSync(passphrase, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);

  const plaintext = JSON.stringify(privateKeys);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Build encrypted file
  const encryptedFile: EncryptedWalletFile = {
    version: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    wallets: walletInfos.map((w) => ({ index: w.index, address: w.address })),
  };

  const temporaryPath = `${outputPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(encryptedFile, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, outputPath);

  // Zeroize sensitive material
  kek.fill(0);
  privateKeys.forEach((_, idx) => { privateKeys[idx] = '0x00' as Hex; });

  return walletInfos;
}

// ─────────────────────────────────────────────────────────────
// Signer Implementation
// ─────────────────────────────────────────────────────────────

export class LocalEncryptedSigner implements ISigner {
  private wallets: DecryptedWallet[] = [];
  private zeroized = false;

  private constructor() {}

  /**
   * Create a signer by loading and decrypting a wallet file.
   * The passphrase is used once to decrypt, then the signer holds
   * decrypted accounts in memory until zeroize() is called.
   */
  static async fromFile(filePath: string, passphrase: string): Promise<LocalEncryptedSigner> {
    const signer = new LocalEncryptedSigner();

    const fileContent = await readFile(filePath, 'utf8');
    const encryptedFile = JSON.parse(fileContent) as EncryptedWalletFile;

    if (encryptedFile.version !== 1) {
      throw new Error(`Unsupported wallet file version: ${encryptedFile.version}`);
    }
    if (!Array.isArray(encryptedFile.wallets) || encryptedFile.wallets.length < 1 || encryptedFile.wallets.length > 50) {
      throw new Error('Invalid wallet file wallet list');
    }
    for (const field of ['salt', 'iv', 'authTag', 'ciphertext'] as const) {
      if (!/^[0-9a-f]+$/i.test(encryptedFile[field])) throw new Error(`Invalid wallet file ${field}`);
    }
    if (encryptedFile.iv.length !== IV_LENGTH * 2 || encryptedFile.authTag.length !== 32 || encryptedFile.salt.length !== SALT_LENGTH * 2) {
      throw new Error('Invalid wallet file encryption metadata');
    }
    if (encryptedFile.ciphertext.length === 0 || encryptedFile.ciphertext.length > 2_000_000) {
      throw new Error('Invalid wallet file ciphertext size');
    }
    const indices = new Set(encryptedFile.wallets.map((wallet) => wallet.index));
    if (indices.size !== encryptedFile.wallets.length || encryptedFile.wallets.some((wallet) => !/^0x[0-9a-f]{40}$/i.test(wallet.address))) {
      throw new Error('Invalid wallet file wallet metadata');
    }

    // Derive KEK from passphrase
    const salt = Buffer.from(encryptedFile.salt, 'hex');
    const iv = Buffer.from(encryptedFile.iv, 'hex');
    const authTag = Buffer.from(encryptedFile.authTag, 'hex');
    const ciphertext = Buffer.from(encryptedFile.ciphertext, 'hex');
    const kek = scryptSync(passphrase, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);

    // Decrypt
    const decipher = createDecipheriv(ALGORITHM, kek, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    const privateKeys = JSON.parse(decrypted.toString('utf8')) as Hex[];

    // Build wallet objects
    if (!Array.isArray(privateKeys) || privateKeys.length !== encryptedFile.wallets.length || privateKeys.some((pk) => !/^0x[0-9a-f]{64}$/i.test(pk))) {
      throw new Error('Invalid wallet file key material');
    }
    signer.wallets = privateKeys.map((pk, index) => {
      const account = privateKeyToAccount(pk);
      if (account.address.toLowerCase() !== encryptedFile.wallets[index]!.address.toLowerCase()) {
        throw new Error(`Wallet metadata mismatch at index ${index}`);
      }
      return {
        index,
        address: account.address,
        account,
      };
    });

    // Zeroize intermediate buffers
    kek.fill(0);
    decrypted.fill(0);

    return signer;
  }

  async listWallets(): Promise<WalletInfo[]> {
    this.ensureNotZeroized();
    return this.wallets.map((w) => ({
      index: w.index,
      address: w.address,
    }));
  }

  async signTransaction(walletIndex: number, intent: TransactionIntent): Promise<Hex> {
    this.ensureNotZeroized();

    const wallet = this.wallets[walletIndex];
    if (!wallet) {
      throw new Error(`Wallet index ${walletIndex} not found. Available: 0-${this.wallets.length - 1}`);
    }

    if (intent.from.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(`Transaction intent signer mismatch for wallet ${walletIndex}`);
    }
    const serializedUnsignedTx = serializeTransaction({
      type: 'eip1559', chainId: intent.chainId, nonce: intent.nonce, to: intent.to,
      value: intent.value, data: intent.data, gas: intent.gasLimit,
      maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas,
    });
    const tx = parseTransaction(serializedUnsignedTx);
    const signature = await wallet.account.signTransaction(tx);
    return signature;
  }

  zeroize(): void {
    // Clear all wallet references
    this.wallets = [];
    this.zeroized = true;
  }

  private ensureNotZeroized(): void {
    if (this.zeroized) {
      throw new Error('Signer has been zeroized — keys are no longer available');
    }
  }
}
