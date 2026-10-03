import { describe, expect, it } from 'vitest';
import { loadServiceConfig, summarizeServiceConfig } from './service-config.js';

const load = (env: NodeJS.ProcessEnv) => loadServiceConfig({ CI: 'true', ...env }, '/tmp/mintbot-config');

describe('dashboard public address (T-030)', () => {
  it('is not set by default, so alert links use the local address', () => {
    expect(load({}).dashboardPublicUrl).toBeUndefined();
  });

  it('accepts an https address, keeps its path, and drops any query and fragment', () => {
    expect(load({ MINT_BOT_DASHBOARD_PUBLIC_URL: 'https://mint.example.org/app?token=abc#frag' }).dashboardPublicUrl).toBe('https://mint.example.org/app');
    expect(load({ MINT_BOT_DASHBOARD_PUBLIC_URL: 'https://mint.example.org' }).dashboardPublicUrl).toBe('https://mint.example.org/');
  });

  it('accepts http only for this computer', () => {
    expect(load({ MINT_BOT_DASHBOARD_PUBLIC_URL: 'http://127.0.0.1:9000/' }).dashboardPublicUrl).toBe('http://127.0.0.1:9000/');
    expect(load({ MINT_BOT_DASHBOARD_PUBLIC_URL: 'http://localhost:9000/' }).dashboardPublicUrl).toBe('http://localhost:9000/');
  });

  it('refuses anything else, failing closed with a named error', () => {
    for (const bad of ['http://mint.example.org/', 'javascript:alert(1)', 'ftp://mint.example.org/', 'https://user:pass@mint.example.org/', 'https://:pass@mint.example.org/', 'not a url', 'mint.example.org']) {
      expect(() => load({ MINT_BOT_DASHBOARD_PUBLIC_URL: bad }), bad).toThrow('MINT_BOT_DASHBOARD_PUBLIC_URL_INVALID');
    }
  });

  it('does not change where the server listens: it still refuses a non-loopback bind host', () => {
    expect(() => load({ MINT_BOT_DASHBOARD_PUBLIC_URL: 'https://mint.example.org/', MINT_BOT_BIND_HOST: '0.0.0.0' })).toThrow('BIND_HOST_MUST_BE_LOOPBACK');
    expect(load({ MINT_BOT_DASHBOARD_PUBLIC_URL: 'https://mint.example.org/' }).bindHost).toBe('127.0.0.1');
  });

  it('shows in the logged summary, since it is an address and not a secret', () => {
    expect(summarizeServiceConfig(load({ MINT_BOT_DASHBOARD_PUBLIC_URL: 'https://mint.example.org/' })).dashboardPublicUrl).toBe('https://mint.example.org/');
  });
});
