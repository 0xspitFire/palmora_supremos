import { describe, expect, it } from 'vitest';
import { publicSourceAddress, publishedSourceUrl, type PublishedMintSource } from './published-mint-source.js';
const source: PublishedMintSource = { id: 'project', chainId: 1, nftContract: '0x1111111111111111111111111111111111111111', stageIndex: '1', uri: 'https://project.example/proof.json', contentDigest: `sha256:${'a'.repeat(64)}`, approvedOrigin: 'https://project.example' };
describe('first-party published source boundary', () => {
  it('uses only exact owner-approved TLS origins', () => {
    expect(publishedSourceUrl(source).hostname).toBe('project.example');
    for (const uri of ['http://project.example/proof.json', 'https://other.example/proof.json', 'https://token@project.example/proof.json', 'https://project.example/proof.json?token=secret']) expect(() => publishedSourceUrl({ ...source, uri })).toThrow();
  });
  it('blocks loopback, metadata, private networks, CGNAT, reserved and IPv6 targets', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '198.18.0.1', '::1', '::ffff:127.0.0.1']) expect(publicSourceAddress(ip), ip).toBe(false);
    expect(publicSourceAddress('1.1.1.1')).toBe(true);
  });
  it('maps immutable storage references only to their approved gateway', () => {
    expect(publishedSourceUrl({ ...source, uri: `ar://${'a'.repeat(43)}`, approvedOrigin: 'https://arweave.net' }).origin).toBe('https://arweave.net');
    expect(() => publishedSourceUrl({ ...source, uri: 'ipfs://../../etc/passwd', approvedOrigin: 'https://ipfs.io' })).toThrow();
  });
});
