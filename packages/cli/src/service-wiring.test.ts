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

  it('only host mode runs live requests, through its own application with every gate, never the read-only one (T-058)', () => {
    const block = service.slice(service.indexOf('let liveRequests'), service.indexOf('// Scheduled encrypted backups'));
    expect(block).toContain("if (config.mode === 'host') {");
    expect(block).toContain('new BackendApplication(runtime.store, runtime.coordinator, { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY })');
    expect(block).toContain('command: (name, input) => liveApplication.command(name, input)');
    expect(block).not.toContain('runtime.application');
    expect(service).toContain('liveRequests?.stop()');
  });

  it('Telegram commands run only when the owner turns them on, and the start fails without the owner, the token or the authenticator (T-061)', () => {
    const setup = service.slice(service.indexOf('const commandsFlag'), service.indexOf('let intelligence:'));
    expect(setup).toContain("if (commandsFlag !== '' && commandsFlag !== 'true' && commandsFlag !== 'false') throw new Error('TELEGRAM_COMMANDS_FLAG_INVALID')");
    expect(setup).toContain("if (commandsFlag === 'true') {");
    for (const refusal of ["throw new Error('TELEGRAM_COMMANDS_NEED_TELEGRAM')", "throw new Error('TELEGRAM_TOKEN_MISSING')", "throw new Error('TG_OWNER_USER_ID_MISSING')", "parseTotpSecret(secrets.get('TELEGRAM_TOTP_SECRET'))"]) expect(setup).toContain(refusal);
    expect(setup).toContain("logger.registerSecret(secrets.get('TELEGRAM_TOTP_SECRET') ?? '')");
    expect(service).toContain('alerts: intelligenceAlerts');
    const wiring = service.slice(service.indexOf('if (telegramCommandSetup) {'), service.indexOf('// Scheduled encrypted backups'));
    expect(wiring).toContain('const ownerApplication = new BackendApplication(runtime.store, runtime.coordinator, { fleetPolicy: PERSONAL_LIVE_FLEET_POLICY })');
    expect(wiring).not.toContain('runtime.application');
    expect(wiring).toContain('killSwitchPath: config.killSwitchPath');
    expect(service).toContain('telegramCommands?.stop()');
  });

  it('the fee-alert checker and the Telegram menu start only with the owner commands, and stop with the service (T-066)', () => {
    const wiring = service.slice(service.indexOf('if (telegramCommandSetup) {'), service.indexOf('// Scheduled encrypted backups'));
    expect(wiring).toContain('gasAlertChecker = startGasAlerts({');
    expect(wiring).toContain("alerts: () => bridge.gasAlertRepository().active()");
    expect(wiring).toContain("kind: 'status'");
    expect(service).toContain('gasAlertChecker?.stop()');
    // The owner's fee alerts go to the owner only: through `alerts`, never through the viewer fan-out.
    expect(wiring.slice(wiring.indexOf('gasAlertChecker = startGasAlerts'))).toContain('await alerts.intelligence(');
    expect(wiring.slice(wiring.indexOf('gasAlertChecker = startGasAlerts'))).not.toContain('intelligenceAlerts');
    expect(service.indexOf('gasAlertChecker = startGasAlerts')).toBeGreaterThan(service.indexOf('if (telegramCommandSetup) {'));
    const loop = readFileSync(join(here, 'telegram-command-service.ts'), 'utf8');
    expect(loop).toContain('await options.router.registerMenus?.()');
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

describe('outside monitor liveness signal', () => {
  it('starts from the production check address when no chain scanning runs, never both, and stops with the service', () => {
    expect(service).toContain("if (!intelligence && config.secretStorePath) {");
    expect(service).toContain("get('HEALTHCHECK_PING_URL')");
    expect(service).toContain('logger.registerSecret(pingUrl)');
    expect(service).toContain('liveness?.stop();');
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
