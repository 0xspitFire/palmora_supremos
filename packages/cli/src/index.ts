#!/usr/bin/env node
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createPublicKey, randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type Address, type Hex, encodeFunctionData, keccak256, parseAbi, parseEther, parseGwei } from 'viem';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { LocalEncryptedSigner, TurnkeySigner, canonicalPolicyDigest, createTurnkeyClient, createTurnkeyPolicyRecord, generateAndEncryptWallets, importAndEncryptWallets, readTurnkeySecretConfig, signTurnkeyPolicyRecord, turnkeyPolicyApproverKeyId, turnkeyPolicyRecordDigest, turnkeyProviderPolicyExpressions, validateTurnkeyActualProviderState, validateTurnkeyCanonicalPolicyRecord, validateTurnkeyPolicyAst, validateTurnkeyWalletMap, verifyTurnkeySignedPolicyRecord } from '@mint-bot/engine';
import type { WalletImportRecord } from '@mint-bot/engine';
import type { Signer, SignerFactory, TurnkeyWalletReference } from '@mint-bot/engine';
import { assertNoSymlinkParents, readProtectedText } from './turnkey-files.js';
import { configuredSecretRoot, configuredWalletPath, configuredWallets, createCliRuntime, turnkeyCustodyEnabled } from './runtime.js';
import { DEFAULT_IDLE_BALANCE_CEILINGS, ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, ROBINHOOD_FREE_PER_WALLET_CAP_WEI } from '@mint-bot/backend';
import type { Campaign, ValidatedCampaign } from '@mint-bot/backend';
import { withHiddenPassphrase } from './secure-prompt.js';
import { IntelligenceRepository, openDatabase, openDatabaseReadOnly } from '@mint-bot/database';
import { rankWatchedWallets, readRankingInputs, renderWatchRanking } from './watch-ranking.js';
import { failoverTransport, resolveChainByNameFromSecrets, resolveChainConfigFromSecrets, SEADROP_V1_ADDRESS } from '@mint-bot/engine';
import { fundingRequestEvent, planCampaignFunding, redactAddresses, renderFundingPlan } from './fleet-funding-cli.js';
import { buildCompensatingEvidence, createTrustCenterRecord, engageKillSwitchFile, evaluateStatus, lockfileDigest, parseRehearsalEvidence, parseTrustCenterRecord, probeOrEngageKillSwitch, walletSetDigest } from './compensating-controls-cli.js';
import { checkDrop, planAutoQuantity } from './drop-check.js';
import { commandErrorMessage, surveyErrorMessage, surveySeaDropMints } from './seadrop-survey.js';
import { checkAllowlist, parsePublishedList } from './allowlist-check.js';
import { probeRpc } from './rpc-probe.js';
import { PUBLIC_ROBINHOOD_RPC, checkFees, dryRunDrop, observeFinality } from './robinhood-readonly.js';
import { PUBLIC_ROBINHOOD_FEED, checkFeed, readFeed } from './feed-check.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { runRobinhoodEnable, type EnableStore } from './robinhood-enable.js';
import { refreshFinalityEvidence } from './robinhood-evidence-refresh.js';
import { runBaseEnable, type BaseEnableStore } from './base-enable.js';
import { runLiveRequest, type LiveRequestStore } from './live-request.js';
import { buildRobinhoodPlan, recordRobinhoodSimulationsAction, robinhoodConfirmationPhrase, robinhoodPrepareAction } from './robinhood-live.js';
import { asKillStore, killReleaseAction, livePlanAction, livePrepareAction, recordSimulationAction, watchAcceptAction, type PrepareStore } from './owner-actions.js';
import { newTotpSecret, totpUri } from './totp.js';
import { assertLiveRunAllowed, assertWalletFileMatchesRun, describeLiveRunResult, previewLiveRun, quantityPlanForRun } from './live-run.js';
import { createPersonalLiveProbes, liveReadinessPhrase, readinessMatchesChain } from './personal-live-cli.js';
import { PersonalLiveReadinessService, acceptEthereumChainEvidence, buildEthereumChainEvidence, ethereumChainEvidencePhrase, loadHostSecretStore, TelegramNotifier, killReleasedCard, plainSystemText, telegramTestCard } from '@mint-bot/backend';
import { assertFeePolicyApplyAllowed, describeFeePolicy, plainFeePolicyMessage } from './fee-policy.js';
import { createPublicClient, defineChain, http as httpTransport } from 'viem';
import { EngineIntelligencePort } from './intelligence-adapter.js';
import { normalizeWalletCommandArgs } from './wallet-command-routing.js';
import { approvalConfirmation, approverRotationConfirmation, assertApprovalKeyOutsideRuntimeRoot, writeTurnkeyApprovalBundle } from './turnkey-approval.js';
import { robinhoodTurnkeyPolicy } from './turnkey-policy-template.js';

/** Read-only Ethereum port for CLI checks; the RPC value stays in memory and is never printed. */
async function ethereumPort(): Promise<EngineIntelligencePort> {
  const config = await resolveChainByNameFromSecrets('ethereum', 'mainnet', configuredSecretRoot(runtimeRoot));
  if (config.rpcEndpoints.length === 0) throw new Error('ETHEREUM_RPC_UNAVAILABLE');
  return EngineIntelligencePort.fromRpcUrls(config.rpcEndpoints);
}

async function basePort(): Promise<EngineIntelligencePort> {
  const config = await resolveChainByNameFromSecrets('base', 'mainnet', configuredSecretRoot(runtimeRoot));
  if (config.rpcEndpoints.length === 0) throw new Error('BASE_RPC_UNAVAILABLE');
  return EngineIntelligencePort.fromRpcUrls(config.rpcEndpoints);
}

/** Wallets for read-only checks: explicit public addresses, never the keystore. */

/** Read-only client for Robinhood Chain; defaults to the chain's published public RPC, so no secret is needed. */
async function robinhoodReadClient(rpcUrl: string | undefined) {
  // An explicit --rpc-url is used alone. Otherwise the configured Robinhood providers are tried in order, and the chain's published
  // public RPC is the last resort, so a read moves on when a provider times out or fails.
  const configured = rpcUrl ? [] : await resolveChainConfigFromSecrets(4663, 'mainnet', configuredSecretRoot(runtimeRoot)).then((chain) => [...chain.rpcEndpoints]).catch(() => [] as string[]);
  const urls = rpcUrl ? [rpcUrl] : [...configured, PUBLIC_ROBINHOOD_RPC];
  for (const url of urls) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('RPC_URL_INVALID'); }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) throw new Error('RPC_MUST_BE_HTTPS');
  }
  const chain = defineChain({ id: 4663, name: 'robinhood', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
  return createPublicClient({ chain, transport: failoverTransport(urls, { timeoutMs: 20_000 }) });
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

const DEFAULT_WALLET_FILE = configuredWalletPath(runtimeRoot);
// On the host the service's kill file is KILL_SWITCH_PATH (T-061): owner commands run with the service's settings use the same file.
const DEFAULT_KILL_FILE = process.env.KILL_SWITCH_PATH ? resolve(runtimeRoot, process.env.KILL_SWITCH_PATH) : join(runtimeRoot, 'Rets', 'state', 'killswitch');
const DEFAULT_WALLET_IMPORT_ROOT = '/home/Junayd/W3/Rets/wallets';

function walletFile(value: string | undefined): string {
  return configuredWalletPath(runtimeRoot, value ?? process.env.MINT_BOT_WALLET_FILE);
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

function turnkeySecretPath(value: string | undefined, defaultName: string): string {
  const secretRoot = resolve(configuredSecretRoot(runtimeRoot));
  const candidate = resolve(value ?? join(secretRoot, defaultName));
  const outside = relative(secretRoot, candidate);
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new Error('Turnkey artifact must remain under the configured secret root');
  return candidate;
}

async function writeTurnkeyWalletMap(path: string, map: unknown): Promise<void> {
  // Never persist a map that lacks the exact policy/provider/key scope required by the signer.
  const validated = validateTurnkeyWalletMap(map);
  await ensureParent(path);
  await assertNoSymlinkParents(path, 'TURNKEY_WALLET_MAP_PATH_INVALID');
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(validated, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readOwnerOnlyText(path: string, errorCode: string): Promise<string> {
  return readProtectedText(path, errorCode, false);
}

async function readTurnkeyRuntimeText(path: string, errorCode: string): Promise<string> {
  return readProtectedText(path, errorCode, true);
}

async function writeTurnkeyJson(path: string, value: unknown): Promise<void> {
  await ensureParent(path);
  await assertNoSymlinkParents(path, 'TURNKEY_ARTIFACT_PATH_INVALID');
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function walletReferencesFromArtifact(value: unknown): TurnkeyWalletReference[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { wallets?: unknown }).wallets)) throw new Error('TURNKEY_WALLET_REFERENCE_INVALID');
  return ((value as { wallets: unknown[] }).wallets).map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('TURNKEY_WALLET_REFERENCE_INVALID');
    const wallet = entry as { index?: unknown; address?: unknown; signWith?: unknown };
    if (wallet.index !== index || typeof wallet.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address) || typeof wallet.signWith !== 'string' || wallet.signWith.length === 0) throw new Error('TURNKEY_WALLET_REFERENCE_INVALID');
    return { index, address: wallet.address.toLowerCase() as Address, signWith: wallet.signWith };
  });
}

