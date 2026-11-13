import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AlertManager, BackendApplication, CanonicalStoreBridge, ExecutionCoordinator, PERSONAL_LIVE_FLEET_POLICY, loadHostSecretStore, resolveWalletPath, type BackendStore, type EngineAdapter } from '@mint-bot/backend';
import { openDatabase } from '@mint-bot/database';
import { buildSeaDropPublicMintCalldata, getStrategy, readTurnkeyApprovedPolicyRecords, readTurnkeySecretConfig, resolveChainConfigFromSecrets, resolveSeaDropFeeRecipient, SEADROP_V1_ADDRESS, turnkeyPolicySelection, TurnkeySigner, type TurnkeyCanonicalPolicyRecord, type TurnkeyPolicySelection, type WalletInfo } from '@mint-bot/engine';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { createCanonicalLifecycleStore, createMintEngineAdapter, type MintEngineAdapterOptions } from './engine-adapter.js';
import type { CoordinatorAssuranceWiring } from './turnkey-readiness-service.js';
import { configuredFireLanes } from './fire-lane-config.js';
import { installAllowlistSources } from './allowlist-source-config.js';
import { installSignedMintSources } from './signed-mint-source-config.js';

/** Where spend-limit alerts go. The default records a durable alert event; the service swaps in its Telegram-backed manager. */
export interface SpendAlertSink {
  cap(reason: string, runId?: string): Promise<void>;
  confirmed?(runId: string, facts: { chainId: number; collection: string; wallet?: string; quantity?: number; hash: string; feePaid?: string }): Promise<void>;
  mintFailed?(runId: string, facts: { chainId: number; collection: string; wallet?: string; quantity?: number; hash: string; feePaid?: string }, reason?: string): Promise<void>;
}

export interface CliRuntime {
  store: BackendStore;
  coordinator: ExecutionCoordinator;
  application: BackendApplication;
  /** Shared campaign custody resolver used by host-side Telegram and scheduler applications. */
  custodyPolicyFor?: (input: import('@mint-bot/backend').CampaignInput) => Promise<import('@mint-bot/engine').TurnkeyPolicySelection & { provider: 'turnkey' } | undefined>;
  walletRoot: string;
  setAlertSink(sink: SpendAlertSink): void;
  /** T-058: the fee ceiling for one campaign's run, set by the service from a live request; undefined clears it. */
  setFeeCeiling(campaignId: string, gwei: number | undefined): void;
}

export type CustodyMode = 'local' | 'turnkey';

export function configuredSecretRoot(projectRoot: string): string {
  return resolve(process.env.MINT_BOT_SECRET_ROOT ?? resolve(projectRoot, 'Rets'));
}

/** Local encrypted wallets may live in the workspace wallet directory or under the configured external secret root. */
export function configuredWalletPath(projectRoot: string, requestedPath?: string): string {
  const externalWalletRoot = join(configuredSecretRoot(projectRoot), 'wallets');
  const requested = requestedPath ?? join(externalWalletRoot, 'wallets.json');
  return resolveWalletPath(projectRoot, requested, [externalWalletRoot]);
}

export function configuredCustodyMode(): CustodyMode {
  const mode = process.env.MINT_BOT_CUSTODY ?? 'local';
  if (mode !== 'local' && mode !== 'turnkey') throw new Error('MINT_BOT_CUSTODY_INVALID');
  return mode;
}

export function turnkeyCustodyEnabled(): boolean {
  return configuredCustodyMode() === 'turnkey';
}

export async function configuredWallets(projectRoot: string, localWalletFile: string): Promise<WalletInfo[]> {
  if (!turnkeyCustodyEnabled()) {
    const parsed = JSON.parse(await readFile(localWalletFile, 'utf8')) as { wallets?: Array<{ index?: number; address?: string }> };
    if (!Array.isArray(parsed.wallets)) throw new Error('WALLET_FILE_EMPTY');
    return parsed.wallets.map((wallet, index) => {
      if (!Number.isSafeInteger(wallet.index) || !wallet.address || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) throw new Error('WALLET_FILE_PUBLIC_SCHEMA_INVALID');
      return { index: wallet.index ?? index, address: wallet.address as Address };
    });
  }
  const signer = await TurnkeySigner.fromSecrets('mainnet', configuredSecretRoot(projectRoot));
  try {
    return await signer.listWallets();
  } finally {
    signer.zeroize();
  }
}

