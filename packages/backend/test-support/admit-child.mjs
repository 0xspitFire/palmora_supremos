// Opens the shared SQLite file and loads its armed snapshot before signalling
// readiness. The parent releases both children through an explicit IPC barrier.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [dbPath, runId, policyJson, nowIso] = process.argv.slice(2);
const dist = (pkg, file) => pathToFileURL(resolve(import.meta.dirname, '..', '..', pkg, 'dist', file)).href;
const { openDatabase } = await import(dist('database', 'index.js'));
const { CanonicalStoreBridge } = await import(dist('backend', 'canonical-store.js'));

const raw = JSON.parse(policyJson);
const fleetPolicy = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? BigInt(value) : value]));
const db = openDatabase(dbPath);
const store = new CanonicalStoreBridge(db, { now: () => new Date(nowIso), fleetPolicy });
await store.open();
const snapshot = store.snapshot();
const run = snapshot.runs.find((item) => item.id === runId);
const intent = snapshot.intents.find((item) => item.id === run?.intentId);
const campaign = snapshot.campaigns.find((item) => item.id === run?.campaignId);
if (!run || !intent || !campaign) throw new Error('CHILD_SETUP_MISSING_RUN');
await new Promise(resolve=>{process.once('message',message=>{if(message==='admit')resolve();});process.send('ready');});
let outcome;
try {
  const admission = await store.admitExecution({ run, intent, campaign, wallets: intent.wallets });
  outcome = { ok: true, reservations: admission.reservations.map((item) => item.id).sort() };
} catch (error) {
  outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
store.close();
process.stdout.write(`${JSON.stringify(outcome)}\n`);
if(process.connected)process.disconnect();
