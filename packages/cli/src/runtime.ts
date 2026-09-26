import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BackendApplication, CanonicalStoreBridge, ExecutionCoordinator, resolveWalletPath, type BackendStore, type EngineAdapter } from '@mint-bot/backend';
import { openDatabase } from '@mint-bot/database';
import { readTurnkeySecretConfig, readTurnkeyWalletMap, turnkeyPolicyRef, TurnkeySigner, type WalletInfo } from '@mint-bot/engine';
import type { Address } from 'viem';
import { createCanonicalLifecycleStore, createMintEngineAdapter, type MintEngineAdapterOptions } from './engine-adapter.js';

export interface CliRuntime { store: BackendStore; coordinator: ExecutionCoordinator; application: BackendApplication; walletRoot: string; }

export type CustodyMode = 'local' | 'turnkey';

export function configuredSecretRoot(projectRoot: string): string {
  return resolve(process.env.MINT_BOT_SECRET_ROOT ?? resolve(projectRoot, 'Rets'));
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

export async function createCliRuntime(projectRoot: string, engine?: EngineAdapter, statePath = process.env.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite', adapterOptions?: Partial<Omit<MintEngineAdapterOptions, 'getState'>>, runtimeOptions: { allowTurnkey?: boolean; startCoordinator?: boolean } = {}): Promise<CliRuntime> {
  const store = new CanonicalStoreBridge(openDatabase(resolve(projectRoot, statePath)), { durable: true, ...(turnkeyCustodyEnabled() ? { walletKeyReferencePrefix: 'turnkey-wallet-map' } : {}) });
  await store.open();
  const lifecycleStore = createCanonicalLifecycleStore(store);
  const secretRoot = configuredSecretRoot(projectRoot);
  const custodyEnabled = runtimeOptions.allowTurnkey !== false && turnkeyCustodyEnabled();
  const turnkeyConfig = custodyEnabled ? await readTurnkeySecretConfig(secretRoot) : undefined;
  const turnkeyMap = turnkeyConfig ? await readTurnkeyWalletMap(turnkeyConfig.walletMapPath) : undefined;
  if (turnkeyConfig && !turnkeyMap?.policyId) throw new Error('TURNKEY_POLICY_REQUIRED');
  const turnkeyOptions: Partial<Omit<MintEngineAdapterOptions, 'getState'>> = turnkeyConfig && turnkeyMap ? {
    walletFile: resolve(projectRoot, 'Rets', 'wallets', 'turnkey-wallet-map.json'),
    walletList: () => configuredWallets(projectRoot, resolveWalletPath(projectRoot)),
    signerFactory: () => TurnkeySigner.fromSecrets('mainnet', secretRoot),
    passphraseProvider: async () => '',
     policyRef: turnkeyPolicyRef(turnkeyMap.policyId, turnkeyMap.policyDigest),
  } : {};
  const configuredAdapterOptions = turnkeyConfig
    ? { ...adapterOptions, ...turnkeyOptions }
    : { ...turnkeyOptions, ...adapterOptions };
  const actualEngine = engine ?? createMintEngineAdapter({
    walletFile: resolveWalletPath(projectRoot),
    killSwitchFile: resolve(projectRoot, 'Rets', 'state', 'killswitch'),
    secretRoot,
    logFile: resolve(projectRoot, 'Rets', 'state', 'mint-bot.log'),
    maxFeePerGasGwei: 100,
    gasLimitPadding: 1.2,
    maxReplacementBumps: 0,
    ...configuredAdapterOptions,
    getState: () => store.snapshot(),
    transact: (mutate) => store.transaction(mutate),
    lifecycleStore: adapterOptions?.lifecycleStore ?? lifecycleStore,
    settleComponents: adapterOptions?.settleComponents ?? ((reservationId, components) => store.settleExecutionComponents(reservationId, components)),
  });
  const coordinator = new ExecutionCoordinator(store, actualEngine);
  if (runtimeOptions.startCoordinator !== false) await coordinator.start();
  return { store, coordinator, application: new BackendApplication(store, coordinator, { phase2ReadOnly: process.env.MINT_BOT_PHASE2_READ_ONLY === 'true' }), walletRoot: resolveWalletPath(projectRoot) };
}
