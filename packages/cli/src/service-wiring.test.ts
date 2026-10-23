import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-051 slice 2: how the compensated Turnkey profile is wired into the running service. The behaviour of the pieces is tested in
 * turnkey-readiness.test.ts and compensating-arm-gate.test.ts; these pins keep the wiring itself from being quietly removed or
 * from reaching the owner's CLI.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(here, name), 'utf8');
const service = read('orchestrator-service.ts');
const runtime = read('runtime.ts');
const index = read('index.ts');
const build = readFileSync(join(here, '..', '..', '..', 'ops', 'host', 'build-release.sh'), 'utf8');

describe('service wiring of the compensated Turnkey profile', () => {
  it('host mode builds the wiring, probes the provider at start, and never starts without the wallet watcher', () => {
    expect(service).toContain("...(config.mode === 'host' ? {");
    expect(service).toContain('coordinatorAssurance: async (store)');
    expect(service).toContain('readiness.probeAtStart()');
    expect(service).toContain("if (!watchConfig) throw new Error('HOST_MODE_REQUIRES_WALLET_WATCHER')");
    expect(service).toContain("throw new Error('HOST_MODE_REQUIRES_APPROVER_KEY_PIN')");
    // both refusals come before the runtime (and so the database) is opened
    expect(service.indexOf("'HOST_MODE_REQUIRES_WALLET_WATCHER'")).toBeLessThan(service.indexOf('const runtime = await createCliRuntime'));
    expect(service.indexOf("'HOST_MODE_REQUIRES_APPROVER_KEY_PIN'")).toBeLessThan(service.indexOf('const runtime = await createCliRuntime'));
    expect(service).toContain('watcherHandle = started.watcher');
  });

  it('the coordinator receives the binding, the per-run assurance, the fresh-readiness hook and the watcher together', () => {
    for (const field of ['expectedCustodyPolicy: assuranceWiring.expectedCustodyPolicy', 'compensatingAssurance: assuranceWiring.compensatingAssurance', 'refreshReadiness: assuranceWiring.refreshReadiness', 'walletWatch: assuranceWiring.walletWatch']) expect(runtime).toContain(field);
  });

  it("the owner's CLI never passes the service wiring, so a CLI run cannot produce its own assurance (T-042 requirement 4)", () => {
    expect(index).not.toContain('coordinatorAssurance');
    expect(index).not.toContain('refreshReadiness');
  });

  it('a dry-run service never builds it', () => {
    const block = service.slice(service.indexOf('const runtime = await createCliRuntime'), service.indexOf('const metrics = new MetricsRegistry()'));
    expect(block).toContain("config.mode === 'host'");
    expect(block).toContain("startCoordinator: config.mode === 'host'");
  });

  it('the release carries the lockfile, whose digest is one of the seven controls', () => {
    expect(build).toContain('pnpm-lock.yaml node_modules packages scripts');
    expect(build).toContain('node_modules package.json pnpm-lock.yaml; do');
  });
});

describe('RPC failover wiring (owner instruction 2026-10-23)', () => {
  const adapter = read('engine-adapter.ts');
  const watch = read('fleet-watch-service.ts');
  const readiness = read('turnkey-readiness-service.ts');
  it('every service read path uses the failover transport', () => {
    expect(service).toContain('rpcUrls: (chainId) => [watcherRpcSecretName(chainId), ...chainRpcSecretNames(');
    expect(service).toContain('EngineIntelligencePort.fromRpcUrls(rpcUrls)');
    expect(watch).toContain('transport: failoverTransport(urls)');
    expect(readiness).toContain('transport: failoverTransport(chain.rpcEndpoints)');
    expect(adapter).toContain('failoverTransport(isBase ? splitBaseEndpoints(config.rpcEndpoints).primary : config.rpcEndpoints)');
  });
  it('the CLI read commands fail over too, with the public Robinhood RPC only as the last resort', () => {
    expect(index).toContain('const urls = rpcUrl ? [rpcUrl] : [...configured, PUBLIC_ROBINHOOD_RPC];');
    expect(index.match(/failoverTransport\(/g)?.length).toBeGreaterThanOrEqual(7);
  });
});
