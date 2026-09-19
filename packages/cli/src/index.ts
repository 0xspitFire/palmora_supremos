#!/usr/bin/env node
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type Address, type Hex, parseEther, parseGwei } from 'viem';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { canonicalPolicyDigest, createTurnkeyClient, generateAndEncryptWallets, importAndEncryptWallets, importPrivateKeyToTurnkey, readTurnkeySecretConfig, readTurnkeyWalletMap, validateTurnkeyPolicyAst, validateTurnkeyWalletMap } from '@mint-bot/engine';
import type { WalletImportRecord } from '@mint-bot/engine';
import type { TurnkeyWalletMap } from '@mint-bot/engine';
import { configuredSecretRoot, configuredWallets, createCliRuntime, turnkeyCustodyEnabled } from './runtime.js';
import { resolveWalletPath, ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, ROBINHOOD_FREE_PER_WALLET_CAP_WEI } from '@mint-bot/backend';
import type { Campaign, ValidatedCampaign } from '@mint-bot/backend';
import { withHiddenPassphrase } from './secure-prompt.js';

const runtimeRoot = process.cwd();
const blocked = (error: unknown) => JSON.stringify({ state: 'Blocked', blockingReason: error instanceof Error ? error.message : String(error), retryable: false, policy: { robinhoodFreePerWalletCapWei: ROBINHOOD_FREE_PER_WALLET_CAP_WEI.toString(), robinhoodFreeActivePeriodCapWei: ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI.toString(), robinhoodPaidMintsEnabled: false } });

const DEFAULT_WALLET_FILE = join(runtimeRoot, 'Rets', 'wallets', 'wallets.json');
const DEFAULT_KILL_FILE = join(runtimeRoot, 'Rets', 'state', 'killswitch');
const DEFAULT_WALLET_IMPORT_ROOT = '/home/Junayd/W3/Rets/wallets';

function walletFile(value: string | undefined): string {
  return resolveWalletPath(runtimeRoot, value ?? process.env.MINT_BOT_WALLET_FILE ?? './Rets/wallets/wallets.json');
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
}

async function publicWallets(path: string): Promise<string[]> {
  if (turnkeyCustodyEnabled()) return (await configuredWallets(runtimeRoot, path)).map((wallet) => wallet.address);
  const content = JSON.parse(await readFile(path, 'utf8')) as { wallets?: Array<{ address?: string }> };
  if (!Array.isArray(content.wallets) || content.wallets.length === 0 || content.wallets.some((wallet) => !wallet.address)) throw new Error('Wallet file has no valid public wallet list');
  return content.wallets.map((wallet) => wallet.address!);
}

function walletImportRoot(value: string | undefined): string {
  const candidate = resolve(value ?? DEFAULT_WALLET_IMPORT_ROOT);
  const allowedRoots = [resolve(DEFAULT_WALLET_IMPORT_ROOT), resolve(runtimeRoot, 'Rets', 'wallets')];
  if (!allowedRoots.some((root) => candidate === root)) throw new Error('Wallet import root is not approved');
  return candidate;
}

function turnkeyPolicyPath(value: string | undefined): string {
  const secretRoot = resolve(configuredSecretRoot(runtimeRoot));
  const candidate = resolve(value ?? join(secretRoot, 'turnkey-policy.json'));
  const outside = relative(secretRoot, candidate);
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new Error('Turnkey policy must remain under the configured secret root');
  return candidate;
}

function turnkeyMapPath(value: string | undefined): string {
  const secretRoot = resolve(configuredSecretRoot(runtimeRoot));
  const candidate = resolve(value ?? join(secretRoot, 'turnkey-wallet-map.json'));
  const outside = relative(secretRoot, candidate);
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new Error('Turnkey wallet map must remain under the configured secret root');
  return candidate;
}

