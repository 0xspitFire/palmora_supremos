import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { TurnkeySigner } from '../packages/engine/dist/index.js';

const host = process.env.TURNKEY_SIGNER_HEALTH_HOST ?? '127.0.0.1';
const port = Number(process.env.TURNKEY_SIGNER_HEALTH_PORT ?? 8787);
const secretRoot = resolve(process.env.MINT_BOT_SECRET_ROOT ?? resolve(process.cwd(), 'Rets'));
let activeSigner;
let probeInFlight;

function failureReason(error) {
  const reason = error instanceof Error ? error.message : '';
  return /^[A-Z0-9_]+$/.test(reason) ? reason : 'TURNKEY_HEALTH_FAILED';
}

async function runProbe() {
  const signer = await TurnkeySigner.fromSecrets('mainnet', secretRoot);
  activeSigner = signer;
  try {
    return await signer.probe();
  } finally {
    signer.zeroize();
    if (activeSigner === signer) activeSigner = undefined;
  }
}

function probe() {
  if (!probeInFlight) {
    probeInFlight = runProbe().finally(() => {
      probeInFlight = undefined;
    });
  }
  return probeInFlight;
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' || request.url !== '/health') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'not_found' }));
    return;
  }
  try {
    const report = await probe();
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ...report, checkedAt: new Date().toISOString() }));
  } catch (error) {
    response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: 'failed', reason: failureReason(error) }));
  }
});

const shutdown = () => {
  activeSigner?.zeroize();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.listen(port, host);
