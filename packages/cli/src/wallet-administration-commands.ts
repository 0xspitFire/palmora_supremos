import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Argv } from 'yargs';
import { validateWalletSealedImport } from '@mint-bot/backend';
import { createWalletAdministrationRuntime, runWalletAdministrationOperator, walletAdministrationProfileTemplate, type WalletAdministrationRuntime, type WalletAdministrationRuntimeOptions } from './wallet-administration-runtime.js';
import { readWalletAdministrationQueue, startWalletAdministrationWorker } from './wallet-administration-service.js';

export interface WalletAdministrationCommandsOptions {
  runtimeRoot: string;
  createRuntime?: (options: WalletAdministrationRuntimeOptions) => Promise<WalletAdministrationRuntime>;
  now?: () => Date;
  write?: (text: string) => void;
  readSealedImports?: typeof readWalletAdministrationSealedFile;
}
/** Explicit owner-side JSON input only. The content is never persisted, logged
 * or returned. Keep the file/descriptor bound across permission verification. */
export async function readWalletAdministrationSealedFile(path: string, requestId: string): Promise<readonly { index: number; encryptedBundle: string }[]> {
  if (extname(path).toLowerCase() !== '.json') throw new Error('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED');
  let current = resolve(path);
  for (;;) { const stat = await lstat(current); if (stat.isSymbolicLink()) throw new Error('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED'); const parent = dirname(current); if (parent === current) break; current = parent; }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); const uid = process.geteuid?.() ?? process.getuid?.();
    if (!stat.isFile() || uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > 30_000) throw new Error('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED');
    const body: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED');
    const row = body as Record<string, unknown>;
    if (Object.keys(row).some(key => !['requestId', 'sealedImports'].includes(key)) || row.requestId !== requestId || !Array.isArray(row.sealedImports) || row.sealedImports.length < 1 || row.sealedImports.length > 10) throw new Error('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED');
    const result = row.sealedImports.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED');
      const item = value as Record<string, unknown>;
      if (Object.keys(item).some(key => !['index', 'encryptedBundle'].includes(key)) || typeof item.index !== 'number' || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= 10) throw new Error('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED');
      validateWalletSealedImport(item.encryptedBundle);
      return { index: item.index, encryptedBundle: item.encryptedBundle };
    });
    if (new Set(result.map(item => item.index)).size !== result.length) throw new Error('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED');
    return result;
  } catch { throw new Error('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED'); }
  finally { await handle.close(); }
}

/** Root registers this before parse. No credential, file or DB is opened merely
 * by registering commands or requesting --help/profile-template. */
