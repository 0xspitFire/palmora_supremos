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
import { IntelligenceRepository, openDatabase } from '@mint-bot/database';
import { resolveChainByNameFromSecrets, SEADROP_V1_ADDRESS } from '@mint-bot/engine';
import { checkDrop, planAutoQuantity } from './drop-check.js';
import { surveyErrorMessage, surveySeaDropMints } from './seadrop-survey.js';
import { checkAllowlist, parsePublishedList } from './allowlist-check.js';
import { probeRpc } from './rpc-probe.js';
import { PUBLIC_ROBINHOOD_RPC, checkFees, dryRunDrop, observeFinality } from './robinhood-readonly.js';
import { PUBLIC_ROBINHOOD_FEED, checkFeed, readFeed } from './feed-check.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { assertLivePrepareAllowed, buildLivePlan, liveConfirmationPhrase, liveFreeCampaignFields } from './live-plan.js';
import { assertFeePolicyApplyAllowed, assertTipMatchesStoredPolicy, describeFeePolicy, plainFeePolicyMessage } from './fee-policy.js';
import { createPublicClient, defineChain, http as httpTransport, parseAbi } from 'viem';
import { EngineIntelligencePort } from './intelligence-adapter.js';

/** Read-only Ethereum port for CLI checks; the RPC value stays in memory and is never printed. */
async function ethereumPort(): Promise<EngineIntelligencePort> {
  const config = await resolveChainByNameFromSecrets('ethereum', 'mainnet', configuredSecretRoot(runtimeRoot));
  const endpoint = config.rpcEndpoints[0];
  if (!endpoint) throw new Error('ETHEREUM_RPC_UNAVAILABLE');
  return EngineIntelligencePort.fromRpcUrl(endpoint);
}

/** Wallets for read-only checks: explicit public addresses, never the keystore. */