async function writeTurnkeyWalletMap(path: string, map: unknown): Promise<void> {
  // Never persist a map that lacks the exact policy/provider/key scope required by the signer.
  const validated = validateTurnkeyWalletMap(map);
  await ensureParent(path);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(validated, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readOwnerOnlyText(path: string, errorCode: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error(errorCode);
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw new Error('TURNKEY_PATH_PROBE_FAILED');
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function writeTurnkeyJson(path: string, value: unknown): Promise<void> {
  await ensureParent(path);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

interface TurnkeyImportJournalEntry {
  index: number;
  name: string;
  address: Address;
  status: 'pending' | 'imported';
  signWith?: string;
}

interface TurnkeyImportJournal {
  version: 1;
  organizationId: string;
  policyId: string;
  policyDigest: Hex;
  entries: TurnkeyImportJournalEntry[];
}

function validateTurnkeyImportJournal(value: unknown, names: readonly string[], addresses: readonly Address[], organizationId: string, policyId: string, policyDigest: Hex): TurnkeyImportJournal {
  if (!value || typeof value !== 'object') throw new Error('TURNKEY_IMPORT_JOURNAL_INVALID');
  const journal = value as Partial<TurnkeyImportJournal>;
  if (journal.version !== 1 || journal.organizationId !== organizationId || journal.policyId !== policyId || journal.policyDigest !== policyDigest || !Array.isArray(journal.entries) || journal.entries.length !== names.length) throw new Error('TURNKEY_IMPORT_JOURNAL_INVALID');
  const entries = journal.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || entry.index !== index || entry.name !== names[index] || entry.address?.toLowerCase() !== addresses[index]?.toLowerCase() || (entry.status !== 'pending' && entry.status !== 'imported') || (entry.status === 'imported' && typeof entry.signWith !== 'string')) throw new Error('TURNKEY_IMPORT_JOURNAL_INVALID');
    return { index, name: names[index]!, address: addresses[index]!, status: entry.status, ...(entry.signWith ? { signWith: entry.signWith } : {}) };
  });
  return { version: 1, organizationId, policyId, policyDigest, entries };
}

function parseWalletEnv(content: string, fileName: string): WalletImportRecord {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key !== 'WALLET_ADD' && key !== 'ACC_KEY') continue;
    if (values.has(key)) throw new Error(`Duplicate ${key} in ${fileName}`);
    values.set(key, line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, ''));
  }
  const address = values.get('WALLET_ADD');
  const privateKey = values.get('ACC_KEY');
  if (!address || !privateKey) throw new Error(`Wallet import fields missing in ${fileName}`);
  return { address: address as Address, privateKey: privateKey as Hex };
}

async function readWalletImportRecords(root: string, files: string): Promise<WalletImportRecord[]> {
  const names = files.split(',').map((name) => name.trim()).filter(Boolean);
  if (names.length < 1 || names.some((name) => !/^[A-Za-z0-9._-]+\.env$/.test(name))) {
    throw new Error('Wallet import files must be comma-separated .env basenames');
  }
  const records: WalletImportRecord[] = [];
  for (const name of names) {
    const path = join(root, name);
    records.push(parseWalletEnv(await readOwnerOnlyText(path, `Wallet import file permissions must be owner-only: ${name}`), name));
  }
  return records;
}

function printError(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  throw error;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : item, 2);
}

function persistedCampaign(runtime: Awaited<ReturnType<typeof createCliRuntime>>, campaignId: string): Campaign {
  const campaign = runtime.store.snapshot().campaigns.find(item => item.id === campaignId);
  if (!campaign) throw new Error(`CAMPAIGN_NOT_FOUND:${campaignId}`);
  return campaign;
}

async function validatedCampaign(runtime: Awaited<ReturnType<typeof createCliRuntime>>, campaignId: string, wallets: readonly string[] = []): Promise<ValidatedCampaign> {
  return { campaign: persistedCampaign(runtime, campaignId), wallets, simulationIds: [], evidenceAt: new Date().toISOString() };
}

