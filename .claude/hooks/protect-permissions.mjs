#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit|NotebookEdit) hook (T-019, D-039). Exit 2 blocks the call.
// No session may write a permission list: .claude/settings.json or .claude/settings.local.json, in a
// project or in ~/.claude. The owner changes them (by hand, or with grant-edit.mjs in a terminal).
// Edits to every other file, including the files an allow rule names, are not affected.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PERMISSION_FILES = ['settings.json', 'settings.local.json'];

const real = (p) => { try { return realpathSync(p); } catch { return null; } };

// True when path (relative to cwd) is a permission list, or a symlink or folder alias of one.
export function isPermissionFile(path, cwd = process.cwd(), home = homedir()) {
  if (typeof path !== 'string' || path === '') return false;
  const expanded = path === '~' || path.startsWith('~/') ? home + path.slice(1) : path;
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const parentReal = real(dirname(abs));
  const candidates = [abs, real(abs), parentReal && join(parentReal, basename(abs))];
  return candidates.some((c) => c && PERMISSION_FILES.includes(basename(c)) && basename(dirname(c)) === '.claude');
}

// A patch against a permission list, written to any file, would be applied later with git apply or patch.
// The same pattern is in guard.mjs for shell commands.
export const PATCH_OF_LIST = /(^|\n)[ \t]*(\+\+\+ |--- |diff --git |rename (to|from) |copy (to|from) ).*\.claude\/settings(\.local)?\.json/;

// Every piece of text a Write, Edit, MultiEdit or NotebookEdit call would put into a file.
export function writtenTexts(tool) {
  const out = [tool.content, tool.new_string, tool.new_source];
  if (Array.isArray(tool.edits)) for (const e of tool.edits) out.push(e?.new_string);
  return out.filter((t) => typeof t === 'string');
}

export const PATCH_MESSAGE = 'a patch against a permission list cannot be written (it would be applied later with git apply or patch). Describe the change to the owner instead.';

export const MESSAGE = 'permission lists change only with the owner\'s approval. Write the proposed rules to Docs/permission-patch/ and ask the owner to apply them with the grant function (run in a terminal), or to edit the file by hand.';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let blocked = null;
  try {
    const input = JSON.parse(raw);
    const tool = input.tool_input ?? {};
    const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : process.cwd();
    const target = tool.file_path ?? tool.notebook_path ?? tool.path;
    if (isPermissionFile(target, cwd)) blocked = MESSAGE;
    else if (writtenTexts(tool).some((t) => PATCH_OF_LIST.test(t))) blocked = PATCH_MESSAGE;
  } catch {
    blocked = 'unreadable hook input';
  }
  if (blocked) {
    process.stderr.write(`Blocked by .claude/hooks/protect-permissions.mjs: ${blocked}\n`);
    process.exit(2);
  }
  process.exit(0);
}
