import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BackendApplication, CanonicalStoreBridge, ExecutionCoordinator, resolveWalletPath, type BackendStore, type EngineAdapter } from '@mint-bot/backend';
import { openDatabase } from '@mint-bot/database';
import { TurnkeySigner, type WalletInfo } from '@mint-bot/engine';
import type { Address } from 'viem';
import { createCanonicalLifecycleStore, createMintEngineAdapter, type MintEngineAdapterOptions } from './engine-adapter.js';

export interface CliRuntime { store: BackendStore; coordinator: ExecutionCoordinator; application: BackendApplication; walletRoot: string; }

export function configuredSecretRoot(projectRoot: string): string {
  return resolve(process.env.MINT_BOT_SECRET_ROOT ?? resolve(projectRoot, 'Rets'));
}

export function turnkeyCustodyEnabled(): boolean {
  return process.env.MINT_BOT_CUSTODY === 'turnkey';
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

export async function createCliRuntime(projectRoot: string, engine?: EngineAdapter, statePath = process.env.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite', adapterOptions?: Partial<Omit<MintEngineAdapterOptions, 'getState'>>): Promise<CliRuntime> {
  const store = new CanonicalStoreBridge(openDatabase(resolve(projectRoot, statePath)), { durable: true, ...(turnkeyCustodyEnabled() ? { walletKeyReferencePrefix: 'turnkey-wallet-map' } : {}) });
  await store.open();
  const lifecycleStore = createCanonicalLifecycleStore(store);
  const secretRoot = configuredSecretRoot(projectRoot);
  const turnkeyOptions: Partial<Omit<MintEngineAdapterOptions, 'getState'>> = turnkeyCustodyEnabled() ? {
    walletFile: resolve(projectRoot, 'Rets', 'wallets', 'turnkey-wallet-map.json'),
    walletList: () => configuredWallets(projectRoot, resolveWalletPath(projectRoot)),
    signerFactory: () => TurnkeySigner.fromSecrets('mainnet', secretRoot),
    passphraseProvider: async () => '',
  } : {};
  const actualEngine = engine ?? createMintEngineAdapter({
    walletFile: resolveWalletPath(projectRoot),
    killSwitchFile: resolve(projectRoot, 'Rets', 'state', 'killswitch'),
    secretRoot,
    logFile: resolve(projectRoot, 'Rets', 'state', 'mint-bot.log'),
    maxFeePerGasGwei: 100,
    gasLimitPadding: 1.2,
    maxReplacementBumps: 0,
    ...turnkeyOptions,
    ...adapterOptions,
    getState: () => store.snapshot(),
    transact: (mutate) => store.transaction(mutate),
    lifecycleStore: adapterOptions?.lifecycleStore ?? lifecycleStore,
    settleComponents: adapterOptions?.settleComponents ?? ((reservationId, components) => store.settleExecutionComponents(reservationId, components)),
  });
  const coordinator = new ExecutionCoordinator(store, actualEngine);
  await coordinator.start();
  return { store, coordinator, application: new BackendApplication(store, coordinator), walletRoot: resolveWalletPath(projectRoot) };
}