/** Read-only client for Robinhood Chain; defaults to the chain's published public RPC, so no secret is needed. */
function robinhoodReadClient(rpcUrl: string | undefined) {
  const url = rpcUrl ?? PUBLIC_ROBINHOOD_RPC;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('RPC_URL_INVALID'); }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) throw new Error('RPC_MUST_BE_HTTPS');
  const chain = defineChain({ id: 4663, name: 'robinhood', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
  return createPublicClient({ chain, transport: httpTransport(url, { timeout: 20_000, retryCount: 1 }) });
}

function checkWallets(value: string | undefined): string[] {
  const list = (value ?? process.env.MINT_BOT_READINESS_WALLETS ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  if (list.length === 0) throw new Error('WALLETS_REQUIRED: pass --wallets 0x...,0x... or set MINT_BOT_READINESS_WALLETS');
  if (list.some((address) => !/^0x[0-9a-fA-F]{40}$/.test(address))) throw new Error('WALLET_ADDRESS_INVALID');
  return [...new Set(list.map((address) => address.toLowerCase()))];
}

function intelligenceRepository(): { repo: IntelligenceRepository; close(): void } {
  const db = openDatabase(resolve(runtimeRoot, process.env.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite'));
  return { repo: new IntelligenceRepository(db), close: () => db.close() };
}

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
    .option('auto-quantity', { type: 'boolean', default: false, describe: 'Plan the quantity from the drop allowance and the current fee (D-037); the reason is recorded in the run and printed' })
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
        // The mint price comes from chain (T-004, P2-08), never an assumed zero.
        const port = chainId === 1 ? await ethereumPort() : null;
        const drop = port ? await port.readDrop(args.contract) : null;
        if (chainId === 1 && !drop) throw new Error('DROP_UNAVAILABLE');
        // Paid drops are not run through this free-mint dry-run path (a spend-path change needs owner sign-off);
        // use the read-only `simulate` command, which uses the real price.
        if ((drop?.priceWei ?? 0n) > 0n) throw new Error('PAID_DROP_USE_SIMULATE_COMMAND');
        const feePolicy = { kind: 'free' as const, configuredPriorityFeeWei: priorityFee, freeTotalSpendCapWei: priorityFee * 2n, l2ExecutionGasBudgetWei: 0n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: priorityFee };
        const runtime = await createCliRuntime(runtimeRoot, undefined, process.env.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite', { walletFile: file, maxFeePerGasGwei: args.maxFeeGwei, gasLimitPadding: args.gasPadding, killSwitchFile: DEFAULT_KILL_FILE, logFile: join(runtimeRoot, 'Rets', 'state', 'mint-bot.log') });
        // D-037: with --auto-quantity, mint as many per wallet as the drop allows and the fee allowance covers, and say why when fewer.
        let quantityPlan: { desired: number; planned: number; reduced: boolean; reason: string; maxFeeGwei: string; message: string } | undefined;
        let quantity = args.quantity;
        if (args.autoQuantity) {
          if (!port || !drop) throw new Error('AUTO_QUANTITY_NEEDS_ETHEREUM_DROP');
          const plan = await planAutoQuantity(port, { contract: args.contract, wallet: wallets[0]!, maxPerWallet: drop.maxPerWallet, gasPaddingPercent: Math.round(args.gasPadding * 100) });
          quantityPlan = { desired: plan.desired, planned: plan.planned, reduced: plan.reduced, reason: plan.reason, maxFeeGwei: plan.maxFeeGwei, message: plan.message };
          quantity = plan.planned;
        }
        const campaign = await runtime.application.createCampaign({
          chainId,
          contract: args.contract,
          strategy: 'seadrop-v1-public',
          quantity,
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
        // The owner must always be told why fewer NFTs than expected were planned (D-037): record it on the run (shown in the run summary).
        if (quantityPlan) await runtime.store.transaction((state) => { state.events.push({ id: `evt_${randomBytes(8).toString('hex')}`, runId: armed.id, type: 'quantity_plan', at: new Date().toISOString(), data: { ...quantityPlan } }); });
        const result = await runtime.application.command('execute', { runId: armed.id, wallets });
        process.stdout.write(`${json(quantityPlan ? { ...result, quantityPlan } : result)}\n`);
      } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
    })
  .command('reconcile', 'Reconcile persisted in-flight runs before admission', {}, async () => {
    const runtime = await createCliRuntime(runtimeRoot);
    const response = await runtime.application.command('reconcile');
    process.stdout.write(`${json(response)}\n`);
  })
  .command('validate', 'Read-only check of a SeaDrop drop and your wallets against your limits', (args) => args
    .option('contract', { type: 'string', demandOption: true })
    .option('wallets', { type: 'string', describe: 'Comma-separated public addresses (default: MINT_BOT_READINESS_WALLETS)' })
    .option('quantity', { type: 'number', describe: 'NFTs per wallet (default: full allowance for free, by score for paid)' })
    .option('score', { type: 'number', describe: 'Signal score used to plan paid quantity' }), async (args) => {
      try {
        const report = await checkDrop(await ethereumPort(), args.contract, checkWallets(args.wallets), { simulate: false, ...(args.quantity === undefined ? {} : { quantity: args.quantity }), ...(args.score === undefined ? {} : { score: args.score }) });
        process.stdout.write(`${json(report)}\n`);
      } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
    })
  .command('simulate', 'Read-only test mint call (eth_call) per wallet; never signs or sends', (args) => args
    .option('contract', { type: 'string', demandOption: true })
    .option('wallets', { type: 'string', describe: 'Comma-separated public addresses (default: MINT_BOT_READINESS_WALLETS)' })
    .option('quantity', { type: 'number' })
    .option('score', { type: 'number' }), async (args) => {
      try {
        const report = await checkDrop(await ethereumPort(), args.contract, checkWallets(args.wallets), { simulate: true, ...(args.quantity === undefined ? {} : { quantity: args.quantity }), ...(args.score === undefined ? {} : { score: args.score }) });
        process.stdout.write(`${json(report)}\n`);
      } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
    })
  .command('check-allowlist', 'Read-only: are your own wallets on a project\'s PUBLISHED allowlist? Answers eligible, not_listed or unknown', (args) => args
    .option('contract', { type: 'string', demandOption: true })
    .option('list', { type: 'string', describe: 'Path to the allowlist or proof JSON file the project published' })
    .option('wallets', { type: 'string', describe: 'Comma-separated public addresses (default: MINT_BOT_READINESS_WALLETS)' }), async (args) => {
      try {
        if (!/^0x[0-9a-fA-F]{40}$/.test(args.contract)) throw new Error('CONTRACT_ADDRESS_INVALID');
        const wallets = checkWallets(args.wallets);
        let list: ReturnType<typeof parsePublishedList> | null = null;
        if (args.list) {
          if (statSync(args.list).size > 20_000_000) throw new Error('ALLOWLIST_FILE_TOO_LARGE');
          list = parsePublishedList(readFileSync(args.list, 'utf8'));
        }
        let root: `0x${string}` | null = null;
        try {
          const config = await resolveChainByNameFromSecrets('ethereum', 'mainnet', configuredSecretRoot(runtimeRoot));
          const endpoint = config.rpcEndpoints[0];
          if (endpoint && (endpoint.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(endpoint))) {
            const client = createPublicClient({ chain: defineChain({ id: config.chainId, name: 'ethereum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } }), transport: httpTransport(endpoint, { timeout: 15_000, retryCount: 1 }) });
            root = await client.readContract({ address: SEADROP_V1_ADDRESS as `0x${string}`, abi: parseAbi(['function getAllowListMerkleRoot(address nftContract) view returns (bytes32)']), functionName: 'getAllowListMerkleRoot', args: [args.contract as `0x${string}`] });
          }
        } catch { root = null; }
        process.stdout.write(`${json(checkAllowlist({ contract: args.contract, wallets, onChainRoot: root, list }))}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('observe-finality', 'Read-only (Robinhood E3): follow fresh transactions through soft, posted and Ethereum-final', (args) => args
    .option('minutes', { type: 'number', default: 20, describe: 'How long to watch (1 to 60)' })
    .option('samples', { type: 'number', default: 5, describe: 'Fresh transactions to follow (1 to 20)' })
    .option('rpc-url', { type: 'string', describe: 'Override the public Robinhood RPC' }), async (args) => {
      try { process.stdout.write(`${json(await observeFinality(robinhoodReadClient(args.rpcUrl) as never, { minutes: args.minutes, samples: args.samples }))}\n`); }
      catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('check-feed', 'Read-only (Robinhood E4): compare the sequencer feed with the RPC', (args) => args
    .option('seconds', { type: 'number', default: 45, describe: 'How long to listen to the feed (5 to 300)' })
    .option('transactions', { type: 'number', default: 30, describe: 'Transactions to compare (1 to 200)' })
    .option('rpc-url', { type: 'string' })
    .option('feed-url', { type: 'string', describe: 'Override the public feed (wss only)' }), async (args) => {
      try {
        if (!Number.isFinite(args.seconds) || args.seconds < 5 || args.seconds > 300) throw new Error('SECONDS_OUT_OF_RANGE: use 5 to 300');
        const feed = readFeed(args.feedUrl ?? PUBLIC_ROBINHOOD_FEED, { seconds: args.seconds, maxMessages: 5_000 });
        process.stdout.write(`${json(await checkFeed(robinhoodReadClient(args.rpcUrl) as never, feed, { maxTransactions: args.transactions }))}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('check-fees', 'Read-only (Robinhood E5): what real recent free mints cost, against the approved caps', (args) => args
    .option('blocks', { type: 'number', default: 3000, describe: 'Recent blocks to look through (1 to 20000)' })
    .option('samples', { type: 'number', default: 40 })
    .option('rpc-url', { type: 'string' }), async (args) => {
      try { process.stdout.write(`${json(await checkFees(robinhoodReadClient(args.rpcUrl) as never, { blocks: args.blocks, samples: args.samples }))}\n`); }
      catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('simulate-robinhood', 'Read-only (Robinhood E6): simulate a free mint for your wallets; never signs or sends', (args) => args
    .option('contract', { type: 'string', demandOption: true })
    .option('wallets', { type: 'string', describe: 'Comma-separated public addresses (default: MINT_BOT_READINESS_WALLETS)' })
    .option('quantity', { type: 'number', default: 1 })
    .option('rpc-url', { type: 'string' }), async (args) => {
      try { process.stdout.write(`${json(await dryRunDrop(robinhoodReadClient(args.rpcUrl) as never, args.contract, checkWallets(args.wallets), { quantity: args.quantity }))}\n`); }
      catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('fee-policy <action>', 'Owner-run: show Ethereum\'s stored fee policy against the approved one, or replace it (needs a typed confirmation)', (args) => args
    .positional('action', { type: 'string', choices: ['status', 'apply'] as const, demandOption: true })
    .option('confirm', { type: 'string', describe: 'The confirmation phrase status printed (apply only)' }), async (args) => {
      try {
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
        const store = runtime.store as unknown as { ethereumFeePolicyStatus?: () => Parameters<typeof describeFeePolicy>[0]; applyApprovedEthereumFeePolicy?: () => { replaced: boolean } };
        if (typeof store.ethereumFeePolicyStatus !== 'function' || typeof store.applyApprovedEthereumFeePolicy !== 'function') throw new Error('CANONICAL_STORE_REQUIRED');
        const status = store.ethereumFeePolicyStatus();
        const view = describeFeePolicy(status);
        if (args.action === 'status') { process.stdout.write(`${json({ ...view, ...(view.confirmation ? { copyThisToApply: `fee-policy apply --confirm "${view.confirmation}"` } : {}), stored: status.stored, approved: status.approved })}\n`); return; }
        assertFeePolicyApplyAllowed({ status, confirm: args.confirm });
        const result = store.applyApprovedEthereumFeePolicy();
        process.stdout.write(`${json({ state: result.replaced ? 'Replaced' : 'AlreadyCurrent', message: result.replaced ? 'Ethereum\'s stored fee policy now matches the approved one.' : 'Nothing to change: the stored policy already matches.' })}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('live-plan', 'Read-only: is a FREE Ethereum mint ready to go live? Shows the money at risk, what blocks it, and the next steps', (args) => args
    .option('contract', { type: 'string', demandOption: true })
    .option('wallets', { type: 'string', describe: 'Comma-separated public addresses (default: MINT_BOT_READINESS_WALLETS)' })
    .option('rpc-url', { type: 'string', describe: 'Override the Ethereum RPC (https only)' }), async (args) => {
      try {
        const wallets = checkWallets(args.wallets);
        const port = args.rpcUrl ? EngineIntelligencePort.fromRpcUrl(args.rpcUrl) : await ethereumPort();
        const report = await checkDrop(port, args.contract, wallets, { simulate: true });
        const plan = buildLivePlan(report, { killSwitchPresent: existsSync(DEFAULT_KILL_FILE), custody: turnkeyCustodyEnabled() ? 'turnkey' : 'local' });
        process.stdout.write(`${json({ ...plan, ...(plan.verdict === 'ready' ? { confirmationPhrase: liveConfirmationPhrase(args.contract, plan.totalMaxExposureEth), planningMaxFeeGwei: report.quantityPlan?.maxFeeGwei ?? null } : {}) })}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('live-prepare', 'Record a live FREE Ethereum campaign from a ready live-plan. Spends nothing; approve, arm and run are still separate steps', (args) => args
    .option('contract', { type: 'string', demandOption: true })
    .option('wallets', { type: 'string', describe: 'Comma-separated public addresses (default: MINT_BOT_READINESS_WALLETS)' })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('priority-fee-gwei', { type: 'number', default: 0.1, describe: 'Tip per gas (more than 0, at most 2)' })
    .option('confirm', { type: 'string', demandOption: true, describe: 'The confirmation phrase live-plan printed' })
    .option('rpc-url', { type: 'string' }), async (args) => {
      try {
        const wallets = checkWallets(args.wallets);
        const port = args.rpcUrl ? EngineIntelligencePort.fromRpcUrl(args.rpcUrl) : await ethereumPort();
        const report = await checkDrop(port, args.contract, wallets, { simulate: true });
        const plan = buildLivePlan(report, { killSwitchPresent: existsSync(DEFAULT_KILL_FILE), custody: turnkeyCustodyEnabled() ? 'turnkey' : 'local' });
        const file = walletFile(args.walletFile);
        const readyWallets = assertLivePrepareAllowed({ plan, contract: args.contract, confirm: args.confirm, priorityFeeGwei: args.priorityFeeGwei, walletFileAddresses: await publicWallets(file) });
        const fields = liveFreeCampaignFields({ quantity: plan.quantity, wallets: readyWallets.length, tipWei: parseGwei(args.priorityFeeGwei.toString()) });
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, { walletFile: file }, { startCoordinator: false });
        const store = runtime.store as unknown as { ethereumFeePolicyStatus?: () => Parameters<typeof describeFeePolicy>[0] };
        if (typeof store.ethereumFeePolicyStatus !== 'function') throw new Error('CANONICAL_STORE_REQUIRED');
        const policy = store.ethereumFeePolicyStatus();
        if (policy.stored !== null && !policy.matchesApproved) throw new Error('FEE_POLICY_DIFFERS_FROM_APPROVED: run fee-policy status, then fee-policy apply with its confirmation phrase');
        assertTipMatchesStoredPolicy(policy, parseGwei(args.priorityFeeGwei.toString()));
        const campaign = await runtime.application.createCampaign({
          chainId: 1,
          contract: args.contract,
          strategy: 'seadrop-v1-public',
          quantity: fields.quantity,
          dryRun: false,
          maxRunWei: fields.maxRunWei,
          dailyCapWei: fields.dailyCapWei,
          gasCeilingWei: fields.gasCeilingWei,
          broadcastMode: 'public',
          chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, endpointReference: 'ETHEREUM_RPC_REFERENCE' },
          mintPriceWei: fields.mintPriceWei,
          feePolicy: fields.feePolicy,
        });
        process.stdout.write(`${json({ state: 'Prepared', campaignId: campaign.id, wallets: readyWallets, quantity: fields.quantity, maxExposureEth: plan.totalMaxExposureEth, planningMaxFeeGwei: report.quantityPlan?.maxFeeGwei ?? null, nextSteps: [`approve --campaign-id ${campaign.id}`, `arm --campaign-id ${campaign.id} --mode live`, 'remove the kill-switch file only when you are ready', 'run --run-id <the run id arm prints> --max-fee-gwei <the planning max fee above>'] })}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('survey-seadrop', 'Read-only survey of how SeaDrop mints are made on a chain (public, signed, allowlist, other)', (args) => args
    .option('chain', { type: 'string', choices: ['ethereum', 'robinhood'] as const, default: 'robinhood' })
    .option('blocks', { type: 'number', default: 20_000, describe: 'How many recent blocks to survey (maximum 400000)' })
    .option('rpc-url', { type: 'string', describe: 'Use this RPC instead of the saved one (https, or http on this machine only); Robinhood has a public one' })
    .option('max-transactions', { type: 'number', default: 1500, describe: 'Most mint transactions to look up (maximum 5000); when the window has fewer, every one is classified and the counts are exact' }), async (args) => {
      try {
        if (!Number.isSafeInteger(args.blocks) || args.blocks < 1 || args.blocks > 400_000) throw new Error('BLOCKS_OUT_OF_RANGE: use 1 to 400000');
        if (!Number.isSafeInteger(args.maxTransactions) || args.maxTransactions < 1 || args.maxTransactions > 5_000) throw new Error('MAX_TRANSACTIONS_OUT_OF_RANGE: use 1 to 5000');
        const config = args.rpcUrl ? { chainId: args.chain === 'ethereum' ? 1 : 4663, rpcEndpoints: [args.rpcUrl] } : await resolveChainByNameFromSecrets(args.chain, 'mainnet', configuredSecretRoot(runtimeRoot));
        const endpoint = config.rpcEndpoints[0];
        if (!endpoint) throw new Error(`${args.chain.toUpperCase()}_RPC_UNAVAILABLE`);
        let parsed: URL;
        try { parsed = new URL(endpoint); } catch { throw new Error('RPC_URL_INVALID'); }
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) throw new Error('RPC_MUST_BE_HTTPS');
        const chain = defineChain({ id: config.chainId, name: args.chain, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
        const client = createPublicClient({ chain, transport: httpTransport(endpoint, { timeout: 20_000, retryCount: 1 }) });
        // A wrong URL would be labelled with the chain name given, so check the endpoint really is that chain.
        const observedChainId = await client.getChainId();
        if (observedChainId !== config.chainId) throw new Error(`RPC_CHAIN_MISMATCH: that RPC is chain ${observedChainId}, not ${config.chainId} (${args.chain})`);
        const head = await client.getBlockNumber();
        const from = head >= BigInt(args.blocks) ? head - BigInt(args.blocks) + 1n : 0n;
        const result = await surveySeaDropMints(client as never, { fromBlock: from, toBlock: head, maxTransactions: args.maxTransactions });
        // How long the window is, from the chain's own timestamps, so the result reads in minutes and not only blocks.
        const [first, last] = await Promise.all([client.getBlock({ blockNumber: from }), client.getBlock({ blockNumber: head })]).catch(() => [null, null] as const);
        const windowMinutes = first && last ? Math.round((Number(last.timestamp) - Number(first.timestamp)) / 60) : null;
        process.stdout.write(`${json({ chain: args.chain, windowMinutes, ...result })}\n`);
      } catch (error) {
        // Provider errors can carry the RPC URL (and its key), so only a cleaned short description is printed.
        process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`);
      }
    })
  .command('probe-rpc', 'Read-only load probe of a chain RPC: latency, errors and rate limiting at rising concurrency', (args) => args
    .option('chain', { type: 'string', choices: ['ethereum', 'robinhood'] as const, default: 'ethereum' })
    .option('requests', { type: 'number', default: 30, describe: 'Requests per step (1 to 100)' }), async (args) => {
      try {
        const config = await resolveChainByNameFromSecrets(args.chain, 'mainnet', configuredSecretRoot(runtimeRoot));
        const endpoint = config.rpcEndpoints[0];
        if (!endpoint) throw new Error(`${args.chain.toUpperCase()}_RPC_UNAVAILABLE`);
        let parsed: URL;
        try { parsed = new URL(endpoint); } catch { throw new Error('RPC_URL_INVALID'); }
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) throw new Error('RPC_MUST_BE_HTTPS');
        const chain = defineChain({ id: config.chainId, name: args.chain, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
        const client = createPublicClient({ chain, transport: httpTransport(endpoint, { timeout: 15_000, retryCount: 0 }) });
        process.stdout.write(`${json({ chain: args.chain, ...(await probeRpc(client as never, { requestsPerLevel: args.requests })) })}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('watch <action> [address]', 'Manage watched (whale) wallets for discovery: add, list, remove', (args) => args
    .positional('action', { type: 'string', choices: ['add', 'list', 'remove'] as const, demandOption: true })
    .positional('address', { type: 'string' })
    .option('label', { type: 'string' }), (args) => {
      const store = intelligenceRepository();
      try {
        if (args.action === 'list') { process.stdout.write(`${json({ watched: store.repo.observedAddresses(1).map((row) => ({ address: row.address, label: row.label, since: row.createdAt })) })}\n`); return; }
        if (!args.address) throw new Error('ADDRESS_REQUIRED');
        if (args.action === 'add') { const row = store.repo.addObservedAddress(1, args.address, args.label); process.stdout.write(`${json({ watching: row.address, label: row.label })}\n`); return; }
        process.stdout.write(`${json({ removed: store.repo.disableObservedAddress(1, args.address.toLowerCase()) })}\n`);
      } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
      finally { store.close(); }
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
    .option('max-fee-gwei', { type: 'number', describe: 'Highest fee per gas the run may sign with. Use the value live-plan printed; the default (100) is far above the free-mint fee allowance, so a live free mint with the default is refused.' })
    .option('idempotency-key', { type: 'string' }), async (args) => {
    if (args.maxFeeGwei !== undefined && (!Number.isFinite(args.maxFeeGwei) || args.maxFeeGwei <= 0 || args.maxFeeGwei > 500)) { process.stdout.write(`${blocked(new Error('MAX_FEE_GWEI_OUT_OF_RANGE: use more than 0 and at most 500'))}\n`); return; }
    const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, args.maxFeeGwei === undefined ? undefined : { maxFeePerGasGwei: args.maxFeeGwei });
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