/** The owner's CLI may accept a recorded local key file (D-043) only when it was asked to and Turnkey custody is not in use. */
export function personalLiveLocalCustodyAllowed(requested: boolean | undefined, useTurnkey: boolean): boolean {
  return requested === true && !useTurnkey;
}

/**
 * Select the owner-approved bounded Robinhood family record without creating a
 * provider policy or resolving a contract-specific fee recipient. The family
 * deliberately leaves those calldata fields to the local transaction checks.
 */
export function selectTurnkeyRobinhoodFamilyPolicy(
  records: readonly TurnkeyCanonicalPolicyRecord[],
  input: Pick<import('@mint-bot/backend').CampaignInput, 'chainId' | 'quantity' | 'mintPriceWei' | 'strategy'>,
): TurnkeyPolicySelection | undefined {
  if (input.chainId !== 4663 || input.strategy !== 'seadrop-v1-public' || (input.mintPriceWei ?? 0n) !== 0n || !Number.isSafeInteger(input.quantity) || input.quantity < 1) return undefined;
  const matches = records.filter((record) => {
    const policy = record.enforcementPolicy;
    return policy.family?.kind === 'robinhood-seadrop-public-v1'
      && policy.family.maxQuantity >= input.quantity
      && policy.transaction.chainId === 4663
      && policy.transaction.to.toLowerCase() === SEADROP_V1_ADDRESS.toLowerCase()
      && policy.transaction.valueWei === '0'
      && policy.transaction.data === '0x161ac21f';
  });
  if (matches.length > 1) throw new Error('TURNKEY_POLICY_FAMILY_AMBIGUOUS');
  return matches.length === 1 ? turnkeyPolicySelection(matches[0]!) : undefined;
}

/** Select an approved public family on the exact free chain/fleet; reject ambiguous grants. */
export function selectTurnkeyPublicFamilyPolicy(records: readonly TurnkeyCanonicalPolicyRecord[], input: Pick<import('@mint-bot/backend').CampaignInput, 'chainId' | 'quantity' | 'mintPriceWei' | 'strategy' | 'walletScope'>): TurnkeyPolicySelection | undefined {
  if (input.strategy !== 'seadrop-v1-public' || input.mintPriceWei !== 0n || !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.walletScope?.length === 0) return undefined;
  const matches = records.filter(({ enforcementPolicy: policy }) =>
    (policy.family?.kind === 'seadrop-free-public-v1' || policy.family?.kind === 'robinhood-seadrop-public-v1' && input.chainId === 4663)
    && policy.family.maxQuantity >= input.quantity && policy.transaction.chainId === input.chainId
    && policy.transaction.to.toLowerCase() === SEADROP_V1_ADDRESS.toLowerCase()
    && policy.transaction.valueWei === '0' && policy.transaction.data === '0x161ac21f'
    && (!input.walletScope || input.walletScope.every((wallet) => policy.transaction.from.some((address) => address.toLowerCase() === wallet.toLowerCase()))));
  if (matches.length > 1) throw new Error('TURNKEY_POLICY_FAMILY_AMBIGUOUS');
  return matches.length === 1 ? turnkeyPolicySelection(matches[0]!) : undefined;
}

/** Select only an owner-signed free allowlist family on the exact chain and wallet scope. */
export function selectTurnkeyAllowlistFamilyPolicy(records: readonly TurnkeyCanonicalPolicyRecord[], input: Pick<import('@mint-bot/backend').CampaignInput, 'chainId' | 'quantity' | 'mintPriceWei' | 'strategy' | 'walletScope'>): TurnkeyPolicySelection | undefined {
  if (input.strategy !== 'seadrop-v1-allowlist' || input.mintPriceWei !== 0n || !Number.isSafeInteger(input.quantity) || input.quantity < 1) return undefined;
  const matches = records.filter(({ enforcementPolicy: policy }) => policy.family?.kind === 'seadrop-free-allowlist-v1' && policy.family.maxQuantity >= input.quantity && policy.transaction.chainId === input.chainId && policy.transaction.to.toLowerCase() === SEADROP_V1_ADDRESS.toLowerCase() && policy.transaction.valueWei === '0' && policy.transaction.data === '0x4300a4e6' && (!input.walletScope || input.walletScope.every((wallet) => policy.transaction.from.some((address) => address.toLowerCase() === wallet.toLowerCase()))));
  if (matches.length > 1) throw new Error('TURNKEY_POLICY_FAMILY_AMBIGUOUS');
  return matches.length === 1 ? turnkeyPolicySelection(matches[0]!) : undefined;
}