const cli = yargs(hideBin(process.argv))
  .scriptName('mint-bot')
  .strict()
  .demandCommand(1)
  .help()
  .command('wallet generate', 'Generate independently encrypted wallets', (args) => args
    .option('count', { type: 'number', demandOption: true })
    .option('output', { type: 'string', default: DEFAULT_WALLET_FILE }), async (args) => {
      try {
        const output = walletFile(args.output);
        await ensureParent(output);
        const wallets = await withHiddenPassphrase((passphrase) => generateAndEncryptWallets(args.count, passphrase, output));
        console.log(`Generated ${wallets.length} wallets in ${output}`);
        wallets.forEach((wallet) => console.log(`${wallet.index}\t${wallet.address}`));
      } catch (error) { printError(error); }
    })
  .command('wallet list', 'List wallet addresses without decrypting private keys', (args) => args
    .option('file', { type: 'string', default: DEFAULT_WALLET_FILE }), async (args) => {
      try {
        if (turnkeyCustodyEnabled()) {
          const wallets = await configuredWallets(runtimeRoot, walletFile(args.file));
          wallets.forEach((wallet) => console.log(`${wallet.index}\t${wallet.address}`));
          return;
        }
        const content = JSON.parse(await readFile(walletFile(args.file), 'utf8')) as {
          wallets?: Array<{ index: number; address: string }>;
        };
        if (!Array.isArray(content.wallets)) throw new Error('Wallet file has no valid public wallet list');
        content.wallets.forEach((wallet) => console.log(`${wallet.index}\t${wallet.address}`));
      } catch (error) { printError(error); }
    })
  .command('wallet import', 'Encrypt approved wallet env files for local testing', (args) => args
    .option('input-dir', { type: 'string', default: DEFAULT_WALLET_IMPORT_ROOT })
    .option('files', { type: 'string', demandOption: true, description: 'Comma-separated .env basenames' })
    .option('output', { type: 'string', default: DEFAULT_WALLET_FILE }), async (args) => {
      try {
        const root = walletImportRoot(args.inputDir);
        const records = await readWalletImportRecords(root, args.files);
        const count = records.length;
        const output = walletFile(args.output);
        await ensureParent(output);
        try {
          await withHiddenPassphrase(async (passphrase) => {
            await importAndEncryptWallets(records, passphrase, output);
          });
        } finally {
          records.fill({ address: '0x0000000000000000000000000000000000000000' as Address, privateKey: '0x00' as Hex });
        }
        console.log(`Imported ${count} wallets into ${output}`);
      } catch (error) { printError(error); }
    })
  .command('wallet import-turnkey', 'Encrypt and import approved wallet env files into Turnkey', (args) => args
    .option('input-dir', { type: 'string', default: DEFAULT_WALLET_IMPORT_ROOT })
    .option('files', { type: 'string', demandOption: true, description: 'Comma-separated .env basenames' })
    .option('map-output', { type: 'string' })
    .option('policy-ast', { type: 'string', demandOption: true, description: 'Owner-only path to the exact approved canonical policy AST' })
    .option('policy-id', { type: 'string', demandOption: true })
    .option('policy-digest', { type: 'string', demandOption: true, description: 'Keccak-256 digest of the approved Turnkey policy condition' })
    .option('confirm', { type: 'boolean', default: false }), async (args) => {
      try {
        if (!args.confirm) throw new Error('TURNKEY_IMPORT_REQUIRES_CONFIRM');
        const root = walletImportRoot(args.inputDir);
        let records: WalletImportRecord[] = [];
        try {
          const names = args.files.split(',').map((name) => name.trim()).filter(Boolean);
          const secretRoot = configuredSecretRoot(runtimeRoot);
          const { organizationId, userId, environment, apiPublicKey, apiPrivateKey } = await readTurnkeySecretConfig(secretRoot);
          const output = turnkeyMapPath(args.mapOutput);
          const policyPath = turnkeyPolicyPath(args.policyAst);
          let policy: ReturnType<typeof validateTurnkeyPolicyAst>;
          try {
            policy = validateTurnkeyPolicyAst(JSON.parse(await readOwnerOnlyText(policyPath, 'TURNKEY_POLICY_AST_PERMISSIONS_REQUIRED')) as unknown);
          } catch {
            throw new Error('TURNKEY_POLICY_AST_REQUIRED');
          }
          const policyDigest = args.policyDigest as Hex;
          if (!/^0x[0-9a-fA-F]{64}$/.test(policyDigest)) throw new Error('TURNKEY_POLICY_DIGEST_INVALID');
          if (policy.scope.organizationId !== organizationId || policy.scope.userId !== userId || policy.scope.environment !== environment || policy.scope.policyId !== args.policyId || canonicalPolicyDigest(policy).toLowerCase() !== policyDigest.toLowerCase()) throw new Error('TURNKEY_POLICY_PROVIDER_BINDING_INVALID');
          records = await readWalletImportRecords(root, args.files);
          const addresses = records.map((record) => record.address);
          if (policy.transaction.from.length !== addresses.length || policy.transaction.from.some((address, index) => address.toLowerCase() !== addresses[index]!.toLowerCase())) throw new Error('TURNKEY_POLICY_WALLET_SCOPE_INVALID');
          if (await pathExists(output)) {
            const existing = await readTurnkeyWalletMap(output);
            const sameMap = existing.organizationId === organizationId
              && existing.policyId === args.policyId
              && existing.policyDigest === policyDigest
              && existing.wallets.length === addresses.length
              && existing.wallets.every((wallet, index) => wallet.index === index && wallet.address.toLowerCase() === addresses[index]!.toLowerCase());
            if (sameMap) {
              console.log('Turnkey wallet map already exists; no imports performed');
              return;
            }
            throw new Error('TURNKEY_WALLET_MAP_CONFLICT');
          }
          const client = createTurnkeyClient(organizationId, apiPublicKey, apiPrivateKey);
          const journalPath = `${output}.journal`;
          let journal: TurnkeyImportJournal;
          if (await pathExists(journalPath)) {
            let parsed: unknown;
            try { parsed = JSON.parse(await readOwnerOnlyText(journalPath, 'TURNKEY_IMPORT_JOURNAL_INVALID')); } catch { throw new Error('TURNKEY_IMPORT_JOURNAL_INVALID'); }
            journal = validateTurnkeyImportJournal(parsed, names, addresses, organizationId, args.policyId, policyDigest);
          } else {
            journal = {
              version: 1,
              organizationId,
              policyId: args.policyId,
              policyDigest,
              entries: names.map((name, index) => ({ index, name, address: addresses[index]!, status: 'pending' })),
            };
            await writeTurnkeyJson(journalPath, journal);
          }
          const wallets: TurnkeyWalletMap['wallets'] = [];
          for (const [index, record] of records.entries()) {
            const entry = journal.entries[index]!;
            if (entry.status === 'imported' && entry.signWith) {
              wallets.push({ index, address: entry.address, signWith: entry.signWith });
              continue;
            }
            const imported = await importPrivateKeyToTurnkey(client, organizationId, userId, {
              name: `mintbot-${names[index]!.replace(/\.env$/i, '')}`,
              address: record.address,
              privateKey: record.privateKey,
            }, { organizationId, userId, environment });
            entry.status = 'imported';
            entry.signWith = imported.signWith;
            wallets.push({ ...imported, index });
            await writeTurnkeyJson(journalPath, journal);
          }
          await writeTurnkeyWalletMap(output, {
            version: 1,
            organizationId,
            userId,
            environment,
            policyId: args.policyId,
            policyDigest,
            policy,
            wallets,
          });
          await unlink(journalPath).catch(() => undefined);
          console.log(`Imported ${wallets.length} wallets into Turnkey and wrote the public wallet map`);
        } catch {
          throw new Error('TURNKEY_IMPORT_FAILED');
        } finally {
          records.fill({ address: '0x0000000000000000000000000000000000000000' as Address, privateKey: '0x00' as Hex });
        }
      } catch (error) { printError(error); }
    })
  .command('approve', 'Persist explicit campaign approval', (args) => args
    .option('campaign-id', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('idempotency-key', { type: 'string' }), async (args) => {
      try {
        const runtime = await createCliRuntime(runtimeRoot);
        const validated = await validatedCampaign(runtime, args.campaignId, await publicWallets(walletFile(args.walletFile)));
        const response = await runtime.application.command('approve', { validated, ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}) });
        process.stdout.write(`${json(response)}\n`);
      } catch (error) { printError(error); }
    })
  .command('health', 'Check backend and operational readiness', {}, async () => {
    try {
      const runtime = await createCliRuntime(runtimeRoot);
      const response = await runtime.application.command('health');
      process.stdout.write(`${json(response)}\n`);
    } catch (error) { printError(error); }
  })
  .command('kill', 'Create or remove the global kill-switch file', (args) => args
    .option('file', { type: 'string', default: DEFAULT_KILL_FILE })
    .option('clear', { type: 'boolean', default: false }), async (args) => {
      try {
        if (args.clear) {
          throw new Error('KILL_SWITCH_RESET_REQUIRES_RECOVERY_APPROVAL');
        }
        await ensureParent(args.file);
        await writeFile(args.file, `killed at ${new Date().toISOString()}\n`, { flag: 'wx' });
        const runtime = await createCliRuntime(runtimeRoot);
        await runtime.application.command('kill', { reason: 'operator CLI kill switch' });
        console.log(`Kill switch enabled: ${args.file}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') printError(new Error(`Kill switch already exists: ${args.file}`));
        printError(error);
      }
    })
  .command('mint', 'Create and execute a backend-admitted SeaDrop dry run', (args) => args
    .option('chain', { type: 'string', choices: ['ethereum', 'robinhood'] as const, default: 'ethereum' })
    .option('contract', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('quantity', { type: 'number', default: 1 })
    .option('max-wallets', { type: 'number', default: 10 })
    .option('max-spend-eth', { type: 'number', default: 1 })
    .option('daily-cap-eth', { type: 'number', default: 2 })
    .option('max-fee-gwei', { type: 'number', default: 100 })
    .option('priority-fee-gwei', { type: 'number', default: 2 })
    .option('gas-padding', { type: 'number', default: 1.2 })
    .option('dry-run', { type: 'boolean', default: true }), async (args) => {
      try {
        if (!args.dryRun) throw new Error('EXPLICIT_APPROVE_ARM_RUN_REQUIRED');
        const file = walletFile(args.walletFile);
        const wallets = (await publicWallets(file)).slice(0, args.maxWallets);
        if (wallets.length === 0) throw new Error('EMPTY_EXECUTION_FLEET');
        const chainId = args.chain === 'ethereum' ? 1 : 4663;
        const priorityFee = parseGwei(args.priorityFeeGwei.toString());
        const feePolicy = { kind: 'free' as const, configuredPriorityFeeWei: priorityFee, freeTotalSpendCapWei: priorityFee * 2n, l2ExecutionGasBudgetWei: 0n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: priorityFee };
        const runtime = await createCliRuntime(runtimeRoot, undefined, process.env.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite', { walletFile: file, maxFeePerGasGwei: args.maxFeeGwei, gasLimitPadding: args.gasPadding, killSwitchFile: DEFAULT_KILL_FILE, logFile: join(runtimeRoot, 'Rets', 'state', 'mint-bot.log') });
        const campaign = await runtime.application.createCampaign({
          chainId,
          contract: args.contract,
          strategy: 'seadrop-v1-public',
          quantity: args.quantity,
          dryRun: true,
          maxRunWei: parseEther(args.maxSpendEth.toString()),
          dailyCapWei: parseEther(args.dailyCapEth.toString()),
          gasCeilingWei: parseEther(args.maxSpendEth.toString()),
          broadcastMode: chainId === 1 ? 'flashbots' : 'sequencer',
          chainVerification: { chainId, status: chainId === 1 ? 'verified' : 'unverified', seaDropCompatible: chainId === 1, endpointReference: chainId === 1 ? 'ETHEREUM_RPC_REFERENCE' : 'ROBINHOOD_RPC_REFERENCE' },
          mintPriceWei: 0n,
          feePolicy,
        });
        const validated = { campaign, wallets, evidenceAt: new Date().toISOString(), simulationIds: [] };
        const armed = await runtime.application.command('arm', { validated, mode: 'dry-run' });
        const result = await runtime.application.command('execute', { runId: armed.id, wallets });
        process.stdout.write(`${json(result)}\n`);
      } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
    })
  .command('reconcile', 'Reconcile persisted in-flight runs before admission', {}, async () => {
    const runtime = await createCliRuntime(runtimeRoot);
    const response = await runtime.application.command('reconcile');
    process.stdout.write(`${json(response)}\n`);
  })
  .command('validate', 'Validate a campaign through the configured engine adapter', {}, async () => {
    const runtime = await createCliRuntime(runtimeRoot);
    try { await runtime.application.command('validate'); } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('dry-run', 'Prepare a non-broadcast dry run for a persisted campaign', (args) => args
    .option('campaign-id', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('idempotency-key', { type: 'string' }), async (args) => {
    const runtime = await createCliRuntime(runtimeRoot);
    try {
      const wallets = await publicWallets(walletFile(args.walletFile));
      const validated = await validatedCampaign(runtime, args.campaignId, wallets);
      const response = await runtime.application.command('dry-run', { validated, ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}) });
      process.stdout.write(`${json(response)}\n`);
    } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('arm', 'Arm a persisted campaign through Backend admission', (args) => args
    .option('campaign-id', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('mode', { type: 'string', choices: ['dry-run', 'live'] as const, default: 'dry-run' })
    .option('idempotency-key', { type: 'string' })
    .option('approval-id', { type: 'string' }), async (args) => {
    const runtime = await createCliRuntime(runtimeRoot);
    try {
      const wallets = await publicWallets(walletFile(args.walletFile));
      const validated = await validatedCampaign(runtime, args.campaignId, wallets);
      const response = await runtime.application.command('arm', { validated, mode: args.mode, ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}), ...(args.approvalId ? { approvalId: args.approvalId } : {}) });
      process.stdout.write(`${json(response)}\n`);
    } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('run', 'Execute an admitted run through Backend admission', (args) => args
    .option('run-id', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('idempotency-key', { type: 'string' }), async (args) => {
    const runtime = await createCliRuntime(runtimeRoot);
    try {
      const wallets = await publicWallets(walletFile(args.walletFile));
      const response = await runtime.application.command('run', { runId: args.runId, wallets, ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}) });
      process.stdout.write(`${json(response)}\n`);
    } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('execute', 'Compatibility alias for run', (args) => args
    .option('run-id', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE }), async (args) => {
    const runtime = await createCliRuntime(runtimeRoot);
    try {
      const wallets = await publicWallets(walletFile(args.walletFile));
      const response = await runtime.application.command('execute', { runId: args.runId, wallets });
      process.stdout.write(`${json(response)}\n`);
    } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('summary', 'Read canonical run and accounting facts', (args) => args
    .option('run-id', { type: 'string' }), async (args) => {
    const runtime = await createCliRuntime(runtimeRoot);
    try {
      const response = await runtime.application.command('summary', args.runId ? { runId: args.runId } : {});
      process.stdout.write(`${json(response)}\n`);
    } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('fund', 'Report funding requirements without handling keys', (args) => args
    .option('run-id', { type: 'string' })
    .option('wallet-file', { type: 'string' }), async (args) => {
    const runtime = await createCliRuntime(runtimeRoot);
    try {
      const wallets = args.walletFile ? await publicWallets(walletFile(args.walletFile)) : undefined;
      const response = await runtime.application.command('fund', { ...(args.runId ? { runId: args.runId } : {}), ...(wallets ? { wallets } : {}) });
      process.stdout.write(`${json(response)}\n`);
    } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .fail((message, error) => {
    console.error(error?.message ?? message);
    process.exitCode = 1;
  });

void cli.parseAsync();
