#!/usr/bin/env node
// Owner-run function for edit permissions (T-019, D-039). The only sanctioned way to add file-edit
// allow rules to .claude/settings.local.json. Sessions cannot use it: the Bash guard refuses any command
// that names it, it refuses to run inside a Claude Code session (environment or parent process), and it
// needs a terminal and a typed "yes". Run it in a normal terminal outside Claude Code.
//
//   node .claude/hooks/grant-edit.mjs <patch.json>      add the rules in a patch file (after a summary and "yes")
//   node .claude/hooks/grant-edit.mjs --show            list the file-edit rules now allowed
//   node .claude/hooks/grant-edit.mjs --revoke <rule>   remove one rule, e.g. "Edit(packages/a/b.ts)"
//   node .claude/hooks/grant-edit.mjs --revoke-all      remove every Edit(...) and Write(...) allow rule
//
// A patch is JSON with only an allow list: {"permissions": {"allow": ["Edit(path/to/file.ts)", ...]}} or
// {"allow": [...]}. Only exact-file Edit(...) and Write(...) rules are accepted. Everything else is
// refused, and nothing is written unless every rule is valid. Other keys and other allow rules in the
// settings file are kept. The deny and ask lists are never touched.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RULE = /^(Write|Edit)\(([^()]+)\)$/;
const SECRET_NAMES = ['Rets', 'secrets', 'keystore', 'wallets', 'wallets.enc', 'wallets.json', 'MINT_BOT_SECRETS', 'TEST_BOT'];
const SECRET_LOWER = SECRET_NAMES.map((n) => n.toLowerCase());
const FORBIDDEN_FOLDERS = ['.claude', '.git', 'node_modules'];
const MAX_RULES = 50;

// Returns { ok: true, rule } with the rule in canonical form, or { ok: false, why }.
export function validateRule(rule) {
  if (typeof rule !== 'string') return { ok: false, why: 'not text' };
  if (/[^\x20-\x7e]/.test(rule)) return { ok: false, why: 'only plain printable ASCII characters are accepted (no control or hidden characters)' };
  const m = rule.match(RULE);
  if (!m) return { ok: false, why: 'only Edit(file) and Write(file) rules are accepted' };
  const tool = m[1];
  let path = m[2];
  if (path !== path.trim()) return { ok: false, why: 'spaces around the path' };
  if (path.startsWith('./')) path = path.slice(2);
  if (path === '' || path.length > 200) return { ok: false, why: 'empty or too long a path' };
  if (/[*?[\]{}~\\]/.test(path)) return { ok: false, why: 'wildcards, ~ and backslashes are not accepted (name exact files)' };
  if (path.startsWith('!') || path.startsWith('#')) return { ok: false, why: 'a path may not start with ! or #' };
  if (path.startsWith('/')) return { ok: false, why: 'absolute paths are not accepted (use a path inside the repo)' };
  if (path.endsWith('/')) return { ok: false, why: 'a folder is not accepted (name exact files)' };
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return { ok: false, why: 'paths with .., . or empty parts are not accepted' };
  const low = parts.map((p) => p.toLowerCase());
  if (low.some((p) => FORBIDDEN_FOLDERS.includes(p))) return { ok: false, why: 'files under .claude, .git or node_modules are not accepted' };
  if (low.some((p) => SECRET_LOWER.includes(p) || p === '.env' || p.startsWith('.env.') || p.endsWith('.key') || p.endsWith('.pem'))) {
    return { ok: false, why: 'secret files and folders are never accepted' };
  }
  // A bare name can match in every folder (gitignore-style patterns), so a folder is required.
  if (!path.includes('/')) return { ok: false, why: 'name the file with its folder, for example packages/x/file.ts (a bare name can match in every folder)' };
  return { ok: true, rule: `${tool}(${path})` };
}