/** Signed selectors never inherit public or Merkle-family custody authority. */
export function selectTurnkeySignedFamilyPolicy(records: readonly TurnkeyCanonicalPolicyRecord[], input: Pick<import('@mint-bot/backend').CampaignInput, 'chainId' | 'quantity' | 'mintPriceWei' | 'strategy' | 'walletScope'>): TurnkeyPolicySelection | undefined {
  if (input.strategy !== 'seadrop-v1-signed' || ![1, 8453, 4663].includes(input.chainId) || input.mintPriceWei !== 0n || !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > (input.chainId === 8453 ? 4 : 10) || !input.walletScope?.length || input.walletScope.some(wallet => !/^0x[0-9a-fA-F]{40}$/.test(wallet)) || new Set(input.walletScope.map(wallet => wallet.toLowerCase())).size !== input.walletScope.length) return undefined;
  const matches = records.filter(({ enforcementPolicy: policy }) => policy.family?.kind === 'seadrop-free-signed-v1'
    && policy.family.maxQuantity >= input.quantity && policy.transaction.chainId === input.chainId
    && policy.transaction.to.toLowerCase() === SEADROP_V1_ADDRESS.toLowerCase()
    && policy.transaction.valueWei === '0' && policy.transaction.data === '0x4b61cd6f'
    && input.walletScope!.every(wallet => policy.transaction.from.some(address => address.toLowerCase() === wallet.toLowerCase())));
  if (matches.length > 1) throw new Error('TURNKEY_POLICY_FAMILY_AMBIGUOUS');
  return matches.length === 1 ? turnkeyPolicySelection(matches[0]!) : undefined;
}