function policyFromLegacyWalletArtifact(value: unknown, config: { organizationId: string; userId: string; environment: 'production' | 'testnet' }, wallets: readonly TurnkeyWalletReference[]): ReturnType<typeof validateTurnkeyPolicyAst> {
  if (!value || typeof value !== 'object') throw new Error('TURNKEY_LEGACY_POLICY_INVALID');
  const artifact = value as { policyId?: unknown; policy?: unknown };
  if (typeof artifact.policyId !== 'string' || !artifact.policy || typeof artifact.policy !== 'object') throw new Error('TURNKEY_LEGACY_POLICY_INVALID');
  const legacy = artifact.policy as Record<string, unknown>;
  const address = (field: string): Address => {
    const candidate = legacy[field];
    if (typeof candidate !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(candidate)) throw new Error('TURNKEY_LEGACY_POLICY_INVALID');
    return candidate as Address;
  };
  const integer = (field: string): string => {
    const candidate = legacy[field];
    if (typeof candidate !== 'string' || !/^(?:0|[1-9]\d*)$/.test(candidate)) throw new Error('TURNKEY_LEGACY_POLICY_INVALID');
    return candidate;
  };
  const chainId = legacy.chainId;
  if (chainId !== 1 && chainId !== 8453 && chainId !== 4663) throw new Error('TURNKEY_LEGACY_POLICY_INVALID');
  const data = encodeFunctionData({
    abi: parseAbi(['function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity)']),
    functionName: 'mintPublic',
    args: [address('nftContract'), address('feeRecipient'), address('minterIfNotPayer'), BigInt(integer('quantity'))],
  });
  if (typeof legacy.functionSelector !== 'string' || data.slice(0, 10).toLowerCase() !== legacy.functionSelector.toLowerCase()) throw new Error('TURNKEY_LEGACY_POLICY_INVALID');
  return validateTurnkeyPolicyAst({
    version: 1,
    effect: 'allow',
    scope: { provider: 'turnkey', environment: config.environment, organizationId: config.organizationId, userId: config.userId, policyId: artifact.policyId, keyIds: wallets.map((wallet) => wallet.signWith) },
    transaction: { chainId, from: wallets.map((wallet) => wallet.address), to: address('to'), valueWei: integer('maxValueWei'), data, gasLimitMax: integer('maxGasLimit'), maxFeePerGasMax: integer('maxFeePerGas'), maxPriorityFeePerGasMax: integer('maxPriorityFeePerGas'), accessList: [] },
  });
}

async function requireEngagedKillSwitch(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => undefined);
  if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error('KILL_SWITCH_NOT_ENGAGED');
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
  // Live arm needs one fresh passing simulation record per wallet (record-simulation writes them); dry runs ignore the ids.
  const nowIso = new Date().toISOString();
  const latest = new Map<string, { id: string; checkedAt: string }>();
  for (const simulation of runtime.store.snapshot().simulations) {
    if (simulation.campaignId !== campaignId || !simulation.success || simulation.expiresAt <= nowIso) continue;
    const key = simulation.wallet.toLowerCase();
    if (!latest.has(key) || simulation.checkedAt > latest.get(key)!.checkedAt) latest.set(key, { id: simulation.id, checkedAt: simulation.checkedAt });
  }
  const simulationIds = wallets.flatMap((wallet) => latest.get(wallet.toLowerCase())?.id ?? []);
  return { campaign: persistedCampaign(runtime, campaignId), wallets, simulationIds: simulationIds.length === wallets.length ? simulationIds : [], evidenceAt: nowIso };
}

