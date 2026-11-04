import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { qualifyWalletProofs, type AllowlistAuthoritySnapshot, type VerifiedWalletProof, type SupportedChainId } from '@mint-bot/engine';
import type { Address } from 'viem';

export interface PublishedMintSource {
  id: string;
  chainId: SupportedChainId;
  nftContract: Address;
  stageIndex: string;
  /** An owner-approved HTTPS URL, or ipfs:// / ar:// reference with a pinned digest. */
  uri: string;
  contentDigest: string;
  /** Exact approved origin, never taken from a collection's metadata. */
  approvedOrigin: string;
  credentialName?: string;
}

// Pinned immutable bytes may be reused; chain roots/parameters are always read afresh.
const artifactCache = new Map<string, string>();

export function publicSourceAddress(ip: string): boolean {
  // Reject IPv6 too: this fetcher deliberately permits public IPv4 only, with DNS pinned below.
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
}

export function publishedSourceUrl(source: PublishedMintSource): URL {
  let uri = source.uri;
  if (uri.startsWith('ipfs://')) {
    const path = uri.slice(7);
    if (!/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})(?:\/[A-Za-z0-9_.-]+)*$/.test(path)) throw new Error('PUBLISHED_SOURCE_URI_INVALID');
    uri = `https://ipfs.io/ipfs/${path}`;
  } else if (uri.startsWith('ar://')) {
    if (!/^ar:\/\/[A-Za-z0-9_-]{43}$/.test(uri)) throw new Error('PUBLISHED_SOURCE_URI_INVALID');
    uri = `https://arweave.net/${uri.slice(5)}`;
  }
  const url = new URL(uri);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.port && url.port !== '443' || url.origin !== source.approvedOrigin || !/^sha256:[a-f0-9]{64}$/.test(source.contentDigest) || !/^[A-Za-z0-9_-]{1,80}$/.test(source.id)) throw new Error('PUBLISHED_SOURCE_NOT_APPROVED');
  return url;
}

/** Bounded HTTPS, public DNS pinned to the checked address, TLS hostname retained, no redirects. */
export async function readPublishedSource(source: PublishedMintSource, credential?: string): Promise<string> {
  const url = publishedSourceUrl(source);
  if (source.credentialName && !credential) throw new Error('PUBLISHED_SOURCE_CREDENTIAL_REQUIRED');
  const cacheKey = `${source.id}:${url.toString()}:${source.contentDigest}`;
  const cached = artifactCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const answers = await lookup(url.hostname, { all: true, family: 4 });
  if (!answers.length || answers.some((answer) => !publicSourceAddress(answer.address))) throw new Error('PUBLISHED_SOURCE_ADDRESS_BLOCKED');
  if (source.credentialName && !credential) throw new Error('PUBLISHED_SOURCE_CREDENTIAL_REQUIRED');
  const selected = answers[0]!;
  const text = await new Promise<string>((resolve, reject) => {
    const req = request(url, { method: 'GET', lookup: (_host, _options, callback) => callback(null, selected.address, 4), headers: { accept: 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) } }, (res) => {
      if (res.statusCode !== 200) { res.destroy(); reject(new Error('PUBLISHED_SOURCE_HTTP_FAILED')); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) req.destroy(new Error('PUBLISHED_SOURCE_TOO_LARGE')); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => reject(new Error('PUBLISHED_SOURCE_READ_FAILED')));
    });
    const timer = setTimeout(() => req.destroy(new Error('PUBLISHED_SOURCE_TIMEOUT')), 10_000);
    req.on('error', () => reject(new Error('PUBLISHED_SOURCE_UNAVAILABLE')));
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
  if (`sha256:${createHash('sha256').update(text).digest('hex')}` !== source.contentDigest) throw new Error('PUBLISHED_SOURCE_DIGEST_MISMATCH');
  artifactCache.set(cacheKey, text);
  if (artifactCache.size > 16) artifactCache.delete(artifactCache.keys().next().value!);
  return text;
}

/** The artifact and RPC state have independent origins; neither alone proves eligibility. */
export async function loadWalletProofs(input: {
  source: PublishedMintSource;
  wallets: readonly Address[];
  readAuthority(): Promise<AllowlistAuthoritySnapshot>;
  credential?: string;
  now?: () => Date;
  readArtifact?: typeof readPublishedSource;
}): Promise<VerifiedWalletProof[]> {
  const text = await (input.readArtifact ?? readPublishedSource)(input.source, input.credential);
  // Chain state is read after download so a slow publisher never ages the root snapshot.
  const authority = await input.readAuthority();
  return qualifyWalletProofs({ text, source: { ...input.source, sourceId: input.source.id }, authority, wallets: input.wallets, now: (input.now ?? (() => new Date()))() });
}
