import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HealthService } from './health.js';
import type { BackendStore } from './store.js';
import type { OrchestratorService } from './orchestrator.js';
import { MetricsRegistry, redactError } from './observability.js';

export interface ServiceHttpOptions {
  host: string;
  port: number;
  store: BackendStore;
  orchestrator: OrchestratorService;
  metrics: MetricsRegistry;
}

/** Loopback-only, read-only liveness/readiness/metrics HTTP surface. */
export class ServiceHttpServer {
  private readonly server: Server;
  private listening = false;

  public constructor(private readonly options: ServiceHttpOptions) {
    if (options.host !== '127.0.0.1' && options.host !== '::1' && options.host !== 'localhost') throw new Error('BIND_HOST_MUST_BE_LOOPBACK');
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error('HEALTH_PORT_INVALID');
    this.server = createServer((request, response) => this.handle(request, response));
  }

  public async start(): Promise<{ host: string; port: number }> {
    if (this.listening) return { host: this.options.host, port: this.addressPort() };
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); this.listening = true; resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.options.port, this.options.host);
    });
    return { host: this.options.host, port: this.addressPort() };
  }

  public async stop(): Promise<void> {
    if (!this.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.listening = false;
  }

  private addressPort(): number {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('HEALTH_SERVER_ADDRESS_UNAVAILABLE');
    return address.port;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET') {
      this.writeJson(response, 405, { status: 'failed', reason: 'METHOD_NOT_ALLOWED' });
      return;
    }
    if (path === '/livez') {
      this.writeJson(response, 200, { status: 'ok', live: true, service: 'mint-bot-orchestrator' });
      return;
    }
    if (path === '/healthz') {
      this.writeJson(response, 200, { status: this.options.orchestrator.status().state === 'stopped' ? 'failed' : 'ok', service: 'mint-bot-orchestrator', state: this.options.orchestrator.status().state });
      return;
    }
    if (path === '/readyz' || path === '/health') {
      const health = new HealthService(this.options.store).check();
      this.writeJson(response, health.ready ? 200 : 503, { status: health.ready ? 'ok' : 'blocked', state: health.state, blockingReasons: health.blockingReasons, checkedAt: health.checkedAt });
      return;
    }
    if (path === '/status') {
      this.writeJson(response, 200, { status: 'ok', orchestrator: this.options.orchestrator.status() });
      return;
    }
    if (path === '/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
      response.end(this.options.metrics.renderPrometheus());
      return;
    }
    this.writeJson(response, 404, { status: 'failed', reason: 'NOT_FOUND' });
  }

  private writeJson(response: ServerResponse, status: number, value: unknown): void {
    try {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    } catch (error) {
      const safe = redactError(error);
      response.destroy(new Error(safe.message));
    }
  }
}
