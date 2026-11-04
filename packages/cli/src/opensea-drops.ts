import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { ALLOWLIST_MINT_ABI, qualifyWalletProofs, SEADROP_V1_ADDRESS, type AllowlistAuthoritySnapshot, type SupportedChainId, type VerifiedWalletProof } from '@mint-bot/engine';
import { OPENSEA_CHAIN_SLUG } from './opensea-client.js';

export interface DropsResponse {
  ok: boolean; status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}
export type DropsFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'error' }) => Promise<DropsResponse>;
export interface OpenSeaDrops {
  ownWalletProofs(input: { chainId: SupportedChainId; contract: Address; wallets: readonly Address[]; readAuthority(feeRecipient: Address): Promise<AllowlistAuthoritySnapshot> }): Promise<VerifiedWalletProof[]>;
}
const MAX_BODY = 1_048_576;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const address = /^0x[0-9a-fA-F]{40}$/;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OPENSEA_DROPS_RESPONSE_INVALID');
  return value as Record<string, unknown>;
};

/** Official API only. Never follows metadata URLs or redirects; API responses never authorize signing. */
export function createOpenSeaDrops(options: { apiKey: string; fetcher?: DropsFetch; now?: () => Date; sleep?: (ms: number) => Promise<void> }): OpenSeaDrops {
  if (!options.apiKey || /[\r\n]/.test(options.apiKey)) throw new Error('OPENSEA_DROPS_KEY_REQUIRED');
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetcher: DropsFetch = options.fetcher ?? ((url, init) => fetch(url, init));
  const cache = new Map<string, { expires: number; value: Record<string, unknown> }>();
  const pending = new Map<string, Promise<Record<string, unknown>>>();
  let nextRequestAt = 0;
  let unavailableUntil = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const request = (path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const key = `${path}:${JSON.stringify(body ?? null)}`;
    const hit = cache.get(key);
    if (hit && hit.expires > now().getTime()) return Promise.resolve(hit.value);
    const flight = pending.get(key);
    if (flight) return flight;
    const work = queue.then(async () => {
      if (now().getTime() < unavailableUntil) throw new Error('OPENSEA_DROPS_BACKOFF');
      const wait = nextRequestAt - now().getTime();
      if (wait > 0) await sleep(wait);
      nextRequestAt = now().getTime() + 500;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(`https://api.opensea.io${path}`, { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', 'x-api-key': options.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, redirect: 'error' });
        if (response.status === 401 || response.status === 403) throw new Error('OPENSEA_DROPS_ACCESS_DENIED');
        if (response.status === 429 || response.status === 503) {
          const retry = Number(response.headers.get('retry-after'));
          unavailableUntil = now().getTime() + Math.max(1_000, Math.min(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 30_000, 300_000));
          throw new Error('OPENSEA_DROPS_BACKOFF');
        }
        if (Number(response.headers.get('content-length') ?? 0) > MAX_BODY) throw new Error('OPENSEA_DROPS_RESPONSE_TOO_LARGE');
        let text = '';
        if (response.body) {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > MAX_BODY) { await reader.cancel(); throw new Error('OPENSEA_DROPS_RESPONSE_TOO_LARGE'); }
              chunks.push(chunk.value);
            }
          } finally { reader.releaseLock(); }
          text = Buffer.concat(chunks).toString('utf8');
        } else text = await response.text();
        if (Buffer.byteLength(text) > MAX_BODY) throw new Error('OPENSEA_DROPS_RESPONSE_TOO_LARGE');
        const parsed = object(JSON.parse(text));
        if (!response.ok) {
          if (response.status === 422 && parsed['code'] === 'MINTER_NOT_ELIGIBLE') throw new Error('OPENSEA_WALLET_NOT_ELIGIBLE');
          if (response.status === 422 && parsed['code'] === 'INSUFFICIENT_BALANCE') throw new Error('OPENSEA_MINT_FUNDING_REQUIRED');
          if (response.status === 404) throw new Error('OPENSEA_DROP_NOT_FOUND');
          if (response.status === 409) throw new Error('OPENSEA_DROP_NOT_MINTING');
          if (response.status === 400 && parsed['code'] === 'UNSUPPORTED_DROP_TYPE') throw new Error('OPENSEA_DROP_TYPE_UNSUPPORTED');
          throw new Error('OPENSEA_DROPS_UNAVAILABLE');
        }
        cache.set(key, { expires: now().getTime() + 15_000, value: parsed });
        if (cache.size > 128) cache.delete(cache.keys().next().value!);
        return parsed;
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        throw new Error(/^OPENSEA_[A-Z_]+$/.test(code) ? code : 'OPENSEA_DROPS_UNAVAILABLE');
      } finally { controller.abort(); clearTimeout(timer); }
    });
    queue = work.catch(() => undefined);
    pending.set(key, work);
    void work.finally(() => pending.delete(key)).catch(() => undefined);
    return work;
  };
  return {
    async ownWalletProofs(input) {
      const chain = OPENSEA_CHAIN_SLUG[input.chainId];
      const wallets = [...new Set(input.wallets.map((wallet) => wallet.toLowerCase()))] as Address[];
      if (!chain || !address.test(input.contract) || wallets.length < 1 || wallets.length > 100 || wallets.some((wallet) => !address.test(wallet))) throw new Error('OPENSEA_DROPS_SCOPE_INVALID');
      const metadata = await request(`/api/v2/chain/${chain}/contract/${input.contract.toLowerCase()}`);
      const slug = metadata['collection'];
      if (typeof slug !== 'string' || !SLUG.test(slug)) throw new Error('OPENSEA_DROP_NOT_FOUND');
      const entries: Array<Record<string, unknown>> = [];
      let feeRecipient: Address | undefined;
      let stage: bigint | undefined;
      for (const wallet of wallets) {
        let tx: Record<string, unknown>;
        try { tx = await request(`/api/v2/drops/${slug}/mint`, { minter: wallet, quantity: 1 }); }
        catch (error) { if (error instanceof Error && error.message === 'OPENSEA_WALLET_NOT_ELIGIBLE') continue; throw error; }
        if (tx['chain'] !== chain || typeof tx['to'] !== 'string' || tx['to'].toLowerCase() !== SEADROP_V1_ADDRESS.toLowerCase() || typeof tx['data'] !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(tx['data']) || tx['data'].length > 20_000 || typeof tx['value'] !== 'string' || !/^\d{1,78}$/.test(tx['value'])) throw new Error('OPENSEA_MINT_BINDING_INVALID');
        if (tx['data'].slice(0, 10).toLowerCase() === '0x161ac21f') throw new Error('OPENSEA_PUBLIC_STAGE_RESPONSE');
        // Decode only the supported method. Never relay arbitrary API-provided calldata to the signer.
        let decoded: ReturnType<typeof decodeFunctionData<typeof ALLOWLIST_MINT_ABI>>;
        try { decoded = decodeFunctionData({ abi: ALLOWLIST_MINT_ABI, data: tx['data'] as Hex }); }
        catch { throw new Error('OPENSEA_ALLOWLIST_METHOD_REQUIRED'); }
        const [nft, fee, recipient, quantity, params, proof] = decoded.args;
        if (nft.toLowerCase() !== input.contract.toLowerCase() || recipient.toLowerCase() !== zeroAddress || quantity !== 1n || BigInt(tx['value']) !== params.mintPrice || proof.length > 64 || encodeFunctionData({ abi: ALLOWLIST_MINT_ABI, functionName: 'mintAllowList', args: decoded.args }).toLowerCase() !== tx['data'].toLowerCase()) throw new Error('OPENSEA_MINT_BINDING_INVALID');
        if (feeRecipient && feeRecipient.toLowerCase() !== fee.toLowerCase() || stage !== undefined && stage !== params.dropStageIndex) throw new Error('OPENSEA_FLEET_STAGE_MISMATCH');
        feeRecipient = fee; stage = params.dropStageIndex;
        entries.push({ address: wallet, mintParams: params, proof });
      }
      if (!feeRecipient || stage === undefined) throw new Error('ALLOWLIST_OWN_WALLET_PROOF_REQUIRED');
      const text = JSON.stringify(entries, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
      const authority = await input.readAuthority(feeRecipient);
      if (authority.feeRecipient.toLowerCase() !== feeRecipient.toLowerCase()) throw new Error('OPENSEA_FEE_AUTHORITY_MISMATCH');
      const proofs = qualifyWalletProofs({ text, source: { chainId: input.chainId, nftContract: input.contract, stageIndex: stage.toString(), sourceId: 'opensea-drops-v1', contentDigest: `sha256:${createHash('sha256').update(text).digest('hex')}` }, authority, wallets, now: now() });
      if (proofs.length !== entries.length) throw new Error('OPENSEA_PROOF_AUTHORITY_MISMATCH');
      return proofs;
    },
  };
}
