export type SecretStore = 'MINT_BOT_SECRETS' | 'TEST_BOT';
export const MAINNET_SECRET_FILE_REFERENCE = 'Rets/MINT_BOT_SECRETS.env';
export const APPROVED_KEYSTORE_REFERENCE = './Rets/wallets';
export interface SecretReference { store: SecretStore; key: 'ETHEREUM_RPC_URL' | 'ROBINHOOD_RPC_URL' | 'INK_RPC_URL' | 'BASE_RPC_URL' | 'OPENSEA_API' | 'ALCHEMY_API' | 'ANVIL_FORK_RPC' | 'TEST_WALLET_PK' | 'TEST_WALLET_ADDR' | 'TG_BOT_TOKEN' | 'TG_CHAT_ID'; }
export interface BackendConfig { secretStore: SecretStore; rpcReference: SecretReference; chainId: 1 | 4663; flashbotsEnabled: boolean; flashbotsAuthReference?: string; sequencerUrl?: string; archiveReference?: string; }
export function assertSafeConfig(config: BackendConfig): void {
  if (config.rpcReference.store !== config.secretStore) throw new Error('SECRET_STORE_MISMATCH');
  if (config.chainId === 1 && config.rpcReference.key !== 'ETHEREUM_RPC_URL') throw new Error('INVALID_ETHEREUM_RPC_REFERENCE');
  if (config.chainId === 4663 && config.rpcReference.key !== 'ROBINHOOD_RPC_URL') throw new Error('INVALID_ROBINHOOD_RPC_REFERENCE');
  if (config.flashbotsEnabled && !config.flashbotsAuthReference) throw new Error('FLASHBOTS_AUTH_REFERENCE_REQUIRED');
  if (config.chainId === 4663 && config.flashbotsEnabled) throw new Error('FLASHBOTS_ETHEREUM_ONLY');
  if (config.chainId === 4663 && config.sequencerUrl !== 'https://sequencer.mainnet.chain.robinhood.com') throw new Error('ROBINHOOD_SEQUENCER_INVALID');
  if (config.chainId === 4663 && config.archiveReference !== `${MAINNET_SECRET_FILE_REFERENCE}:ANVIL_FORK_RPC`) throw new Error('ROBINHOOD_ARCHIVE_REFERENCE_INVALID');
}