export async function createCliRuntime(projectRoot: string, engine?: EngineAdapter, statePath = process.env.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite', adapterOptions?: Partial<Omit<MintEngineAdapterOptions, 'getState'>>, runtimeOptions: { allowTurnkey?: boolean; startCoordinator?: boolean; acceptPersonalLiveLocalCustody?: boolean; /** Host service only (D-058/D-059): builds the compensated-profile wiring once the store is open. The owner's CLI never passes it. */ coordinatorAssurance?: (store: CanonicalStoreBridge) => Promise<CoordinatorAssuranceWiring> } = {}): Promise<CliRuntime> {
  const useTurnkey = runtimeOptions.allowTurnkey ?? turnkeyCustodyEnabled();
  const store = new CanonicalStoreBridge(openDatabase(resolve(projectRoot, statePath)), { durable: true, fleetPolicy: PERSONAL_LIVE_FLEET_POLICY, ...(useTurnkey ? { walletKeyReferencePrefix: 'turnkey-wallet-map' } : {}) });
  await store.open();
  const lifecycleStore = createCanonicalLifecycleStore(store);
  const secretRoot = configuredSecretRoot(projectRoot);
  if (process.env.MINT_BOT_ALLOWLIST_SOURCES_PATH || process.env.SECRET_STORE_PATH) {
    await installAllowlistSources({ path: process.env.MINT_BOT_ALLOWLIST_SOURCES_PATH, secretRoot,
      wallets: async () => (await configuredWallets(projectRoot, configuredWalletPath(projectRoot))).map((wallet) => wallet.address),
      credential: async (name) => process.env.SECRET_STORE_PATH ? (await loadHostSecretStore(process.env.SECRET_STORE_PATH)).get(name) : undefined,
    });
  }
  await installSignedMintSources({ secretRoot,
    wallets: async () => (await configuredWallets(projectRoot, configuredWalletPath(projectRoot))).map(wallet => wallet.address),
    credential: async name => process.env.SECRET_STORE_PATH ? (await loadHostSecretStore(process.env.SECRET_STORE_PATH)).get(name) : undefined,
    maxQuantity: Number(process.env.MINT_BOT_REPLICATION_MAX_QUANTITY ?? '1'),
  });
  const turnkeyConfig = useTurnkey ? await readTurnkeySecretConfig(secretRoot) : undefined;
  let turnkeyPolicyReference: string | undefined;
  if (turnkeyConfig) {
    const signer = await TurnkeySigner.fromSecrets('mainnet', secretRoot);
    try { turnkeyPolicyReference = signer.policyReference(); } finally { signer.zeroize(); }
  }
  const turnkeyOptions: Partial<Omit<MintEngineAdapterOptions, 'getState'>> = turnkeyConfig && turnkeyPolicyReference ? {
    walletFile: resolve(projectRoot, 'Rets', 'wallets', 'turnkey-wallet-map.json'),
    walletList: () => configuredWallets(projectRoot, resolveWalletPath(projectRoot)),
    signerFactory: () => TurnkeySigner.fromSecrets('mainnet', secretRoot),
    signerFactoryFor: (policyReference, recordDigest) => () => TurnkeySigner.fromSecrets('mainnet', secretRoot, policyReference, recordDigest),
    passphraseProvider: async () => '',
    policyRef: turnkeyPolicyReference,
  } : {};
  const custodyPolicyFor = turnkeyConfig ? async (input: import('@mint-bot/backend').CampaignInput) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.contract)) throw new Error('TURNKEY_POLICY_SELECTION_NOT_FOUND');
    const records = await readTurnkeyApprovedPolicyRecords('mainnet', secretRoot);
    if (input.strategy === 'seadrop-v1-signed') {
      const walletScope = input.walletScope ?? (await configuredWallets(projectRoot, configuredWalletPath(projectRoot))).map(wallet => wallet.address);
      const signedFamily = selectTurnkeySignedFamilyPolicy(records, { ...input, walletScope });
      if (!signedFamily) throw new Error('TURNKEY_SIGNED_FAMILY_APPROVAL_REQUIRED');
      return { provider: 'turnkey' as const, ...signedFamily };
    }

    // The bounded family is the fast path: `/prepare` binds the campaign to
    // one already-approved record and the signer performs the exact contract
    // and fee-recipient checks from the live drop at signing time.
    const family = selectTurnkeyAllowlistFamilyPolicy(records, input) ?? selectTurnkeyPublicFamilyPolicy(records, input);
    if (family) return { provider: 'turnkey' as const, ...family };
    const chain = await resolveChainConfigFromSecrets(input.chainId as 1 | 8453 | 4663, 'mainnet', secretRoot);
    if (!chain.rpcEndpoints[0]) throw new Error('TURNKEY_POLICY_FEE_RECIPIENT_RPC_REQUIRED');
    const client = createPublicClient({ transport: http(chain.rpcEndpoints[0]) });
    let candidates: Hex[];
    if (input.strategy === 'seadrop-v1-allowlist') {
      const strategy = getStrategy(input.strategy);
      const drop = await strategy.readDrop(client, input.contract as Address, input.chainId as 1 | 8453 | 4663);
      const own = (await configuredWallets(projectRoot, configuredWalletPath(projectRoot))).filter((wallet) => !input.walletScope || input.walletScope.some((address) => address.toLowerCase() === wallet.address.toLowerCase()));
      candidates = own.flatMap((wallet) => { try { return [strategy.buildCalldata(drop, wallet.address, input.quantity)]; } catch { return []; } });
    } else {
      const feeRecipient = await resolveSeaDropFeeRecipient(client, input.contract as Address);
      candidates = [buildSeaDropPublicMintCalldata(input.contract as Address, feeRecipient, input.quantity)];
    }
    const matches = records.filter((record) => {
      const tx = record.enforcementPolicy.transaction;
      return tx.chainId === input.chainId
        && tx.to.toLowerCase() === SEADROP_V1_ADDRESS.toLowerCase()
        && tx.valueWei === String((input.mintPriceWei ?? 0n) * BigInt(input.quantity))
        && candidates.includes(tx.data);
    });
    if (matches.length !== 1) throw new Error(matches.length === 0 ? 'TURNKEY_POLICY_SELECTION_NOT_FOUND' : 'TURNKEY_POLICY_SELECTION_AMBIGUOUS');
    return { provider: 'turnkey' as const, ...turnkeyPolicySelection(matches[0]!) };
  } : undefined;
  const configuredAdapterOptions = turnkeyConfig
    ? { ...adapterOptions, ...turnkeyOptions }
    : { ...turnkeyOptions, ...adapterOptions };
  const feeCeilings = new Map<string, number>();
  const actualEngine = engine ?? createMintEngineAdapter({
    walletFile: configuredWalletPath(projectRoot),
    killSwitchFile: resolve(projectRoot, 'Rets', 'state', 'killswitch'),
    secretRoot,
    logFile: resolve(projectRoot, 'Rets', 'state', 'mint-bot.log'),
    maxFeePerGasGwei: 100,
    gasLimitPadding: 1.2,
    maxReplacementBumps: 0,
    ...configuredAdapterOptions,
    fireLanesFor: configuredAdapterOptions.fireLanesFor ?? configuredFireLanes(process.env.MINT_BOT_FIRE_LANES),
    maxFeePerGasGweiFor: (campaignId) => feeCeilings.get(campaignId),
    getState: () => store.snapshot(),
    transact: (mutate) => store.transaction(mutate),
    lifecycleStore: adapterOptions?.lifecycleStore ?? lifecycleStore,
    settleComponents: adapterOptions?.settleComponents ?? ((reservationId, components) => store.settleExecutionComponents(reservationId, components)),
    // Robinhood grant source (D-050): the stored owner record only. Placed after the spread above so no caller option can replace it.
    robinhoodEnablement: () => (store as { robinhoodEnablement?: () => unknown }).robinhoodEnablement?.(),
    baseEnablement: () => (store as { baseEnablement?: () => unknown }).baseEnablement?.(),
  });
  let alertSink: SpendAlertSink = new AlertManager(store);
  // The owner's CLI may accept a recorded local key file for Personal Live (D-043); the service never passes this, so unattended runs still need Turnkey or a cloud key service.
  const assuranceWiring = runtimeOptions.coordinatorAssurance ? await runtimeOptions.coordinatorAssurance(store) : undefined;
  const coordinator = new ExecutionCoordinator(store, actualEngine, { alerts: {
    cap: (reason, runId) => alertSink.cap(reason, runId),
    confirmed: (runId, facts) => alertSink.confirmed?.(runId, facts) ?? Promise.resolve(),
    mintFailed: (runId, facts, reason) => alertSink.mintFailed?.(runId, facts, reason) ?? Promise.resolve(),
  }, ...(assuranceWiring ? { expectedCustodyPolicy: assuranceWiring.expectedCustodyPolicy, compensatingAssurance: assuranceWiring.compensatingAssurance, refreshReadiness: assuranceWiring.refreshReadiness, walletWatch: assuranceWiring.walletWatch } : {}), ...(personalLiveLocalCustodyAllowed(runtimeOptions.acceptPersonalLiveLocalCustody, useTurnkey) ? { acceptPersonalLiveLocalCustody: true } : {}) });
  if (runtimeOptions.startCoordinator !== false) await coordinator.start();
  return { store, coordinator, application: new BackendApplication(store, coordinator, { phase2ReadOnly: process.env.MINT_BOT_PHASE2_READ_ONLY === 'true', fleetPolicy: PERSONAL_LIVE_FLEET_POLICY, ...(custodyPolicyFor ? { custodyPolicyFor } : {}) }), ...(custodyPolicyFor ? { custodyPolicyFor } : {}), walletRoot: join(configuredSecretRoot(projectRoot), 'wallets'), setAlertSink: (sink) => { alertSink = sink; }, setFeeCeiling: (campaignId, gwei) => { if (gwei === undefined) feeCeilings.delete(campaignId); else feeCeilings.set(campaignId, gwei); } };
}