// Parses a patch and validates it as a whole. Throws one Error listing every problem.
export function parsePatch(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('the patch is not valid JSON'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('the patch must be a JSON object');
  const extra = Object.keys(data).filter((k) => !['$schema', 'permissions', 'allow'].includes(k));
  if (extra.length) throw new Error(`the patch may only contain an allow list; remove: ${extra.join(', ')}`);
  let allow = data.allow;
  if (data.permissions !== undefined) {
    const p = data.permissions;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new Error('"permissions" must be an object');
    const more = Object.keys(p).filter((k) => k !== 'allow');
    if (more.length) throw new Error(`the patch may only add allow rules; remove: ${more.join(', ')}`);
    if (allow !== undefined) throw new Error('use either "allow" or "permissions.allow", not both');
    allow = p.allow;
  }
  if (!Array.isArray(allow) || allow.length === 0) throw new Error('the patch needs a non-empty allow list');
  if (allow.length > MAX_RULES) throw new Error(`too many rules (${allow.length}; the limit is ${MAX_RULES})`);
  const rules = [];
  const problems = [];
  for (const r of allow) {
    const v = validateRule(r);
    if (v.ok) { if (!rules.includes(v.rule)) rules.push(v.rule); } else problems.push(`  ${JSON.stringify(r)}: ${v.why}`);
  }
  if (problems.length) throw new Error(`refused, nothing was changed:\n${problems.join('\n')}`);
  return rules;
}

function readSettings(file) {
  if (!existsSync(file)) return {};
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; fix it by hand first`); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} must hold a JSON object`);
  if (data.permissions !== undefined && (data.permissions === null || typeof data.permissions !== 'object' || Array.isArray(data.permissions))) throw new Error('"permissions" in the settings file is not an object');
  if (data.permissions?.allow !== undefined && !Array.isArray(data.permissions.allow)) throw new Error('"permissions.allow" in the settings file is not a list');
  return data;
}

function writeSettings(file, data) {
  // Exclusive create under a random name, so a pre-planted link cannot redirect the write.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o644;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to remove */ }
    throw e;
  }
}

// Adds rules to a settings object without losing anything. Returns { settings, added, already }.
export function merge(settings, rules) {
  const out = { ...settings, permissions: { ...(settings.permissions ?? {}) } };
  if (settings.permissions === undefined && out.$schema === undefined) out.$schema = 'https://json.schemastore.org/claude-code-settings.json';
  const allow = [...(out.permissions.allow ?? [])];
  const added = [];
  const already = [];
  for (const r of rules) { if (allow.includes(r)) already.push(r); else { allow.push(r); added.push(r); } }
  out.permissions.allow = allow;
  return { settings: out, added, already };
}

// Removes file-edit rules. Only Edit(...) and Write(...) rules are ever removed.
export function revoke(settings, which) {
  const allow = settings.permissions?.allow ?? [];
  const removed = allow.filter((r) => typeof r === 'string' && RULE.test(r) && (which === 'all' || r === which));
  if (!removed.length) return { settings, removed };
  return { settings: { ...settings, permissions: { ...settings.permissions, allow: allow.filter((r) => !removed.includes(r)) } }, removed };
}

const summaryOf = (added, already) => [
  added.length ? `Claude sessions will be able to create or edit these ${added.length} file(s) without asking each time:` : 'Nothing new to allow.',
  ...added.map((r) => `  + ${r}`),
  ...(already.length ? [`Already allowed, unchanged: ${already.length}`] : []),
  'Only .claude/settings.local.json (not checked into git) changes. The deny rules and the Bash guard stay in force.',
].join('\n');

// Applies a patch. `confirm(summary)` must resolve true, or nothing is written.
export async function apply({ root, patchText, confirm }) {
  const file = join(root, '.claude', 'settings.local.json');
  const rules = parsePatch(patchText);
  const { settings, added, already } = merge(readSettings(file), rules);
  if (!added.length) return { added, already, file, written: false, summary: summaryOf(added, already) };
  const summary = summaryOf(added, already);
  if (!(await confirm(summary))) return { added: [], already, file, written: false, summary, cancelled: true };
  writeSettings(file, settings);
  return { added, already, file, written: true, summary };
}