export function registerWalletAdministrationCommands<T>(cli: Argv<T>, options: WalletAdministrationCommandsOptions): Argv<T> {
  const now = options.now ?? (() => new Date()); const write = options.write ?? (text => process.stdout.write(text));
  cli.command('wallet-admin <action>', 'Owner wallet inventory, public requests/groups, isolated enrollment worker and offline drafts', args => args
    .positional('action', { type: 'string', choices: ['status', 'inventory', 'request', 'execute', 'reconcile', 'group', 'assign', 'enroll', 'retire', 'profile-template', 'worker'] as const, demandOption: true })
    .option('owner-id', { type: 'string', description: 'Public owner Telegram ID; must match the queued request owner' })
    .option('request-id', { type: 'string' }).option('kind', { type: 'string', choices: ['generate', 'import'] as const })
    .option('chains', { type: 'string', description: 'Supported numeric chain IDs, comma-separated' }).option('count', { type: 'number' })
    .option('addresses', { type: 'string', description: 'Public addresses only; sealed/key material is never accepted here' })
    .option('group-id', { type: 'string' }).option('chain', { type: 'string' }).option('name', { type: 'string' }).option('campaign-id', { type: 'string' })
    .option('key-ids', { type: 'string' }).option('replace-key-ids', { type: 'string' })
    .option('sealed-import-file', { type: 'string', description: 'Owner-only HPKE JSON envelope file; execute/one-shot worker only' })
    .option('once', { type: 'boolean', default: false }).option('owner-admin', { type: 'boolean', default: false })
    .option('organization-id', { type: 'string' }).option('admin-user-id', { type: 'string' }).option('runtime-user-id', { type: 'string' }), async args => {
      let runtime: WalletAdministrationRuntime | undefined;
      const output = (value: unknown) => write(`${JSON.stringify(value, null, 2)}\n`);
      try {
        const ownerId = args.ownerId ?? process.env.MINT_BOT_WALLET_ADMIN_OWNER_ID ?? '';
        if (args.action === 'profile-template') { output(walletAdministrationProfileTemplate({ ownerId, organizationId: args.organizationId ?? '', adminUserId: args.adminUserId ?? '', mintRuntimeUserId: args.runtimeUserId ?? '' })); return; }
        if (args.sealedImportFile && !(args.action === 'execute' || args.action === 'worker' && args.once && args.requestId)) throw new Error('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED');
        const admin = args.action === 'execute' || args.action === 'worker' || args.ownerAdmin;
        runtime = await (options.createRuntime ?? createWalletAdministrationRuntime)({ runtimeRoot: options.runtimeRoot, ownerId, mode: admin ? 'owner-admin' : 'public', now });
        const context = runtime;
        const authority = { ownerId, channel: 'owner-cli' as const, sessionId: `owner-cli:${randomUUID()}`, expiresAt: new Date(now().getTime() + 300_000).toISOString(), assertCurrent: async () => undefined };
        const publicAction = async (action: string, parameters: string[]) => runWalletAdministrationOperator(context, { action, args: parameters, authority, now });
        if (args.action === 'execute' || args.action === 'worker') {
          if (args.action === 'execute' && !args.requestId) throw new Error('WALLET_ADMIN_REQUEST_ID_REQUIRED');
          const requested = readWalletAdministrationQueue(context.store.snapshot().events);
          if (args.requestId && !requested.some(row => row.request.requestId === args.requestId && row.ownerId === ownerId)) throw new Error('WALLET_ADMIN_OPERATOR_REQUEST_NOT_FOUND');
          const material = args.sealedImportFile ? await (options.readSealedImports ?? readWalletAdministrationSealedFile)(args.sealedImportFile, args.requestId!) : undefined;
          const worker = startWalletAdministrationWorker({ store: context.store, ownerId, administration: authorize => context.serviceFor(authorize), approvalCurrent: context.approvalCurrent, requestId: args.requestId, sealedImports: async row => row.request.requestId === args.requestId ? material : undefined, now, keepAlive: args.action === 'worker' && !args.once });
          try {
            await worker.tick();
            if (args.action === 'worker' && !args.once) await new Promise<void>(resolveStop => { const done = () => { process.removeListener('SIGINT', done); process.removeListener('SIGTERM', done); resolveStop(); }; process.once('SIGINT', done); process.once('SIGTERM', done); });
          } finally { await worker.stop(); }
          output({ profile: context.profileStatus, requests: readWalletAdministrationQueue(context.store.snapshot().events), activeFleetChanged: false }); return;
        }
        switch (args.action) {
          case 'status': case 'inventory': output(await publicAction(args.action, [])); break;
          case 'request': if (!args.kind) throw new Error('WALLET_ADMIN_PUBLIC_REQUEST_INVALID'); output(await publicAction(args.kind, [args.requestId ?? `wallet_admin_${randomUUID()}`, args.chains ?? '', args.kind === 'generate' ? String(args.count ?? '') : args.addresses ?? ''])); break;
          case 'group': output(await publicAction('group', [args.groupId ?? '', args.chain ?? '', args.name ?? '', args.addresses ?? ''])); break;
          case 'assign': output(await publicAction('assign', [args.campaignId ?? '', args.groupId ?? ''])); break;
          case 'enroll': output(await publicAction('enroll', [args.requestId ?? '', args.keyIds ?? '', ...(args.replaceKeyIds ? [args.replaceKeyIds] : [])])); break;
          case 'retire': output(await publicAction('retire', [args.requestId ?? '', args.keyIds ?? ''])); break;
          case 'reconcile': output(await publicAction('reconcile', [args.requestId ?? ''])); break;
        }
      } catch (error) { const code = error instanceof Error && /^WALLET_[A-Z_]{1,90}$/.test(error.message) ? error.message : 'WALLET_ADMIN_OPERATOR_UNAVAILABLE'; output({ state: 'blocked', code, activeFleetChanged: false }); }
      finally { await runtime?.close(); }
    });
  return cli;
}