const cli = yargs(normalizeWalletCommandArgs(hideBin(process.argv)))
  .scriptName('mint-bot')
  .strict()
  .demandCommand(1)
  .help()
  .command('wallet-generate', 'Generate independently encrypted wallets (`wallet generate`)', (args) => args
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
  .command('wallet-list', 'List wallet addresses without decrypting private keys (`wallet list`)', (args) => args
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
  .command('wallet-import', 'Encrypt approved wallet env files for local testing (`wallet import`)', (args) => args
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
  .command('wallet-import-turnkey', 'Legacy command retained as a fail-closed migration guard', {}, async () => {
    try { throw new Error('TURNKEY_IMPORT_REQUIRES_SIGNED_POLICY_WORKFLOW'); } catch (error) { printError(error); }
  })
  .command('turnkey-robinhood-policy-prepare', 'Create an owner-only exact free-mint enforcement policy for chain 4663', (args) => args
    .option('policy-id', { type: 'string', default: 'pending-provider-policy', description: 'Exact provider policy ID returned by Turnkey; omit only to print the provider-policy template before creation' })
    .option('nft-contract', { type: 'string', demandOption: true })
    .option('fee-recipient', { type: 'string', demandOption: true })
    .option('quantity', { type: 'number', default: 1 })
    .option('gas-limit-max', { type: 'string', default: '500000' })
    .option('max-fee-gwei', { type: 'string', default: '0.2' })
    .option('priority-fee-gwei', { type: 'string', default: '0.1' })
    .option('wallet-artifact', { type: 'string', description: 'Existing wallet map containing only public wallet/key references' })
    .option('output', { type: 'string', description: 'Policy AST output under the secret root' }), async (args) => {
      try {
        if (!/^0x[0-9a-fA-F]{40}$/.test(args.nftContract) || !/^0x[0-9a-fA-F]{40}$/.test(args.feeRecipient)) throw new Error('TURNKEY_ROBINHOOD_POLICY_ADDRESS_INVALID');
        const secretRoot = configuredSecretRoot(runtimeRoot);
        const config = await readTurnkeySecretConfig(secretRoot);
        const artifactPath = turnkeyMapPath(args.walletArtifact ?? config.walletMapPath);
        const artifact = JSON.parse(await readOwnerOnlyText(artifactPath, 'TURNKEY_WALLET_MAP_PERMISSIONS_REQUIRED')) as unknown;
        const wallets = walletReferencesFromArtifact(artifact);
        const policy = robinhoodTurnkeyPolicy({ environment: config.environment, organizationId: config.organizationId, userId: config.userId, policyId: args.policyId, wallets, nftContract: args.nftContract as Address, feeRecipient: args.feeRecipient as Address, quantity: args.quantity, gasLimitMax: args.gasLimitMax, maxFeePerGasGwei: args.maxFeeGwei, maxPriorityFeePerGasGwei: args.priorityFeeGwei });
        const providerPolicy = turnkeyProviderPolicyExpressions(policy);
        const output = turnkeySecretPath(args.output, 'turnkey-robinhood-policy-ast.json');
        await writeTurnkeyJson(output, policy);
        process.stdout.write(`${JSON.stringify({ ok: true, output, chainId: 4663, walletCount: wallets.length, policyId: args.policyId, policyDigest: canonicalPolicyDigest(policy), providerPolicy: { effect: 'EFFECT_ALLOW', ...providerPolicy, time: null } })}\n`);
      } catch (error) { printError(error); }
    })
  .command('turnkey-policy-propose', 'Snapshot actual Turnkey fields into an unsigned canonical policy record', (args) => args
    .option('policy-ast', { type: 'string', description: 'Owner-only canonical enforcement policy AST' })
    .option('wallet-artifact', { type: 'string', description: 'Owner-only legacy or v2 wallet map used only for public key references' })
    .option('output', { type: 'string', description: 'Unsigned proposal output under the secret root' })
    .option('valid-hours', { type: 'number', default: 168 }), async (args) => {
      try {
        if (!Number.isSafeInteger(args.validHours) || args.validHours < 1 || args.validHours > 720) throw new Error('TURNKEY_POLICY_VALIDITY_INVALID');
        const secretRoot = configuredSecretRoot(runtimeRoot);
        const config = await readTurnkeySecretConfig(secretRoot);
        const artifactPath = turnkeyMapPath(args.walletArtifact ?? config.walletMapPath);
        const artifact = JSON.parse(await readOwnerOnlyText(artifactPath, 'TURNKEY_WALLET_MAP_PERMISSIONS_REQUIRED')) as unknown;
        const wallets = walletReferencesFromArtifact(artifact);
        const policy = args.policyAst
          ? validateTurnkeyPolicyAst(JSON.parse(await readOwnerOnlyText(turnkeyPolicyPath(args.policyAst), 'TURNKEY_POLICY_AST_PERMISSIONS_REQUIRED')) as unknown)
          : policyFromLegacyWalletArtifact(artifact, config, wallets);
        if (policy.scope.organizationId !== config.organizationId || policy.scope.userId !== config.userId || policy.scope.environment !== config.environment) throw new Error('TURNKEY_POLICY_PROVIDER_BINDING_INVALID');
        const client = createTurnkeyClient(config.organizationId, config.apiPublicKey, config.apiPrivateKey);
        const [whoami, organization, policies, keys] = await Promise.all([
          client.getWhoami({ organizationId: config.organizationId }),
          client.getOrganizationConfigs({ organizationId: config.organizationId }),
          client.getPolicies({ organizationId: config.organizationId }),
          client.getPrivateKeys({ organizationId: config.organizationId }),
        ]);
        const matchingPolicies = policies.policies.filter((candidate) => Boolean(candidate) && typeof candidate === 'object' && (candidate as { policyId?: unknown }).policyId === policy.scope.policyId);
        if (matchingPolicies.length !== 1) throw new Error('TURNKEY_PROVIDER_POLICY_NOT_FOUND');
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + args.validHours * 60 * 60 * 1000);
        const record = createTurnkeyPolicyRecord({
          environment: config.environment,
          providerIdentity: whoami,
          providerPolicy: matchingPolicies[0],
          enforcementPolicy: policy,
          walletReferences: wallets,
          providerKeys: keys.privateKeys,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        });
        validateTurnkeyActualProviderState(record, { whoami, organization, policies: policies.policies, privateKeys: keys.privateKeys });
        const output = turnkeySecretPath(args.output, 'turnkey-policy-proposal.json');
        await writeTurnkeyJson(output, record);
        process.stdout.write(`${JSON.stringify({ ok: true, output, recordDigest: turnkeyPolicyRecordDigest(record), policyId: record.providerPolicy.policyId, walletCount: record.wallets.length, issuedAt: record.issuedAt, expiresAt: record.expiresAt })}\n`);
      } catch (error) { printError(error); }
    })
  .command('turnkey-policy-sign', 'Sign a reviewed canonical policy proposal with the product-owner approval key', (args) => args
    .option('proposal', { type: 'string' })
    .option('private-key', { type: 'string', demandOption: true })
    .option('public-key-output', { type: 'string' })
    .option('record-output', { type: 'string' })
    .option('rotate-confirm', { type: 'string', description: 'Separate old/new key confirmation required only when replacing an existing pin' })
    .option('preview', { type: 'boolean', default: false, description: 'Print the exact signature and optional rotation confirmations without signing' })
    .option('confirm', { type: 'string' }), async (args) => {
      try {
        const secretRoot = resolve(configuredSecretRoot(runtimeRoot));
        const proposalPath = turnkeySecretPath(args.proposal, 'turnkey-policy-proposal.json');
        const privateKeyPath = assertApprovalKeyOutsideRuntimeRoot(args.privateKey, secretRoot);
        const publicKeyOutput = turnkeySecretPath(args.publicKeyOutput, 'turnkey-policy-approver.pub');
        const recordOutput = turnkeySecretPath(args.recordOutput, 'turnkey-policy-record.json');
        const proposal = validateTurnkeyCanonicalPolicyRecord(JSON.parse(await readOwnerOnlyText(proposalPath, 'TURNKEY_POLICY_PROPOSAL_PERMISSIONS_REQUIRED')) as unknown);
        const digest = turnkeyPolicyRecordDigest(proposal);
        const privateKey = await readOwnerOnlyText(privateKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED');
        const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
        const keyId = turnkeyPolicyApproverKeyId(publicKey);
        const expectedConfirmation = approvalConfirmation(digest, proposal.wallets.length, keyId);
        const existingPin = await lstat(publicKeyOutput).then((entry) => entry.isFile() && !entry.isSymbolicLink()).catch(() => false)
          ? await readOwnerOnlyText(publicKeyOutput, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED')
          : undefined;
        const existingKeyId = existingPin ? turnkeyPolicyApproverKeyId(existingPin) : undefined;
        const expectedRotation = existingKeyId && existingKeyId !== keyId ? approverRotationConfirmation(existingKeyId, keyId) : undefined;
        if (args.preview) {
          process.stdout.write(`${JSON.stringify({ ok: true, preview: true, recordDigest: digest, keyId, confirmation: expectedConfirmation, ...(expectedRotation ? { rotationConfirmation: expectedRotation } : {}) })}\n`);
          return;
        }
        if (args.confirm !== expectedConfirmation) throw new Error(`TURNKEY_POLICY_SIGN_CONFIRMATION_REQUIRED: ${expectedConfirmation}`);
        if (existingPin) {
          if (expectedRotation && args.rotateConfirm !== expectedRotation) throw new Error(`TURNKEY_POLICY_APPROVER_ROTATION_CONFIRMATION_REQUIRED: ${expectedRotation}`);
        }
        const signed = signTurnkeyPolicyRecord(proposal, privateKey);
        verifyTurnkeySignedPolicyRecord(signed, publicKey);
        if ([proposalPath, privateKeyPath].some((path) => resolve(path) === resolve(recordOutput) || resolve(path) === resolve(publicKeyOutput))) throw new Error('TURNKEY_POLICY_OUTPUT_PATH_CONFLICT');
        await writeTurnkeyApprovalBundle(recordOutput, signed, publicKeyOutput, publicKey);
        process.stdout.write(`${JSON.stringify({ ok: true, recordOutput, publicKeyOutput, recordDigest: signed.recordDigest, keyId: signed.keyId })}\n`);
      } catch (error) { printError(error); }
    })
  .command('turnkey-wallet-map-regenerate', 'Verify the signed record against live Turnkey state and atomically regenerate the wallet map', (args) => args
    .option('confirm', { type: 'string', demandOption: true }), async (args) => {
      try {
        const config = await readTurnkeySecretConfig(configuredSecretRoot(runtimeRoot));
        const signed = JSON.parse(await readTurnkeyRuntimeText(config.policyRecordPath, 'TURNKEY_POLICY_RECORD_PERMISSIONS_REQUIRED')) as unknown;
        const publicKey = await readTurnkeyRuntimeText(config.policyApproverPublicKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED');
        const record = verifyTurnkeySignedPolicyRecord(signed, publicKey);
        if (args.confirm !== `REGENERATE-TURNKEY-MAP ${turnkeyPolicyRecordDigest(record).slice(-8)} ${record.wallets.length}-WALLETS`) throw new Error('TURNKEY_MAP_CONFIRMATION_INVALID');
        const client = createTurnkeyClient(config.organizationId, config.apiPublicKey, config.apiPrivateKey);
        const [whoami, organization, policies, keys] = await Promise.all([
          client.getWhoami({ organizationId: config.organizationId }),
          client.getOrganizationConfigs({ organizationId: config.organizationId }),
          client.getPolicies({ organizationId: config.organizationId }),
          client.getPrivateKeys({ organizationId: config.organizationId }),
        ]);
        validateTurnkeyActualProviderState(record, { whoami, organization, policies: policies.policies, privateKeys: keys.privateKeys });
        await writeTurnkeyWalletMap(config.walletMapPath, { version: 2, policyRecordDigest: turnkeyPolicyRecordDigest(record), wallets: record.wallets.map(({ index, address, signWith }) => ({ index, address, signWith })) });
        process.stdout.write(`${JSON.stringify({ ok: true, walletCount: record.wallets.length, policyRecordDigest: turnkeyPolicyRecordDigest(record), liveProviderStateMatched: true })}\n`);
      } catch (error) { printError(error); }
    })
  .command('turnkey-signing-rehearsal', 'Sign an intentionally non-broadcastable transaction and persist redacted activity evidence', (args) => args
    .option('evidence-output', { type: 'string' })
    .option('confirm', { type: 'string', demandOption: true }), async (args) => {
      let signer: TurnkeySigner | undefined;
      try {
        await requireEngagedKillSwitch(resolve(process.env.KILL_SWITCH_PATH ?? DEFAULT_KILL_FILE));
        const config = await readTurnkeySecretConfig(configuredSecretRoot(runtimeRoot));
        const signed = JSON.parse(await readTurnkeyRuntimeText(config.policyRecordPath, 'TURNKEY_POLICY_RECORD_PERMISSIONS_REQUIRED')) as unknown;
        const publicKey = await readTurnkeyRuntimeText(config.policyApproverPublicKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED');
        const record = verifyTurnkeySignedPolicyRecord(signed, publicKey);
        const digest = turnkeyPolicyRecordDigest(record);
        if (args.confirm !== `REHEARSE-TURNKEY-SIGNING ${digest.slice(-8)} NO-BROADCAST`) throw new Error('TURNKEY_REHEARSAL_CONFIRMATION_INVALID');
        signer = await TurnkeySigner.fromSecrets('mainnet', configuredSecretRoot(runtimeRoot));
        const health = await signer.probe();
        const wallet = (await signer.listWallets())[0];
        if (!wallet) throw new Error('TURNKEY_WALLET_NOT_FOUND');
        const tx = record.enforcementPolicy.transaction;
        const result = await signer.signTransactionWithEvidence(wallet.index, {
          chainId: tx.chainId,
          nonce: Number.MAX_SAFE_INTEGER,
          from: wallet.address,
          to: tx.to,
          value: BigInt(tx.valueWei),
          data: tx.data,
          gasLimit: 0n,
          maxFeePerGas: 0n,
          maxPriorityFeePerGas: 0n,
          accessList: [],
          policyRef: signer.policyReference(),
        });
        const evidence = {
          version: 1,
          type: 'turnkey-signing-rehearsal',
          recordedAt: new Date().toISOString(),
          organizationId: health.organizationId,
          policyId: health.policyId,
          policyRecordDigest: digest,
          walletSetDigest: walletSetDigest(record.wallets.map((entry) => entry.address)),
          lockfileDigest: await lockfileDigest(runtimeRoot),
          walletAddress: wallet.address,
          activityId: result.evidence.activityId,
          activityFingerprint: result.evidence.activityFingerprint,
          appProofCount: result.evidence.appProofCount,
          signedTransactionHash: keccak256(result.signedTransaction),
          safety: { broadcastAttempted: false, gasLimit: '0', nonce: String(Number.MAX_SAFE_INTEGER), signedTransactionRetained: false },
        };
        const output = turnkeySecretPath(args.evidenceOutput, 'turnkey-signing-rehearsal.json');
        await writeTurnkeyJson(output, evidence);
        process.stdout.write(`${JSON.stringify({ ok: true, output, ...evidence })}\n`);
      } catch (error) { printError(error); } finally { signer?.zeroize(); }
    })
  .command('trust-center-record', 'Record the quarterly Turnkey Trust Center review (names, dates and SHA-256 digests only; D-058 control 6)', (args) => args
    .option('document', { type: 'string', array: true, demandOption: true, description: 'NAME::YYYY-MM-DD::path-to-the-downloaded-document (repeat for each document)' })
    .option('reviewed-at', { type: 'string', description: 'ISO time of the review; default now' })
    .option('output', { type: 'string' }), async (args) => {
      try {
        const documents = [];
        for (const entry of args.document as string[]) {
          const parts = entry.split('::');
          if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error('TRUST_CENTER_DOCUMENT_ARGUMENT_INVALID');
          documents.push({ name: parts[0], date: parts[1], bytes: new Uint8Array(await readFile(resolve(parts[2]))) });
        }
        const record = createTrustCenterRecord({ reviewedAt: args.reviewedAt ?? new Date().toISOString(), documents });
        const output = turnkeySecretPath(args.output, 'turnkey-trust-center-review.json');
        await writeTurnkeyJson(output, record);
        process.stdout.write(`${JSON.stringify({ ok: true, output, reviewedAt: record.reviewedAt, documents: record.documents.map((document) => ({ name: document.name, date: document.date, sha256: document.sha256 })) })}\n`);
      } catch (error) { printError(error); }
    })
  .command('compensating-controls-status', 'Check all seven D-058 controls now (read-only; a failed provider check engages the kill switch)', (args) => args
    .option('chain-id', { type: 'number', demandOption: true, choices: [1, 8453, 4663] })
    .option('wallet-ceiling-wei', { type: 'string', default: '400000000000000' })
    .option('fleet-ceiling-wei', { type: 'string', default: '2000000000000000' })
    .option('rehearsal', { type: 'string' })
    .option('trust-center', { type: 'string' }), async (args) => {
      let signer: TurnkeySigner | undefined;
      try {
        if (!/^\d{1,30}$/.test(args.walletCeilingWei) || !/^\d{1,30}$/.test(args.fleetCeilingWei)) throw new Error('BALANCE_CEILING_INVALID');
        const secretRoot = configuredSecretRoot(runtimeRoot);
        const config = await readTurnkeySecretConfig(secretRoot);
        const signed = JSON.parse(await readTurnkeyRuntimeText(config.policyRecordPath, 'TURNKEY_POLICY_RECORD_PERMISSIONS_REQUIRED')) as unknown;
        const publicKey = await readTurnkeyRuntimeText(config.policyApproverPublicKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED');
        const record = verifyTurnkeySignedPolicyRecord(signed, publicKey);
        const digest = turnkeyPolicyRecordDigest(record);
        signer = await TurnkeySigner.fromSecrets('mainnet', secretRoot);
        const killPath = resolve(process.env.KILL_SWITCH_PATH ?? DEFAULT_KILL_FILE);
        const probe = await probeOrEngageKillSwitch(async () => { const health = await signer!.probe(); return { status: health.status, policyRecordDigest: health.policyRecordDigest }; }, (reason) => engageKillSwitchFile(killPath, reason));
        const chain = await resolveChainConfigFromSecrets(args.chainId as 1 | 8453 | 4663, 'mainnet', secretRoot);
        const endpoint = chain.rpcEndpoints[0];
        if (!endpoint) throw new Error('CHAIN_ENDPOINT_UNAVAILABLE');
        const client = createPublicClient({ transport: failoverTransport(chain.rpcEndpoints) });
        const addresses = record.wallets.map((entry) => entry.address);
        const balances = [];
        for (const address of addresses) balances.push({ address, balanceWei: await client.getBalance({ address: address as Address }) });
        const rehearsal = await readFile(turnkeySecretPath(args.rehearsal, 'turnkey-signing-rehearsal.json'), 'utf8').then((text) => parseRehearsalEvidence(JSON.parse(text))).catch(() => undefined);
        const trustCenter = await readFile(turnkeySecretPath(args.trustCenter, 'turnkey-trust-center-review.json'), 'utf8').then((text) => parseTrustCenterRecord(JSON.parse(text))).catch(() => undefined);
        const now = new Date();
        const evidence = buildCompensatingEvidence({
          chainId: args.chainId,
          record: { digest, issuedAt: record.issuedAt, expiresAt: record.expiresAt, wallets: addresses },
          lockfileDigest: await lockfileDigest(runtimeRoot),
          probe,
          balances,
          ...(rehearsal ? { rehearsal } : {}),
          ...(trustCenter ? { trustCenter } : {}),
          now,
        });
        const status = evaluateStatus(evidence, { ceilings: { [args.chainId]: { walletMaxWei: BigInt(args.walletCeilingWei), fleetMaxWei: BigInt(args.fleetCeilingWei) } }, expected: { recordDigest: digest, walletSetDigest: walletSetDigest(addresses), lockfileDigest: evidence.lockfileDigest } }, now);
        process.stdout.write(`${status.text}\n`);
        if (!status.valid) process.exitCode = 1;
      } catch (error) { printError(error); } finally { signer?.zeroize(); }
    })
  .command('fleet-funding-plan', 'Work out what each wallet needs for one run and, with --request, ask the service to message you (MintBot never sends funds)', (args) => args
    .option('campaign-id', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('request', { type: 'boolean', default: false }), async (args) => {
      try {
        const treasury = process.env.MINT_BOT_TREASURY_ADDRESS ?? '';
        if (!/^0x[0-9a-fA-F]{40}$/.test(treasury)) throw new Error('FLEET_WATCH_TREASURY_INVALID');
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
        const campaign = runtime.store.snapshot().campaigns.find((item) => item.id === args.campaignId);
        if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
        const addresses = await publicWallets(walletFile(args.walletFile));
        const chain = await resolveChainConfigFromSecrets(campaign.chainId, 'mainnet', configuredSecretRoot(runtimeRoot));
        const endpoint = chain.rpcEndpoints[0];
        if (!endpoint) throw new Error('CHAIN_ENDPOINT_UNAVAILABLE');
        const client = createPublicClient({ transport: failoverTransport(chain.rpcEndpoints) });
        const balances = [];
        for (const address of addresses) balances.push({ address, balanceWei: await client.getBalance({ address: address as Address }) });
        const plan = planCampaignFunding({ campaign, balances, ceilings: DEFAULT_IDLE_BALANCE_CEILINGS });
        process.stdout.write(`${renderFundingPlan(plan, treasury)}\n`);
        if (args.request) {
          const event = fundingRequestEvent(plan, campaign.id, new Date());
          await runtime.store.transaction((state) => { state.events.push({ id: `evt_${randomBytes(8).toString('hex')}`, type: event.type, at: event.at, data: event.data }); });
          process.stdout.write('Request recorded. The running service will message you on Telegram. When the funds arrive, check the balances yourself before arming: the arm step does not enforce this yet.\n');
        } else if (!plan.ready && plan.blockers.length === 0) process.stdout.write('Add --request to have the service message you this plan.\n');
        if (plan.blockers.length > 0) process.exitCode = 1;
      } catch (error) { printError(new Error(redactAddresses(error instanceof Error ? error.message : 'UNKNOWN_ERROR'))); }
    })
  .command('fleet-watch-accept', 'After investigating a watcher finding, accept a wallet\'s current on-chain state as its new baseline', (args) => args
    .option('chain-id', { type: 'number', demandOption: true, choices: [1, 8453, 4663] })
    .option('address', { type: 'string', demandOption: true })
    .option('confirm', { type: 'string' }), async (args) => {
      try {
        if (!/^0x[0-9a-fA-F]{40}$/.test(args.address)) throw new Error('FLEET_WATCH_ADDRESS_INVALID');
        const chain = await resolveChainConfigFromSecrets(args.chainId as 1 | 8453 | 4663, 'mainnet', configuredSecretRoot(runtimeRoot));
        const endpoint = chain.rpcEndpoints[0];
        if (!endpoint) throw new Error('CHAIN_ENDPOINT_UNAVAILABLE');
        const client = createPublicClient({ transport: failoverTransport(chain.rpcEndpoints) });
        const runtime = args.confirm === undefined ? undefined : await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
        const outcome = await watchAcceptAction({ chainId: args.chainId as 1 | 8453 | 4663, address: args.address, confirm: args.confirm, client, store: runtime?.store ?? { transaction: async () => { throw new Error('CONFIRMATION_PHRASE_MISMATCH'); } }, newId: () => `evt_${randomBytes(8).toString('hex')}`, now: new Date() });
        process.stdout.write(outcome.state === 'Preview' ? `${outcome.message} To accept, run this command again with: --confirm "${outcome.phrase}"\n` : `${outcome.message}\n`);
      } catch (error) { printError(new Error(redactAddresses(error instanceof Error ? error.message : 'UNKNOWN_ERROR'))); }
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
        // An existing file (the host service starts with one) never skips the stored flag and the abort of remaining runs.
        const existed = await writeFile(args.file, `killed at ${new Date().toISOString()}\n`, { flag: 'wx' }).then(() => false, (error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') return true; throw error; });
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
        await runtime.application.command('kill', { reason: 'operator CLI kill switch' });
        console.log(existed ? `Kill switch was already on (${args.file}); the stored stop is now set as well.` : `Kill switch enabled: ${args.file}`);
      } catch (error) {
        printError(error);
      }
    })
  .command('mint', 'Create and execute a backend-admitted SeaDrop dry run', (args) => args
    .option('chain', { type: 'string', choices: ['ethereum', 'base', 'robinhood'] as const, default: 'ethereum' })
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
        const chainId = args.chain === 'ethereum' ? 1 : args.chain === 'base' ? 8453 : 4663;
        const priorityFee = parseGwei(args.priorityFeeGwei.toString());
        // The mint price comes from chain (T-004, P2-08), never an assumed zero.
        const port = chainId === 1 ? await ethereumPort() : chainId === 8453 ? await basePort() : null;
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
          broadcastMode: chainId === 4663 ? 'sequencer' : 'public',
          chainVerification: { chainId, status: chainId === 1 ? 'verified' : 'unverified', seaDropCompatible: chainId === 1 || chainId === 8453, endpointReference: chainId === 1 ? 'ETHEREUM_RPC_REFERENCE' : chainId === 8453 ? 'BASE_RPC_REFERENCE' : 'ROBINHOOD_RPC_REFERENCE' },
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
    const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
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
            const client = createPublicClient({ chain: defineChain({ id: config.chainId, name: 'ethereum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } }), transport: failoverTransport(config.rpcEndpoints.filter((url) => url.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url))) });
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
      try { process.stdout.write(`${json(await observeFinality((await robinhoodReadClient(args.rpcUrl)) as never, { minutes: args.minutes, samples: args.samples }))}\n`); }
      catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('robinhood-evidence-refresh', 'Owner-run: re-run the finality observation (E3) and write a NEW evidence file with only E3 updated; writes nothing unless finality is proven', (args) => args
    .option('from', { type: 'string', demandOption: true, describe: 'The current evidence file (never changed)' })
    .option('out', { type: 'string', demandOption: true, describe: 'The new evidence file to create (must not exist)' })
    .option('minutes', { type: 'number', default: 30, describe: 'How long to watch (1 to 60); Ethereum finality takes about 15 to 20 minutes' })
    .option('samples', { type: 'number', default: 5, describe: 'Fresh transactions to follow (3 to 20)' })
    .option('rpc-url', { type: 'string', describe: 'Override the public Robinhood RPC' }), async (args) => {
      try {
        const evidenceText = await readFile(resolve(args.from), 'utf8');
        const out = resolve(args.out);
        if (existsSync(out)) throw new Error('OUTPUT_FILE_EXISTS: choose a new file name; the old file is never overwritten');
        const report = await observeFinality((await robinhoodReadClient(args.rpcUrl)) as never, { minutes: args.minutes, samples: args.samples });
        const refreshed = refreshFinalityEvidence({ evidenceText, report, today: new Date() });
        await writeFile(out, refreshed.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        process.stdout.write(`${json({ state: 'Refreshed', out, e3: refreshed.reference, summary: report.summary, next: `Run: robinhood-enable status --evidence-file ${out}` })}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); process.exitCode = 1; }
    })
  .command('check-feed', 'Read-only (Robinhood E4): compare the sequencer feed with the RPC', (args) => args
    .option('seconds', { type: 'number', default: 45, describe: 'How long to listen to the feed (5 to 300)' })
    .option('transactions', { type: 'number', default: 30, describe: 'Transactions to compare (1 to 200)' })
    .option('rpc-url', { type: 'string' })
    .option('feed-url', { type: 'string', describe: 'Override the public feed (wss only)' }), async (args) => {
      try {
        if (!Number.isFinite(args.seconds) || args.seconds < 5 || args.seconds > 300) throw new Error('SECONDS_OUT_OF_RANGE: use 5 to 300');
        const feed = readFeed(args.feedUrl ?? PUBLIC_ROBINHOOD_FEED, { seconds: args.seconds, maxMessages: 5_000 });
        process.stdout.write(`${json(await checkFeed((await robinhoodReadClient(args.rpcUrl)) as never, feed, { maxTransactions: args.transactions }))}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('check-fees', 'Read-only (Robinhood E5): what real recent free mints cost, against the approved caps', (args) => args
    .option('blocks', { type: 'number', default: 3000, describe: 'Recent blocks to look through (1 to 20000)' })
    .option('samples', { type: 'number', default: 40 })
    .option('rpc-url', { type: 'string' }), async (args) => {
      try { process.stdout.write(`${json(await checkFees((await robinhoodReadClient(args.rpcUrl)) as never, { blocks: args.blocks, samples: args.samples }))}\n`); }
      catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('simulate-robinhood', 'Read-only (Robinhood E6): simulate a free mint for your wallets; never signs or sends', (args) => args
    .option('contract', { type: 'string', demandOption: true })
    .option('wallets', { type: 'string', describe: 'Comma-separated public addresses (default: MINT_BOT_READINESS_WALLETS)' })
    .option('quantity', { type: 'number', default: 1 })
    .option('rpc-url', { type: 'string' }), async (args) => {
      try { process.stdout.write(`${json(await dryRunDrop((await robinhoodReadClient(args.rpcUrl)) as never, args.contract, checkWallets(args.wallets), { quantity: args.quantity }))}\n`); }
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
  .command('kill-release', 'Owner-run: turn the kill switch off (the file and the stored flag) after checking nothing is in flight; asks for a typed confirmation', (args) => args
    .option('file', { type: 'string', default: DEFAULT_KILL_FILE })
    .option('confirm', { type: 'string', describe: 'The confirmation phrase this command printed' }), async (args) => {
      try {
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
        const outcome = await killReleaseAction({ store: asKillStore(runtime.store), killFile: args.file, confirm: args.confirm, actor: 'owner-cli' });
        if (outcome.state === 'Off') { process.stdout.write(`${json(outcome)}\n`); return; }
        if (outcome.state === 'On') {
          const { phrase, ...rest } = outcome;
          process.stdout.write(`${json({ state: rest.state, message: rest.message, engagedAt: rest.engagedAt, file: args.file, fileExists: rest.fileExists, unresolvedRuns: rest.unresolvedRuns, ...(phrase ? { copyThisToRelease: `kill-release --confirm "${phrase}"` } : {}) })}\n`);
          return;
        }
        const result = outcome;
        // A short note to Telegram, best effort: the release stands even if it cannot be delivered.
        let noticeSent = false;
        try {
          const secretStorePath = process.env.SECRET_STORE_PATH ?? join(configuredSecretRoot(runtimeRoot), 'MINT_BOT_SECRETS.env');
          await new TelegramNotifier({ secretStore: await loadHostSecretStore(secretStorePath) }).send({ eventId: `kill-release-${Date.now()}`, type: 'kill_switch_released', text: plainSystemText(killReleasedCard()), system: killReleasedCard() });
          noticeSent = true;
        } catch { noticeSent = false; }
        process.stdout.write(`${json({ state: 'Released', message: `The kill switch is off${result.released ? '' : ' (only the file was left)'}. Run live-readiness record next; create the kill switch again with the kill command at any time to stop.`, telegramNoticeSent: noticeSent })}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('watch-ranking', 'Read-only: rank your watched wallets by what the bot saw them do (activity and signal; profit and win rate are not measured yet)', (args) => args
    .option('db', { type: 'string', describe: 'The trial database to read (default: MINT_BOT_STATE_PATH, or the standard path)' })
    .option('top', { type: 'number', default: 15, describe: 'How many wallets to list (1 to 500)' })
    .option('format', { type: 'string', choices: ['text', 'json'] as const, default: 'text' }), async (args) => {
      try {
        if (!Number.isInteger(args.top) || args.top < 1 || args.top > 500) throw new Error('TOP_INVALID: use a whole number from 1 to 500');
        const database = openDatabaseReadOnly(resolve(runtimeRoot, args.db ?? process.env.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite'));
        try {
          const result = rankWatchedWallets(readRankingInputs(database));
          process.stdout.write(`${args.format === 'json' ? json({ ...result, ranked: result.ranked.slice(0, args.top) }) : renderWatchRanking(result, args.top)}\n`);
        } finally { database.close(); }
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('robinhood-enable <action>', 'Owner-run: switch Robinhood execution on until you revoke it (status | record | revoke). Paid also needs D-054 evidence', (args) => args
    .positional('action', { type: 'string', choices: ['status', 'record', 'revoke'] as const, demandOption: true })
    .option('evidence-file', { type: 'string', describe: 'Your JSON file with E1 to E7 (status and record; see Docs/robinhood-enable-evidence.template.json)' })
    .option('paid', { type: 'boolean', default: false, describe: 'Enable paid mints too; requires paidRehearsal and paidPolicyApproved evidence' })
    .option('confirm', { type: 'string', describe: 'The confirmation phrase status (record) or revoke printed' }), async (args) => {
      try {
        let evidenceText: string | undefined;
        if (args.action !== 'revoke') {
          if (!args.evidenceFile) throw new Error('EVIDENCE_FILE_REQUIRED: pass --evidence-file');
          const info = await lstat(args.evidenceFile);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 20_000) throw new Error('EVIDENCE_FILE_INVALID: it must be a plain file under 20 KB');
          evidenceText = await readFile(args.evidenceFile, 'utf8');
        }
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
        const store = runtime.store as unknown as Partial<EnableStore>;
        if (typeof store.ethereumLiveMintProven !== 'function' || typeof store.enableRobinhood !== 'function' || typeof store.robinhoodEnablement !== 'function' || typeof store.revokeRobinhood !== 'function') throw new Error('CANONICAL_STORE_REQUIRED');
        process.stdout.write(`${json(runRobinhoodEnable({ action: args.action, ...(evidenceText !== undefined && args.evidenceFile ? { evidenceText, evidenceFile: args.evidenceFile } : {}), paid: args.paid, confirm: args.confirm, now: new Date(), store: store as EnableStore, newId: () => `rh_enable_${randomBytes(8).toString('hex')}` }))}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('live-request <action>', 'Owner-run: ask the host service to arm and run one live mint (status | create). Every guard still applies', (args) => args
    .positional('action', { type: 'string', choices: ['status', 'create'] as const, demandOption: true })
    .option('campaign-id', { type: 'string', demandOption: true })
    .option('wallets', { type: 'string', demandOption: true, describe: 'Comma-separated wallet addresses, each with a fresh passing simulation' })
    .option('max-fee-gwei', { type: 'number', demandOption: true, describe: 'Highest fee per gas the service may sign with for this run' })
    .option('confirm', { type: 'string', describe: 'The confirmation phrase status printed' }), async (args) => {
      try {
        // The request is written to the service's database; nothing here reads custody secrets or can sign.
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false, allowTurnkey: false });
        const store = runtime.store as unknown as Partial<LiveRequestStore>;
        if (typeof store.recordLiveRunRequest !== 'function') throw new Error('CANONICAL_STORE_REQUIRED');
        const wallets = args.wallets.split(',').map((wallet) => wallet.trim()).filter((wallet) => wallet.length > 0);
        process.stdout.write(`${json(await runLiveRequest({ action: args.action, campaignId: args.campaignId, wallets, maxFeeGwei: args.maxFeeGwei, confirm: args.confirm, now: new Date(), store: store as LiveRequestStore, approve: (validated) => runtime.application.command('approve', { validated }) }))}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('telegram-setup', 'Owner-run on the host (D-063): make a new authenticator secret for /unlock and show where it goes. Writes nothing', {}, () => {
    const secret = newTotpSecret();
    process.stdout.write([
      'A new authenticator secret was made. It is shown here once and saved nowhere.',
      '',
      `  Secret (type it into your authenticator app as a "setup key", time-based): ${secret}`,
      `  Or open this link on your phone instead: ${totpUri(secret)}`,
      '',
      'Then, on the host:',
      '  1. sudo nano /etc/mint-bot/Rets/MINT_BOT_SECRETS.env',
      `  2. Add the line TELEGRAM_TOTP_SECRET=${secret} (replace the old line if there is one), and TG_OWNER_USER_ID=<your Telegram user ID>.`,
      '  3. Save, then: sudo systemctl restart mint-bot',
      '  4. In Telegram, send /unlock followed by the 6-digit code your app shows.',
      '',
      'Clear this screen afterwards (type: clear). Anyone who sees the secret can make codes.',
    ].join('\n') + '\n');
  })
  .command('base-enable <action>', 'Owner-run: record Base free attended enablement until you revoke it (status | record | revoke)', (args) => args
    .positional('action', { type: 'string', choices: ['status', 'record', 'revoke'] as const, demandOption: true })
    .option('evidence-file', { type: 'string', describe: 'Completed copy of Docs/base-enable-evidence.template.json (status and record)' })
    .option('paid', { type: 'boolean', default: false, describe: 'Enable paid Base too (D-062); the file must also contain paidRehearsal and paidPolicyApproved' })
    .option('confirm', { type: 'string', describe: 'The confirmation phrase status (record) or revoke printed' }), async (args) => {
      try {
        let evidenceText: string | undefined;
        if (args.action !== 'revoke') {
          if (!args.evidenceFile) throw new Error('EVIDENCE_FILE_REQUIRED: pass --evidence-file');
          const info = await lstat(args.evidenceFile);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 20_000) throw new Error('EVIDENCE_FILE_INVALID: it must be a plain file under 20 KB');
          evidenceText = await readFile(args.evidenceFile, 'utf8');
        }
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
        const store = runtime.store as unknown as Partial<BaseEnableStore>;
        if (typeof store.enableBase !== 'function' || typeof store.baseEnablement !== 'function' || typeof store.revokeBase !== 'function') throw new Error('CANONICAL_STORE_REQUIRED');
        process.stdout.write(`${json(runBaseEnable({ action: args.action, paid: args.paid, ...(evidenceText !== undefined && args.evidenceFile ? { evidenceText, evidenceFile: args.evidenceFile } : {}), ...(args.confirm !== undefined ? { confirm: args.confirm } : {}), now: new Date(), store: store as BaseEnableStore, newId: () => `base_enable_${randomBytes(8).toString('hex')}` }))}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('chain-evidence <action>', 'Owner-run: record Ethereum SeaDrop chain evidence for 7 days after a typed confirmation (needed before a live arm)', (args) => args
    .positional('action', { type: 'string', choices: ['status', 'accept'] as const, demandOption: true })
    .option('confirm', { type: 'string', describe: 'The confirmation phrase status printed (accept only)' })
    .option('rpc-url', { type: 'string' }), async (args) => {
      try {
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
        const now = new Date();
        const existing = runtime.store.snapshot().chainEvidence.find((item) => item.chainId === 1 && item.status === 'accepted' && item.executionEnabled && item.expiresAt > now.toISOString());
        if (args.action === 'status' && existing) { process.stdout.write(`${json({ state: 'Accepted', message: `Ethereum chain evidence is accepted until ${existing.expiresAt}.`, evidenceId: existing.id, expiresAt: existing.expiresAt })}\n`); return; }
        const config = args.rpcUrl ? { rpcEndpoints: [args.rpcUrl] } : await resolveChainByNameFromSecrets('ethereum', 'mainnet', configuredSecretRoot(runtimeRoot));
        const endpoint = config.rpcEndpoints[0];
        if (!endpoint) throw new Error('ETHEREUM_RPC_UNAVAILABLE');
        const client = createPublicClient({ transport: failoverTransport(config.rpcEndpoints) });
        if ((await client.getChainId()) !== 1) throw new Error('RPC_CHAIN_MISMATCH: that RPC is not Ethereum');
        const block = await client.getBlock({ blockTag: 'latest' });
        const phrase = ethereumChainEvidencePhrase();
        if (args.action === 'status') { process.stdout.write(`${json({ state: 'NotAccepted', message: 'No accepted Ethereum chain evidence. Accepting it is your own statement, valid for 7 days, that SeaDrop v1 public mints on Ethereum have been rehearsed on a fork and read live (the rehearsal results are in the project evidence notes; this command does not re-run them).', copyThisToAccept: `chain-evidence accept --confirm "${phrase}"`, note: 'The phrase is always the same, so you can copy it at any time.' })}\n`); return; }
        if (existing) { process.stdout.write(`${json({ state: 'AlreadyAccepted', evidenceId: existing.id, expiresAt: existing.expiresAt })}\n`); return; }
        if (args.confirm !== phrase) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run chain-evidence status and copy the phrase it prints exactly');
        const record = buildEthereumChainEvidence({ now, sourceBlock: block.number, sourceBlockHash: block.hash, strategy: 'seadrop-v1-public' });
        await acceptEthereumChainEvidence(runtime.store, record, phrase);
        process.stdout.write(`${json({ state: 'Accepted', message: `Ethereum chain evidence accepted until ${record.expiresAt}.`, evidenceId: record.id })}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('record-simulation', 'Run the test mint for every wallet of a prepared live campaign and record the result (needed before a live arm)', (args) => args
    .option('campaign-id', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('rpc-url', { type: 'string' }), async (args) => {
      try {
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
        const campaign = persistedCampaign(runtime, args.campaignId);
        if (campaign.dryRun || (campaign.chainId !== 1 && campaign.chainId !== 8453 && campaign.chainId !== 4663)) throw new Error('LIVE_SUPPORTED_CAMPAIGN_REQUIRED');
        const wallets = await publicWallets(walletFile(args.walletFile));
        if (campaign.chainId === 4663) {
          // T-063: a fresh Robinhood dry run of the campaign's own quantity; every wallet that passes and can pay for gas gets a record.
          const robinhood = await robinhoodReadClient(args.rpcUrl);
          const report = await dryRunDrop(robinhood as never, campaign.contract, wallets, { quantity: campaign.quantity });
          const recorded = await recordRobinhoodSimulationsAction({ store: runtime.store, campaign, report, latestBlock: async () => { const block = await robinhood.getBlock({ blockTag: 'latest' }); return { number: block.number, hash: block.hash }; } });
          process.stdout.write(`${json({ state: 'Recorded', message: `${recorded.recorded.length} wallet(s) passed the test mint. The records are good for 30 minutes, so approve, arm and run soon.`, simulationIds: recorded.ids, wallets: recorded.recorded, ...(recorded.skipped.length > 0 ? { notRecorded: recorded.skipped } : {}) })}\n`);
          return;
        }
        const port = args.rpcUrl ? EngineIntelligencePort.fromRpcUrl(args.rpcUrl) : campaign.chainId === 8453 ? await basePort() : await ethereumPort();
        const config = args.rpcUrl ? { rpcEndpoints: [args.rpcUrl] } : await resolveChainByNameFromSecrets(campaign.chainId === 8453 ? 'base' : 'ethereum', 'mainnet', configuredSecretRoot(runtimeRoot));
        const client = createPublicClient({ transport: failoverTransport(config.rpcEndpoints) });
        const ids = await recordSimulationAction({ store: runtime.store, campaign, wallets, port, latestBlock: async () => { const block = await client.getBlock({ blockTag: 'latest' }); return { number: block.number, hash: block.hash }; } });
        process.stdout.write(`${json({ state: 'Recorded', message: `${ids.length} wallet(s) passed the test mint. The records are good for 30 minutes, so approve, arm and run soon.`, simulationIds: ids })}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('live-readiness <action>', 'Owner-run: check the machine, the RPC, Telegram, the backup and your wallet file, and record that live is ready for 15 minutes', (args) => args
    .positional('action', { type: 'string', choices: ['status', 'record'] as const, demandOption: true })
    .option('chain', { type: 'string', choices: ['ethereum', 'base'] as const, default: 'ethereum' })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('backup-status', { type: 'string', describe: 'Backup status file (default: the service default under the backup folder)' })
    .option('confirm', { type: 'string', describe: 'The confirmation phrase status printed (record only)' })
    .option('rpc-url', { type: 'string' }), async (args) => {
      try {
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { acceptPersonalLiveLocalCustody: true });
        const chainId = args.chain === 'base' ? 8453 : 1;
        const file = walletFile(args.walletFile);
        const wallets = await publicWallets(file);
        const phrase = liveReadinessPhrase(wallets.length, chainId);
        if (args.action === 'status') {
          const storedOperational = runtime.store.snapshot().runtime.operational;
          const operational = readinessMatchesChain(storedOperational, chainId) ? storedOperational : undefined;
          process.stdout.write(`${json({ state: operational ? 'Recorded' : 'NotRecorded', message: operational ? (operational.expiresAt > new Date().toISOString() ? `Readiness was recorded and is good until ${operational.expiresAt}.` : `Readiness was recorded but expired at ${operational.expiresAt}; record it again before arming.`) : 'Readiness is not recorded. Recording checks the RPC, Telegram, the backup, the kill switch and your wallet file, then records the result for 15 minutes.', wallets, copyThisToRecord: `live-readiness record --chain ${args.chain} --confirm "${phrase}"` })}\n`);
          return;
        }
        if (turnkeyCustodyEnabled()) throw new Error('TURNKEY_CUSTODY_ACTIVE: this record is for a local wallet file; with Turnkey in use, live needs the Turnkey custody proof instead');
        if (args.confirm !== phrase) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run live-readiness status and copy the phrase it prints exactly');
        const config = args.rpcUrl ? { rpcEndpoints: [args.rpcUrl] } : await resolveChainByNameFromSecrets(args.chain, 'mainnet', configuredSecretRoot(runtimeRoot));
        const endpoint = config.rpcEndpoints[0];
        if (!endpoint) throw new Error(`${args.chain.toUpperCase()}_RPC_UNAVAILABLE`);
        const client = createPublicClient({ transport: failoverTransport(config.rpcEndpoints) });
        const secretStorePath = process.env.SECRET_STORE_PATH ?? join(configuredSecretRoot(runtimeRoot), 'MINT_BOT_SECRETS.env');
        const probes = createPersonalLiveProbes({
          client,
          walletFile: file,
          backupStatusPath: args.backupStatus ?? process.env.MINT_BOT_BACKUP_STATUS_PATH ?? join(process.env.MINT_BOT_BACKUP_DIR ?? join(runtimeRoot, 'Rets', 'state', 'backups'), 'status.json'),
          killSwitchFile: DEFAULT_KILL_FILE,
          killSwitchStoredFlag: () => runtime.store.snapshot().killed,
          // A valid bot token is not enough: a short test message must actually be delivered to the owner (D-043).
          telegramHealthy: async () => {
            try {
              const notifier = new TelegramNotifier({ secretStore: await loadHostSecretStore(secretStorePath) });
              if ((await notifier.health()).status !== 'ok') return false;
              await notifier.send({ eventId: `live-readiness-${Date.now()}`, type: 'live_readiness_check', text: plainSystemText(telegramTestCard()), system: telegramTestCard() });
              return true;
            } catch { return false; }
          },
        });
        const outcome = await new PersonalLiveReadinessService(runtime.store, probes).record({ wallets, confirmedBy: 'owner-cli', storePath: process.env.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite', secretStoreReference: 'SECRET_STORE_PATH', chainId });
        process.stdout.write(`${json(outcome.recorded ? { state: 'Recorded', message: `Live readiness recorded. It is good until ${outcome.expiresAt}; approve, arm and run before then, or record it again.`, expiresAt: outcome.expiresAt } : { state: 'NotReady', message: `${outcome.failures.length} check(s) failed, so nothing was recorded.`, failures: outcome.failures })}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('live-plan','Read-only: is a FREE Ethereum, Base or Robinhood mint ready to go live? Shows the money at risk, what blocks it, and the next steps', (args) => args
    .option('chain', { type: 'string', choices: ['ethereum', 'base', 'robinhood'] as const, default: 'ethereum' })
    .option('contract', { type: 'string', demandOption: true })
    .option('wallets', { type: 'string', describe: 'Comma-separated public addresses (default: MINT_BOT_READINESS_WALLETS; for Robinhood, the Turnkey wallets)' })
    .option('quantity-limit', { type: 'number', describe: 'Maximum NFTs per wallet; the fee planner may reduce it further (Robinhood: the exact quantity your Turnkey policy pins, default 1)' })
    .option('rpc-url', { type: 'string', describe: 'Override the chain RPC (https only)' }), async (args) => {
      try {
        if (args.chain === 'robinhood') {
          // T-063: Robinhood has no fee planner; the quantity is the one the Turnkey policy pins.
          const robinhoodWallets = args.wallets ? checkWallets(args.wallets) : await publicWallets(walletFile(undefined));
          const quantity = args.quantityLimit ?? 1;
          const report = await dryRunDrop((await robinhoodReadClient(args.rpcUrl)) as never, args.contract, robinhoodWallets, { quantity });
          const plan = buildRobinhoodPlan(report, { candidates: robinhoodWallets, killSwitchPresent: existsSync(DEFAULT_KILL_FILE), quantity });
          process.stdout.write(`${json({ ...plan, ...(plan.verdict === 'ready' ? { confirmationPhrase: robinhoodConfirmationPhrase(args.contract, plan.quantity, plan.walletsReady.length, plan.totalMaxExposureEth) } : {}) })}\n`);
          return;
        }
        const wallets = checkWallets(args.wallets);
        const chainId = args.chain === 'base' ? 8453 : 1;
        const port = args.rpcUrl ? EngineIntelligencePort.fromRpcUrl(args.rpcUrl) : chainId === 8453 ? await basePort() : await ethereumPort();
        const planned = await livePlanAction({ chainId, contract: args.contract, wallets, ...(args.quantityLimit === undefined ? {} : { quantityLimit: args.quantityLimit }), port, killFile: DEFAULT_KILL_FILE, custody: turnkeyCustodyEnabled() ? 'turnkey' : 'local' });
        process.stdout.write(`${json({ ...planned.plan, ...(planned.phrase ? { confirmationPhrase: planned.phrase, planningMaxFeeGwei: planned.planningMaxFeeGwei } : {}) })}\n`);
      } catch (error) { process.stdout.write(`${blocked(new Error(surveyErrorMessage(error)))}\n`); }
    })
  .command('live-prepare', 'Record a live FREE Ethereum, Base or Robinhood campaign from a ready live-plan. Spends nothing; approve, arm and run are still separate steps', (args) => args
    .option('chain', { type: 'string', choices: ['ethereum', 'base', 'robinhood'] as const, default: 'ethereum' })
    .option('contract', { type: 'string', demandOption: true })
    .option('wallets', { type: 'string', describe: 'Comma-separated public addresses (default: MINT_BOT_READINESS_WALLETS; for Robinhood, the Turnkey wallets)' })
    .option('quantity-limit', { type: 'number', describe: 'Maximum NFTs per wallet; use the same value passed to live-plan' })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('priority-fee-gwei', { type: 'number', default: 0.1, describe: 'Tip per gas (more than 0, at most 2)' })
    .option('confirm', { type: 'string', demandOption: true, describe: 'The confirmation phrase live-plan printed' })
    .option('rpc-url', { type: 'string' }), async (args) => {
      try {
        if (args.chain === 'robinhood') {
          const robinhoodWallets = args.wallets ? checkWallets(args.wallets) : await publicWallets(walletFile(args.walletFile));
          const quantity = args.quantityLimit ?? 1;
          const report = await dryRunDrop((await robinhoodReadClient(args.rpcUrl)) as never, args.contract, robinhoodWallets, { quantity });
          const plan = buildRobinhoodPlan(report, { candidates: robinhoodWallets, killSwitchPresent: existsSync(DEFAULT_KILL_FILE), quantity });
          const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, { walletFile: walletFile(args.walletFile) }, { startCoordinator: false });
          const prepared = await robinhoodPrepareAction({ contract: args.contract, priorityFeeGwei: args.priorityFeeGwei, confirm: args.confirm, plan, killFile: DEFAULT_KILL_FILE, store: runtime.store as never, createCampaign: (input) => runtime.application.createCampaign(input), now: new Date() });
          process.stdout.write(`${json({ state: 'Prepared', campaignId: prepared.campaign.id, quantity: prepared.quantity, walletsSizedFor: prepared.walletsSized, maxExposureEth: prepared.maxExposureEth, nextSteps: [`record-simulation --campaign-id ${prepared.campaign.id} (while the mint is open)`, `live-request status --campaign-id ${prepared.campaign.id} --wallets <addresses> --max-fee-gwei <at or below your Turnkey policy limit>`] })}\n`);
          return;
        }
        const chainId = args.chain === 'base' ? 8453 : 1;
        const wallets = checkWallets(args.wallets);
        const port = args.rpcUrl ? EngineIntelligencePort.fromRpcUrl(args.rpcUrl) : chainId === 8453 ? await basePort() : await ethereumPort();
        const planned = await livePlanAction({ chainId, contract: args.contract, wallets, ...(args.quantityLimit === undefined ? {} : { quantityLimit: args.quantityLimit }), port, killFile: DEFAULT_KILL_FILE, custody: turnkeyCustodyEnabled() ? 'turnkey' : 'local' });
        const file = walletFile(args.walletFile);
        const walletFileAddresses = await publicWallets(file);
        const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, { walletFile: file }, { startCoordinator: false });
        const prepared = await livePrepareAction({ chainId, contract: args.contract, priorityFeeGwei: args.priorityFeeGwei, confirm: args.confirm, planned, killFile: DEFAULT_KILL_FILE, walletFileAddresses, store: runtime.store as unknown as PrepareStore, createCampaign: (input) => runtime.application.createCampaign(input), newId: () => `evt_${randomBytes(8).toString('hex')}`, now: new Date() });
        const campaign = prepared.campaign;
        process.stdout.write(`${json({ state: 'Prepared', campaignId: campaign.id, wallets: prepared.wallets, quantity: prepared.quantity, maxExposureEth: prepared.maxExposureEth, planningMaxFeeGwei: prepared.planningMaxFeeGwei, nextSteps: [`approve --campaign-id ${campaign.id}`, `arm --campaign-id ${campaign.id} --mode live`, 'remove the kill-switch file only when you are ready', 'live-run --run-id <the run id arm prints> --max-fee-gwei <the planning max fee above>'] })}\n`);
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
        const client = createPublicClient({ chain, transport: failoverTransport(config.rpcEndpoints, { timeoutMs: 20_000 }) });
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
    const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { acceptPersonalLiveLocalCustody: true });
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
    try {
      const file = walletFile(args.walletFile);
      // `arm` already completed startup reconciliation before persisting this run. Starting a new
      // coordinator here would classify that intentionally Armed run as unresolved and block the
      // only command that can execute it.
      const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, { walletFile: file, ...(args.maxFeeGwei === undefined ? {} : { maxFeePerGasGwei: args.maxFeeGwei }) }, { acceptPersonalLiveLocalCustody: true, startCoordinator: false });
      const wallets = await publicWallets(file);
      const selected = runtime.store.snapshot().runs.find((candidate) => candidate.id === args.runId);
      if (selected?.mode === 'live') throw new Error('LIVE_RUN_GUIDED_COMMAND_REQUIRED');
      const response = await runtime.application.command('run', { runId: args.runId, wallets, ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}) });
      process.stdout.write(`${json(response)}\n`);
    } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('live-run', 'Guided live run: shows exactly what is at stake, asks for a second typed confirmation, runs, then explains the result in plain words', (args) => args
    .option('run-id', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE })
    .option('max-fee-gwei', { type: 'number', describe: 'The planning fee live-plan printed (or lower)' })
    .option('confirm', { type: 'string', describe: 'The confirmation phrase this command printed' }), async (args) => {
      try {
        const preview = previewLiveRun((await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false })).store.snapshot(), args.runId);
        if (args.confirm === undefined) {
          process.stdout.write(`${json({ state: 'ReadyToRun', message: `This run will send real mints from ${preview.wallets.length} wallet(s), ${preview.quantityPerWallet} NFT(s) each. The most that can be spent is ${preview.maxExposureEth} ETH. ${preview.quantityNote ?? ''}`.trim(), ...preview, copyThisToRun: `live-run --run-id ${args.runId} --max-fee-gwei ${preview.planningMaxFeeGwei ?? '<planning fee>'} --confirm "${preview.phrase}"` })}\n`);
          return;
        }
        assertLiveRunAllowed({ preview, confirm: args.confirm, maxFeeGwei: args.maxFeeGwei });
        const file = walletFile(args.walletFile);
        const executeConfirmedRun = async (localSigner?: Signer): Promise<void> => {
          let signer = localSigner;
          const signerFactory: SignerFactory | undefined = signer ? async () => {
            if (!signer) throw new Error('PREAUTHENTICATED_SIGNER_ALREADY_CONSUMED');
            const transferred = signer;
            signer = undefined;
            return transferred;
          } : undefined;
          // Preserve the Ready startup state established by `arm`; restarting the coordinator would
          // see this persisted Armed run as unresolved and prevent its own execution. For local custody,
          // decrypt and authenticate the local keystore before admission can move the run to Active.
          // Ownership transfers exactly once to MintEngine; otherwise this scope zeroizes it.
          try {
            const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, { walletFile: file, maxFeePerGasGwei: args.maxFeeGwei as number, ...(signerFactory ? { signerFactory, passphraseProvider: async () => '' } : {}) }, { acceptPersonalLiveLocalCustody: true, startCoordinator: false });
            // Copy the plan onto the run so the summary command shows it too.
            const wallets = await publicWallets(file);
            assertWalletFileMatchesRun(preview, wallets);
            const plan = quantityPlanForRun(runtime.store.snapshot().events, args.runId, preview.campaignId);
            if (plan) await runtime.store.transaction((state) => { state.events.push({ id: `evt_${randomBytes(8).toString('hex')}`, runId: args.runId, type: 'quantity_plan', at: new Date().toISOString(), data: { ...plan, campaignId: preview.campaignId } }); });
            let runResponse: unknown;
            let runError: string | undefined;
            try { runResponse = await runtime.application.command('run', { runId: args.runId, wallets }); } catch (error) { runError = plainFeePolicyMessage(commandErrorMessage(error, 'LIVE_RUN_FAILED')); }
            const report = describeLiveRunResult(runtime.store.snapshot(), args.runId);
            process.stdout.write(`${json({ state: runError === undefined ? 'RunFinished' : 'RunStopped', ...(runError === undefined ? {} : { stoppedBecause: runError }), message: report.summary, report, run: runResponse ?? null })}\n`);
          } finally { signer?.zeroize(); }
        };
        if (turnkeyCustodyEnabled()) await executeConfirmedRun();
        else await withHiddenPassphrase(async (passphrase) => {
          const signer = await LocalEncryptedSigner.fromFile(file, passphrase);
          try {
            const signerWallets = (await signer.listWallets()).map((wallet) => wallet.address);
            assertWalletFileMatchesRun(preview, signerWallets);
            await executeConfirmedRun(signer);
          } finally { signer.zeroize(); }
        });
      } catch (error) { process.stdout.write(`${blocked(new Error(plainFeePolicyMessage(surveyErrorMessage(error))))}\n`); }
    })
  .command('execute', 'Compatibility alias for run', (args) => args
    .option('run-id', { type: 'string', demandOption: true })
    .option('wallet-file', { type: 'string', default: DEFAULT_WALLET_FILE }), async (args) => {
    const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { acceptPersonalLiveLocalCustody: true, startCoordinator: false });
    try {
      const wallets = await publicWallets(walletFile(args.walletFile));
      const selected = runtime.store.snapshot().runs.find((candidate) => candidate.id === args.runId);
      if (selected?.mode === 'live') throw new Error('LIVE_RUN_GUIDED_COMMAND_REQUIRED');
      const response = await runtime.application.command('execute', { runId: args.runId, wallets });
      process.stdout.write(`${json(response)}\n`);
    } catch (error) { process.stdout.write(`${blocked(error)}\n`); }
  })
  .command('summary', 'Read canonical run and accounting facts', (args) => args
    .option('run-id', { type: 'string' }), async (args) => {
    const runtime = await createCliRuntime(runtimeRoot, undefined, undefined, undefined, { startCoordinator: false });
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
