import { lstat, readFile } from 'node:fs/promises';
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import { OPENSEA_FEE_COLLECTOR, SEADROP_V1_ADDRESS, SeaDropV1AllowlistStrategy, registerStrategy, resolveChainConfigFromSecrets, type AllowlistAuthoritySnapshot } from '@mint-bot/engine';
import { loadWalletProofs, publishedSourceUrl, type PublishedMintSource } from './published-mint-source.js';

const ABI = parseAbi(['function getAllowListMerkleRoot(address nftContract) view returns (bytes32)', 'function getAllowedFeeRecipients(address nftContract) view returns (address[])']);

/** No credentials in this public configuration: optional credentialName names a host secret only. */
export async function installAllowlistSources(input: {
  path: string;
  secretRoot: string;
  wallets(): Promise<Address[]>;
  credential(name: string): Promise<string | undefined>;
}): Promise<void> {
  const stat = await lstat(input.path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1_048_576 || (stat.mode & 0o022) !== 0 || stat.uid !== 0 && stat.uid !== process.getuid?.()) throw new Error('ALLOWLIST_SOURCE_CONFIG_PERMISSIONS_REQUIRED');
  const raw = JSON.parse(await readFile(input.path, 'utf8')) as { version?: unknown; sources?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.sources) || raw.sources.length > 100) throw new Error('ALLOWLIST_SOURCE_CONFIG_INVALID');
  const sources = raw.sources as PublishedMintSource[];
  const identities = new Set<string>();
  for (const source of sources) {
    if (!source || ![1, 8453, 4663].includes(source.chainId) || !/^0x[0-9a-fA-F]{40}$/.test(source.nftContract) || !/^[1-9]\d*$/.test(source.stageIndex) || source.credentialName && !/^[A-Z][A-Z0-9_]{1,80}$/.test(source.credentialName)) throw new Error('ALLOWLIST_SOURCE_CONFIG_INVALID');
    publishedSourceUrl(source);
    const key = `${source.chainId}:${source.nftContract.toLowerCase()}`;
    if (identities.has(key)) throw new Error('ALLOWLIST_SOURCE_STAGE_AMBIGUOUS');
    identities.add(key);
  }
  registerStrategy(new SeaDropV1AllowlistStrategy(async (chainId, contract) => {
    const source = sources.find((s) => s.chainId === chainId && s.nftContract.toLowerCase() === contract.toLowerCase());
    if (!source) throw new Error('ALLOWLIST_FIRST_PARTY_SOURCE_REQUIRED');
    const endpoints = [...new Set((await resolveChainConfigFromSecrets(chainId, 'mainnet', input.secretRoot)).rpcEndpoints)];
    if (endpoints.length < 2) throw new Error('ALLOWLIST_SECOND_RPC_REQUIRED');
    const clients = endpoints.slice(0, 2).map((url) => createPublicClient({ transport: http(url, { timeout: 10_000, retryCount: 0 }) }));
    const readAuthority = async (): Promise<AllowlistAuthoritySnapshot> => {
      const heads = await Promise.all(clients.map((client) => client.getBlockNumber()));
      const min = heads.reduce((a, b) => a < b ? a : b);
      if (min < 2n) throw new Error('ALLOWLIST_CHAIN_UNAVAILABLE');
      const blockNumber = min - 2n;
      const facts = await Promise.all(clients.map(async (client) => {
        const [actualChain, block, root, fees] = await Promise.all([client.getChainId(), client.getBlock({ blockNumber }), client.readContract({ address: SEADROP_V1_ADDRESS, abi: ABI, functionName: 'getAllowListMerkleRoot', args: [contract], blockNumber }), client.readContract({ address: SEADROP_V1_ADDRESS, abi: ABI, functionName: 'getAllowedFeeRecipients', args: [contract], blockNumber })]);
        if (actualChain !== chainId || Date.now() - Number(block.timestamp) * 1000 > 300_000 || Number(block.timestamp) * 1000 > Date.now() + 30_000) throw new Error('ALLOWLIST_CHAIN_STALE');
        return { blockHash: block.hash as Hex, root, feeRecipient: fees[0] ?? OPENSEA_FEE_COLLECTOR };
      }));
      if (JSON.stringify(facts[0]) !== JSON.stringify(facts[1])) throw new Error('ALLOWLIST_RPC_DISAGREEMENT');
      return { chainId, nftContract: contract, seaDrop: SEADROP_V1_ADDRESS, blockNumber, ...facts[0]!, observedAt: new Date().toISOString() };
    };
    return loadWalletProofs({ source, wallets: await input.wallets(), readAuthority, ...(source.credentialName ? { credential: await input.credential(source.credentialName) } : {}) });
  }));
}
