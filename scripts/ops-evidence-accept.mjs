#!/usr/bin/env node
import { readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PATHS, realIo } from './ops-evidence-collect.mjs';
import { KINDS, acceptancePhrase, buildAcceptance, evidenceBindingDigest, sha256Hex, verifyAcceptance } from './ops-evidence-lib.mjs';

/**
 * The owner's acceptance of the five production evidence artifacts (infrastructure design, "Go/no-go conditions"). It only ever
 * reads the artifacts. With the exact typed phrase it writes one acceptance record that binds the owner's approval and witness
 * reference to the SHA-256 of every artifact and of the approved design document; a changed artifact is then no longer accepted.
 *
 *   sudo node scripts/ops-evidence-accept.mjs --design-sha256 <sha256 of the approved design file> --witness "<who and when>"
 *   ... the same command again with --confirm "<the phrase it printed>"
 */
export const ACCEPTANCE_PATH = '/etc/mint-bot/ops-evidence-acceptance.json';
export const SETTINGS_PATH = '/etc/mint-bot/mint-bot.env';
export const CURRENT_RELEASE_FILE = '/opt/mint-bot/current/RELEASE';

const PATH_VARIABLES = {
  recovery: 'MINT_BOT_RECOVERY_EVIDENCE_PATH',
  rotation_revocation: 'MINT_BOT_ROTATION_REVOCATION_EVIDENCE_PATH',
  heap_core_dump: 'MINT_BOT_HEAP_CORE_POLICY_PATH',
  backup_restore: 'MINT_BOT_BACKUP_RESTORE_EVIDENCE_PATH',
  service_supervision: 'MINT_BOT_SERVICE_SUPERVISION_EVIDENCE_PATH',
};

/** Reads each artifact as a regular, non-link, non-empty file. Anything else counts as missing. */
export async function readArtifacts(paths = DEFAULT_PATHS, env = process.env) {
  const artifacts = {};
  for (const kind of KINDS) {
    const path = resolve(env[PATH_VARIABLES[kind]] || paths[kind]);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size === 0) continue;
      const text = await readFile(path, 'utf8');
      artifacts[kind] = { path, bytes: text, json: JSON.parse(text) };
    } catch { /* absent or unreadable: reported as missing */ }
  }
  return artifacts;
}

/** Host id and the installed release commit, read the same way the collectors read them. */
export async function installedIdentity(io = realIo()) {
  const settings = await io.readText(SETTINGS_PATH).catch(() => '');
  const hostId = /^MINT_BOT_HOST_ID=(.+)$/m.exec(settings)?.[1]?.trim() ?? '';
  const commit = /^commit=([0-9a-f]{40})$/m.exec(await io.readText(CURRENT_RELEASE_FILE).catch(() => ''))?.[1] ?? '';
  return { hostId, commit };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if (typeof process.getuid === 'function' && process.getuid() !== 0) { console.error('Run this as root.'); process.exitCode = 2; return; }
  const designSha256 = (option('--design-sha256') ?? '').toLowerCase();
  const witness = option('--witness') ?? '';
  if (!/^[0-9a-f]{64}$/.test(designSha256) || witness.trim().length < 3) { console.error('Usage: sudo node scripts/ops-evidence-accept.mjs --design-sha256 <64 hex> --witness "<who witnessed, and when>" [--confirm "<phrase>"]'); process.exitCode = 2; return; }
  const io = realIo();
  const { hostId, commit } = await installedIdentity(io);
  const artifacts = await readArtifacts();
  const digests = Object.fromEntries(KINDS.filter((kind) => artifacts[kind]).map((kind) => [kind, sha256Hex(artifacts[kind].bytes)]));
  for (const kind of KINDS) console.log(`${artifacts[kind] ? 'found  ' : 'MISSING'} ${kind}${artifacts[kind] ? `  ${digests[kind]}` : ''}`);
  const phrase = acceptancePhrase(digests, designSha256);
  const eventDigest = /^[0-9a-f]{64}$/i.test(process.env.MINT_BOT_OPS_EVIDENCE_EVENT_DIGEST ?? '') ? process.env.MINT_BOT_OPS_EVIDENCE_EVENT_DIGEST.toLowerCase() : '';
  const bindingDigest = evidenceBindingDigest({ currentCommit: commit, hostId, digests, eventDigest });
  const acceptance = buildAcceptance({ digests, designSha256, witness: witness.trim(), acceptedAt: io.now().toISOString(), bindingDigest });
  const problems = verifyAcceptance(acceptance, artifacts, { currentCommit: commit, hostId, bindingDigest });
  if (problems.length > 0) { console.log(`\nCannot accept yet:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`); process.exitCode = 1; return; }
  if (option('--confirm') !== phrase) { console.log(`\nAll five artifacts are present, pass, and describe the installed release ${commit.slice(0, 7)} on ${hostId}.\nTo accept exactly these, run the same command again adding:\n  --confirm "${phrase}"`); return; }
  const text = `${JSON.stringify(acceptance, null, 2)}\n`;
  const temporary = `${ACCEPTANCE_PATH}.${process.pid}.tmp`;
  try { await writeFile(temporary, text, { mode: 0o644, flag: 'wx' }); await rename(temporary, ACCEPTANCE_PATH); } finally { await unlink(temporary).catch(() => undefined); }
  console.log(`\nAccepted until ${acceptance.expiresAt}. Record: ${ACCEPTANCE_PATH}\nSHA-256: ${sha256Hex(text)}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) {
  main().catch((error) => { console.error(`FAILED: ${error instanceof Error ? error.message : 'unknown'}`); process.exitCode = 1; });
}
