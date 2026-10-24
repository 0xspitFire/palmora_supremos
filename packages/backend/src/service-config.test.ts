import { describe, expect, it } from 'vitest';
import { loadServiceConfig, summarizeServiceConfig } from './service-config.js';

const load = (env: NodeJS.ProcessEnv) => loadServiceConfig({ CI: 'true', ...env }, '/tmp/mintbot-config');

describe('service mode (T-059)', () => {
  const host = { MINT_BOT_SERVICE_MODE: 'host', SECRET_STORE_PATH: '/etc/mint-bot/Rets/MINT_BOT_SECRETS.env' };
  it('is dry-run unless host is asked for exactly', () => {
    expect(load({}).mode).toBe('dry-run');
    expect(loadServiceConfig(host, '/tmp/mintbot-config').mode).toBe('host');
  });

  it('refuses any other mode, host mode in CI, without the secret store, or without the startup kill switch (fail closed)', () => {
    for (const bad of ['live', 'Host', 'HOST', ' host']) expect(() => loadServiceConfig({ ...host, MINT_BOT_SERVICE_MODE: bad }, '/tmp/mintbot-config'), bad).toThrow('SERVICE_MODE_INVALID');
    expect(() => load(host)).toThrow('HOST_MODE_NOT_ALLOWED_IN_CI');
    expect(() => loadServiceConfig({ MINT_BOT_SERVICE_MODE: 'host' }, '/tmp/mintbot-config')).toThrow('HOST_MODE_REQUIRES_SECRET_STORE');
    expect(() => loadServiceConfig({ ...host, MINT_BOT_REQUIRE_STARTUP_KILL_SWITCH: 'false' }, '/tmp/mintbot-config')).toThrow('HOST_MODE_REQUIRES_STARTUP_KILL_SWITCH');
    expect(loadServiceConfig({ ...host, MINT_BOT_REQUIRE_STARTUP_KILL_SWITCH: 'true' }, '/tmp/mintbot-config').requireStartupKillSwitch).toBe(true);
  });
});

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