export async function applyRevoke({ root, which, confirm }) {
  const file = join(root, '.claude', 'settings.local.json');
  const { settings, removed } = revoke(readSettings(file), which);
  const summary = removed.length ? `These ${removed.length} file-edit rule(s) will be removed:\n${removed.map((r) => `  - ${printable(r)}`).join('\n')}` : 'No matching rule found.';
  if (!removed.length) return { removed, file, written: false, summary };
  if (!(await confirm(summary))) return { removed: [], file, written: false, summary, cancelled: true };
  writeSettings(file, settings);
  return { removed, file, written: true, summary };
}

// Text from an existing settings file is cleaned before it is printed to the owner's terminal.
export const printable = (text) => String(text).replace(/[^\x20-\x7e]/g, '?');

export function show(root) {
  const file = join(root, '.claude', 'settings.local.json');
  const allow = readSettings(file).permissions?.allow ?? [];
  const edits = allow.filter((r) => typeof r === 'string' && RULE.test(r));
  return { file, edits, others: allow.length - edits.length };
}

// A session can give a command a pseudo-terminal (the script program, expect, a Python pty), so a terminal
// check alone does not prove the owner is there. As a second line this refuses to run when the process is
// part of a Claude Code session: its environment says so, or one of its parent processes is Claude Code.
// The owner runs it in a normal terminal outside Claude Code.
export function looksLikeClaude(commandLines, env = {}) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID) return true;
  return commandLines.some((argv) => argv.some((a) => /(^|\/)claude(-code)?$/.test(a) || a.includes('@anthropic-ai/claude-code') || /\/claude\/versions\//.test(a)));
}

// The command lines of this process's parents, nearest first (Linux; empty where /proc is missing).
export function parentCommandLines(startPid = process.ppid) {
  const lines = [];
  let pid = startPid;
  for (let depth = 0; depth < 40 && pid > 1; depth += 1) {
    try {
      lines.push(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean));
      const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s*(\d+)/m);
      if (!m) break;
      pid = Number(m[1]);
    } catch { break; }
  }
  return lines;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const [first, second] = process.argv.slice(2);
  const fail = (msg) => { process.stderr.write(`${msg}\n`); process.exit(2); };
  if (first === '--show') {
    try {
      const r = show(root);
      process.stdout.write(`${r.edits.length ? r.edits.map(printable).join('\n') : '(no file-edit rules)'}\nOther allow rules (not shown): ${r.others}\nFile: ${r.file}\n`);
    } catch (e) {
      fail(e.message);
    }
    return;
  }
  const usage = 'usage: grant-edit.mjs <patch.json> | --show | --revoke <rule> | --revoke-all';
  const revoking = first === '--revoke' || first === '--revoke-all';
  if (!first || (first === '--revoke' && !second)) fail(usage);
  const parents = parentCommandLines();
  if (looksLikeClaude(parents, process.env)) fail('Refused: this is running inside a Claude Code session. Sessions cannot grant permissions. Run it yourself in a normal terminal outside Claude Code.');
  if (parents.length === 0) fail('Refused: the parent processes cannot be seen (a detached process, or no /proc). Sessions cannot grant permissions. Run it yourself in a normal terminal.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('Refused: this must be run by the owner in a terminal. Sessions cannot grant permissions.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const confirm = async (summary) => {
    process.stdout.write(`\n${summary}\n\n`);
    const answer = await rl.question('Type yes to apply, anything else cancels: ');
    return answer.trim().toLowerCase() === 'yes';
  };
  try {
    let result;
    if (revoking) result = await applyRevoke({ root, which: first === '--revoke-all' ? 'all' : validateRevoke(second), confirm });
    else {
      const path = resolve(process.cwd(), first);
      const text = readFileSync(path, 'utf8');
      if (text.length > 65536) throw new Error('the patch file is too large');
      result = await apply({ root, patchText: text, confirm });
    }
    process.stdout.write(result.cancelled ? 'Cancelled. Nothing was changed.\n' : result.written ? `Done. Updated ${result.file}\nReload the Claude Code session so it picks up the change.\n` : `${result.summary}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  } finally {
    rl.close();
  }
}

function validateRevoke(rule) {
  if (typeof rule !== 'string' || !RULE.test(rule)) throw new Error('--revoke takes one rule such as "Edit(packages/a/b.ts)"');
  return rule;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
