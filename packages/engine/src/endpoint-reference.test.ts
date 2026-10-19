import { describe, expect, it } from 'vitest';
import { safeEndpointReference } from './endpoint-reference.js';

describe('safeEndpointReference', () => {
  it('keeps short opaque provider labels', () => {
    expect(safeEndpointReference('public-rpc')).toBe('public-rpc');
    expect(safeEndpointReference('flashbots:primary')).toBe('flashbots:primary');
  });

  it('never returns any part of an endpoint URL or credential-bearing value', () => {
    for (const endpoint of [
      'https://provider.example/v2/secret',
      'https://user:password@provider.example',
      'https://secret.provider.example',
      'rpc?apiKey=secret',
      'rpc%2Fsecret',
    ]) {
      expect(safeEndpointReference(endpoint)).toBe('rpc');
    }
  });
});
