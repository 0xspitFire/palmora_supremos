#!/usr/bin/env node
// PreToolUse(Bash) guard. Exit 2 blocks the call and shows stderr to Claude.
// Blocks destructive git/worktree commands, commands that reference secret paths, and commands that
// reference the off-limits docs backup at ~/W3/Docs (D-025).
//
// Layer 1 (text): every rule runs on the raw command and on a normalized copy (escapes decoded, home
// folded to ~, quotes and quote-adjacent '+' joins removed). A protected name that appears more often
// after normalization was split on purpose ("sec"+"rets") and is blocked on its own.
//
// Layer 2 (paths): the command is read with shell word rules (quotes, $'...', escapes, $(...), backticks,
// $((...)), redirects, heredocs). Each path word, redirect target, command-by-path, and assignment value
// is resolved from the working directory, following cd, pushd, and -C/--dir flags. ~ and wildcards count
// only where the shell would expand them (unquoted). Nested commands (bash -c, eval, xargs, ssh, sudo,
// env, timeout, command substitutions, heredocs fed to a shell) are checked the same way. Paths that
// cannot be resolved (unknown directory, or built from variables or command output) are blocked when
// they contain "..", a wildcard, or a protected name. A path that resolves to ~/W3 or any folder above it
// (/, /home, ~) is blocked unless the command only prints or tests it. Wildcards in variable values count,
// since the shell expands them where the variable is used. Every value a variable is given is checked at
// each use. A cd at or after a loop, function, alias, or trap is refused (directories follow text order).
//
// Layer 3 (protected entries anywhere, D-036): the guard asks whether entries with exact protected names
// (Rets, secrets, .env, wallets, ...) exist; it never lists a folder. A wildcard that could match one that
// exists is refused. Programs on known lists that list or walk folders are judged by where they run:
// from ~/W3, a folder above it, or an unknown folder they are refused, and a recursive one is refused
// when its folder, or any folder it names, directly holds a protected entry.
//
// Known limits (accepted, D-036): programs not on these lists that read folders; values computed at
// runtime (command output, code inside programs, file contents, read, sourced files, inherited
// environment, /proc/self paths); literal values set without NAME=value (set --, printf -v, arrays,
// ${!X}, declare -n); protected entries nested deeper than the top level of a walked folder. Only the OS
// sandbox can close these (T-002 Q1, not enabled).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_NESTING = 8;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function normalize(cmd, home = homedir()) {
  return cmd
    .replace(/\\U([0-9a-fA-F]{8})/g, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{?([0-9a-fA-F]{4})\}?/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\0([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\s*\+\s*(?=['"`])|(?<=['"`])\s*\+\s*/g, '')
    .replace(/`([^`]*)`/g, '$($1)')
    .replace(/['"\\]/g, '')
    .replace(/\$\{HOME\}|\$HOME/g, '~')
    .replace(new RegExp(`${escapeRe(home)}(?=/|\\s|$)`, 'g'), '~');
}

const MSG = {
  docs: 'off-limits docs backup ~/W3/Docs',
  rets: 'secret path Rets',
  wildcard: 'wildcard inside ~/W3 or a folder above it (can expand to secret paths)',
  root: 'listing or copying all of ~, ~/W3, or / (reaches secret paths)',
  unknownDir: 'relative path from an unknown directory (use an absolute path)',
  built: 'path built from a variable or command output (use a literal path)',
  split: 'protected name assembled from split or escaped pieces',
  tooLong: 'command too long to check (over 64 KB)',
  permFile: 'permission lists change only with the owner (propose the rules in Docs/permission-patch/ and ask the owner to apply them)',
  grantEdit: 'the grant function is run by the owner in a terminal, never by a session',
  nested: 'command nested too deeply to check',
  unstable: 'variable values keep changing across passes; too complex to check',
  unknownList: 'listing or recursive command from a folder that cannot be known here (use an absolute path or run the cd on its own first)',
  protectedEntry: 'path through a protected entry (Rets, secrets, keystore, .env, wallets)',
  protectedGlob:'wildcard can match a protected entry here (Rets, secrets, .env, wallets)',
  protectedTree: 'recursive command run from, or aimed at, a folder that holds a protected entry (Rets, secrets, .env, wallets); cd into a subfolder first, or use the Grep or Glob tool',
  loopCd:'cd after a loop, function, or trap starts (run the cd as its own command first, or use absolute paths)',
};

// Destructive commands, checked one simple command at a time: program, then subcommand, then flag.
// Each step is a single linear search, so a long command cannot make the check slow.
const destructive = [
  [/\bgit\b/, /\bpush\b/, /--force|--mirror|--delete|\s-[a-zA-Z]*f\b|\s\+\S/, 'force or deleting push'],
  [/\bgit\b/, /\breset\b/, /--hard/, 'git reset --hard'],
  [/\bgit\b/, /\bclean\b/, /\s-[a-zA-Z]*f/, 'git clean -f'],
  [/\bgit\b/, /\bbranch\b/, /\s-[a-zA-Z]*[dD]\b|--delete/, 'branch deletion'],
  [/\bgit\b/, /\bworktree\b/, (t) => /\bprune\b/.test(t) || (t.search(/\bremove\b/) >= 0 && /\s(--force|-f)\b/.test(t.slice(t.search(/\bremove\b/)))), 'forced worktree removal or prune'],
  [/\brm\b/, /\s-[a-zA-Z]*[rR]/, /worktrees|MintBot-wt/, 'rm -r on a worktree folder'],
];
function destructiveCommand(text) {
  for (const seg of text.split(/[;&|\n]/)) {
    for (const [program, sub, flag, why] of destructive) {
      const p = seg.search(program);
      if (p < 0) continue;
      const rest = seg.slice(p);
      const s = rest.search(sub);
      const tail = s >= 0 ? rest.slice(s) : null;
      if (tail !== null && (typeof flag === 'function' ? flag(tail) : flag.test(tail))) return why;
    }
  }
  return null;
}

const rules = [
  [/(^|[^\w.-])(\.\/)?Rets(\/|\s|$)|W3\/Rets/, MSG.rets],
  [/(^|\W)secrets\//, 'secret path secrets/'],
  [/(?<!process)\.(env|key)(?=[\s;&|)]|$)|(^|[\s/=:])\.env\.\w|keystore\/|wallets\.(enc|json)/, 'secret file (.env, .key, keystore, wallets)'],
  [/W3\/Docs(?=[\/\s;&|)]|$)/, MSG.docs],
  [/W3\/[^\/\s]*[*?[{]/, MSG.wildcard],
];

// Names that must never be assembled from pieces. Each is counted separately in raw and normalized text.
const protectedNames = [/secrets/g, /Rets/g, /keystore/g, /wallets\.(enc|json)/g, /(?<!process)\.env\b/g, /\.key\b/g, /W3\/Docs/g, /grant-edit/g];
const grew = (raw, norm) => protectedNames.some((re) => (norm.match(re) ?? []).length > (raw.match(re) ?? []).length);

// ---------------------------------------------------------------------------------------------------
// Shell word reader.
// A word is { v, dynamic, glob, tilde0, tildeEq }: v is the text after quote removal; dynamic means it
// contains a variable or command output ($NAME, $SUB); glob means an unquoted * ? [ or {a,b}; tilde0 and
// tildeEq mean an unquoted ~ at the start or right after the first = (assignment).
// ---------------------------------------------------------------------------------------------------

const OP = /^(?:\d*(?:<<<|<<-|<<|<>|>>|>\||<&|>&|&>>|&>|<|>)|&&|\|\||\|&|;;|[;&|()\n])/;
const WORD_END = /[\s;&|()<>]/;

function decodeAnsiC(s) {
  const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  return s.replace(/\\(U[0-9a-fA-F]{1,8}|u[0-9a-fA-F]{1,4}|x[0-9a-fA-F]{1,2}|[0-7]{1,3}|c.|.)/g, (m, e) => {
    if (/^[Uux]/.test(e) && e.length > 1) return String.fromCodePoint(Math.min(parseInt(e.slice(1), 16), 0x10ffff));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xff);
    if (e[0] === 'c') return String.fromCharCode(e.charCodeAt(1) & 0x1f);
    return simple[e] ?? m;
  });
}

// Read heredoc bodies that start at index j (just after a newline) for each pending delimiter.
function readHeredocBodies(src, j, pending) {
  for (const h of pending) {
    const lines = [];
    while (j < src.length) {
      const nl = src.indexOf('\n', j);
      const line = src.slice(j, nl < 0 ? src.length : nl);
      j = nl < 0 ? src.length : nl + 1;
      if ((h.dash ? line.replace(/^\t+/, '') : line) === h.delim) break;
      lines.push(line);
    }
    h.body = lines.join('\n');
  }
  return j;
}

// Skip a balanced (...) starting at src[i] === '(' and return [inner, next]. Quotes and heredocs inside
// are honored so parentheses in strings or heredoc text do not end it early.
function captureParens(src, i) {
  let depth = 0;
  let j = i;
  const pending = [];
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", j + 1); j = e < 0 ? src.length : e + 1; continue; }
    if (c === '"') { j = readDouble(src, j).next; continue; }
    if (c === '`') { const e = src.indexOf('`', j + 1); j = e < 0 ? src.length : e + 1; continue; }
    if (c === '<' && src[j + 1] === '<' && src[j + 2] !== '<') {
      const m = src.slice(j).match(/^<<(-?)\s*(['"]?)([^\s'"<>;&|()]+)\2/);
      if (m) { pending.push({ delim: m[3], dash: m[1] === '-' }); j += m[0].length; continue; }
    }
    if (c === '\n' && pending.length) { j = readHeredocBodies(src, j + 1, pending.splice(0)); continue; }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return [src.slice(i + 1, j), j + 1]; }
    j += 1;
  }
  return [src.slice(i + 1), src.length];
}

// Read a $-expansion at src[i] === '$'. Returns { text, subs, next }.
function readDollar(src, i) {
  const n = src[i + 1];
  if (n === '(' && src[i + 2] === '(') { const [, next] = captureParens(src, i + 1); return { text: '$ARITH', subs: [], next }; }
  if (n === '(') { const [inner, next] = captureParens(src, i + 1); return { text: '$SUB', subs: [inner], next }; }
  if (n === '{') { const e = src.indexOf('}', i + 2); const end = e < 0 ? src.length : e + 1; return { text: src.slice(i, end), subs: [], next: end }; }
  const m = src.slice(i + 1).match(/^([A-Za-z_]\w*|[?#@*!$0-9-])/);
  // Written as ${NAME} so a following quoted part stays separate: "$X"ets is ${X}ets, not $Xets.
  if (m) return { text: `\${${m[1]}}`, subs: [], next: i + 1 + m[1].length };
  return { text: '$', subs: [], next: i + 1, literal: true };
}

// Read "..." starting at src[i] === '"'. Returns { text, dynamic, subs, next }.
function readDouble(src, i) {
  let j = i + 1;
  let text = '';
  let dynamic = false;
  const subs = [];
  while (j < src.length && src[j] !== '"') {
    const c = src[j];
    if (c === '\\' && j + 1 < src.length) {
      const n = src[j + 1];
      if (n === '\n') { j += 2; continue; }
      text += '$`"\\'.includes(n) ? n : c + n;
      j += 2;
    } else if (c === '$') {
      const d = readDollar(src, j);
      text += d.text; subs.push(...d.subs); dynamic ||= !d.literal; j = d.next;
    } else if (c === '`') {
      const e = src.indexOf('`', j + 1);
      const end = e < 0 ? src.length : e;
      subs.push(src.slice(j + 1, end)); text += '$SUB'; dynamic = true; j = end + 1;
    } else {
      text += c; j += 1;
    }
  }
  return { text, dynamic, subs, next: j + 1 };
}

// Split a command string into tokens: { op } or { word }. Also returns command substitutions found.
export function lex(src) {
  const tokens = [];
  const subs = [];
  let pending = [];
  let i = 0;
  let atWordStart = true;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      tokens.push({ op: '\n' });
      i += 1;
      if (pending.length) { i = readHeredocBodies(src, i, pending); pending = []; }
      atWordStart = true;
      continue;
    }
    if (c === ' ' || c === '\t') { i += 1; atWordStart = true; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#' && atWordStart) { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const [inner, next] = captureParens(src, i + 1);
      subs.push(inner);
      tokens.push({ word: { v: '$SUB', dynamic: true, glob: false, tilde0: false, tildeEq: false, subs: [inner] } });
      i = next;
      continue;
    }
    const op = src.slice(i).match(OP);
    if (op) {
      const t = { op: op[0] };
      tokens.push(t);
      i += op[0].length;
      if (/^\d*<<-?$/.test(op[0])) {
        const m = src.slice(i).match(/^[ \t]*((['"])([^'"\n]*)\2|\\?([^\s;&|()<>]+))/);
        if (m) {
          t.heredoc = { delim: m[3] ?? m[4], dash: op[0].endsWith('-'), quoted: Boolean(m[2]) || m[1].startsWith('\\'), body: '' };
          pending.push(t.heredoc);
          i += m[0].length;
        }
      }
      atWordStart = true;
      continue;
    }
    // A word: concatenate parts until an unquoted separator. w.subs keeps this word's own substitutions.
    const w = { v: '', dynamic: false, glob: false, tilde0: false, tildeEq: false, subs: [] };
    const before = subs.length;
    let braceOpen = false;
    while (i < src.length && (!WORD_END.test(src[i]) || (src[i] === '(' && /[@!+*?]$/.test(w.v)))) {
      const ch = src[i];
      // Extended glob group such as @(R)ets: keep it inside the word as a wildcard.
      if (ch === '(') { const [inner, next] = captureParens(src, i); w.v += `(${inner})`; w.glob = true; i = next; continue; }
      if (ch === "'") {
        const e = src.indexOf("'", i + 1);
        const end = e < 0 ? src.length : e;
        w.v += src.slice(i + 1, end); i = end + 1;
      } else if (ch === '$' && src[i + 1] === "'") {
        let j = i + 2;
        while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
        w.v += decodeAnsiC(src.slice(i + 2, j)); i = j + 1;
      } else if (ch === '"') {
        const d = readDouble(src, i);
        w.v += d.text; w.dynamic ||= d.dynamic; subs.push(...d.subs); i = d.next;
      } else if (ch === '$') {
        const d = readDollar(src, i);
        w.v += d.text; w.dynamic ||= !d.literal; subs.push(...d.subs); i = d.next;
      } else if (ch === '`') {
        const e = src.indexOf('`', i + 1);
        const end = e < 0 ? src.length : e;
        subs.push(src.slice(i + 1, end)); w.v += '$SUB'; w.dynamic = true; i = end + 1;
      } else if (ch === '\\') {
        w.v += src[i + 1] ?? ''; i += 2;
      } else {
        if (ch === '~' && (w.v === '' || (w.v.indexOf('=') === w.v.length - 1 && /^\w+=$/.test(w.v)))) {
          if (w.v === '') w.tilde0 = true; else w.tildeEq = true;
        }
        if ('*?['.includes(ch)) w.glob = true;
        if (ch === '{') braceOpen = true;
        if (braceOpen && (ch === ',' || (ch === '.' && src[i + 1] === '.'))) { w.glob = true; w.brace = true; }
        w.v += ch; i += 1;
      }
    }
    w.subs = subs.slice(before);
    tokens.push({ word: w });
    atWordStart = false;
  }
  return { tokens, subs };
}

// Group tokens into pipelines of simple commands: { words, redirects, heredocs }.
function parse(tokens) {
  const pipelines = [];
  let pipeline = [];
  let cmd = { words: [], redirects: [], heredocs: [] };
  const endCmd = () => { if (cmd.words.length || cmd.redirects.length || cmd.heredocs.length) pipeline.push(cmd); cmd = { words: [], redirects: [], heredocs: [] }; };
  const endPipeline = () => { endCmd(); if (pipeline.length) pipelines.push(pipeline); pipeline = []; };
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.word) { cmd.words.push(t.word); continue; }
    if (t.heredoc) { cmd.heredocs.push(t.heredoc); continue; }
    // "name ()" defines a function; mark it where it appears so order against cd is known.
    if (t.op === '(' && tokens[k + 1]?.op === ')' && cmd.words.length === 1) { cmd.funcDef = true; k += 1; endPipeline(); continue; }
    if (t.op === '|' || t.op === '|&') { endCmd(); continue; }
    const redirect = t.op.match(/^\d*(<<<|<>|>>|>\||<&|>&|&>>|&>|<|>)$/);
    if (redirect) {
      const target = tokens[k + 1]?.word;
      if (target) {
        k += 1;
        const fdDup = /&$/.test(redirect[1]) && /^(\d+|-)$/.test(target.v) && !target.dynamic;
        // Input redirects only read; every other kind can write, so it is tagged for the permission check.
        const reads = redirect[1] === '<' || redirect[1] === '<&';
        if (redirect[1] !== '<<<' && !fdDup) cmd.redirects.push(reads ? target : { ...target, write: true });
      }
      continue;
    }
    endPipeline();
  }
  endPipeline();
  return pipelines;
}

// ---------------------------------------------------------------------------------------------------
// Path analysis.
// ---------------------------------------------------------------------------------------------------

// Commands that only print or test a path; they may name /, ~, or ~/W3.
// tr, sed, awk and cut take "/" as a character or delimiter and cannot walk a directory tree.
// Permission lists (T-019): programs that only read may name them; anything else may not. Interpreters
// can write from script text, so their words are also searched for the file names.
const PERMISSION_READ_ONLY = new Set(['cat', 'head', 'tail', 'nl', 'wc', 'stat', 'ls', 'file', 'diff', 'cmp', 'grep', 'egrep', 'fgrep', 'rg', 'jq',
  'sha256sum', 'sha1sum', 'md5sum', 'realpath', 'readlink', 'dirname', 'basename', 'test', '[', '[[', 'echo', 'printf', 'cd', 'pwd', 'true', ':']);
const PERMISSION_GIT_READ = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'check-ignore', 'blame', 'add', 'commit']);
// git diff, log and show write a file with --output, so they are not read-only then.
const permissionReadOnly = (name, sub, args = []) => PERMISSION_READ_ONLY.has(name)
  || (name === 'git' && PERMISSION_GIT_READ.has(sub) && !args.some((a) => /^--output(=|$)/.test(a.v)));
// find and fd can pick files by pattern and then delete or run commands on them.
const FIND_ACTIONS = /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;
const FD_ACTIONS = /^(-x|-X|--exec|--exec-batch)$/;
// find name tests, and whether an expression could match a permission list (AND of the tests; any -o or
// parenthesis makes it assume yes; -path and -regex forms are not analysed and count as a match).
const FIND_NAME_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex']);
function findCouldMatchList(args, exprAt) {
  const expr = exprAt === -1 ? [] : args.slice(exprAt);
  if (expr.some((a) => a.v === '-o' || a.v === '-or' || a.v === '(')) return true;
  const tests = [];
  for (let k = 0; k < expr.length - 1; k += 1) if (FIND_NAME_TESTS.has(expr[k].v)) tests.push([expr[k].v, expr[k + 1].v]);
  if (!tests.length) return true;
  return tests.every(([flag, value]) => {
    if (flag === '-name') return matchesListName(value);
    if (flag === '-iname') {
      const low = value.toLowerCase();
      return PERMISSION_NAMES.some((n) => (GLOB_SEGMENT.test(low) ? globRegex(low).test(n) : low === n)) || low.includes('.claude');
    }
    return true;
  });
}
// fd: its pattern cannot be told from its command words, so only an extension filter can rule a match out.
function fdCouldMatchList(args) {
  const exts = [];
  for (let k = 0; k < args.length; k += 1) {
    if ((args[k].v === '-e' || args[k].v === '--extension') && args[k + 1]) exts.push(args[k + 1].v.toLowerCase());
    else if (args[k].v.startsWith('--extension=')) exts.push(args[k].v.slice(12).toLowerCase());
  }
  return exts.length === 0 || exts.includes('json');
}
const matchesListName = (v) => PERMISSION_NAMES.some((n) => v === n || (GLOB_SEGMENT.test(v) && globRegex(v).test(n))) || PERMISSION_TEXT.test(v) || v.includes('.claude');
// Text that names a permission list (settings.json or settings.local.json, not claude-code-settings.json).
const PERMISSION_TEXT = /(^|[^A-Za-z0-9_-])settings(\.local)?\.json/;
// A patch against a permission list (git apply, patch, git am would write it): diff header lines.
const PATCH_OF_LIST = /(^|\n)[ \t]*(\+\+\+ |--- |diff --git |rename (to|from) |copy (to|from) ).*\.claude\/settings(\.local)?\.json/;
const PERMISSION_NAMES = ['settings.json', 'settings.local.json'];
const harmless = new Set(['cd', 'echo', 'printf', 'test', '[', '[[', 'pwd', 'realpath', 'dirname', 'basename', 'true', ':', 'which', 'type', 'tr', 'sed', 'awk', 'cut']);
// Commands that read the current directory when given no path.
const listingTools = new Set(['find', 'ls', 'dir', 'vdir', 'eza', 'exa', 'lsd', 'tree', 'du', 'rg', 'grep', 'egrep', 'fgrep', 'ugrep', 'zgrep', 'pcregrep', 'fd', 'ag', 'ack',
  'tar', 'bsdtar', 'pax', 'zip', '7z', '7za', '7zz', 'rsync', 'cp', 'scp', 'diff', 'locate', 'ctags', 'getfacl', 'gzip']);
// Search tools whose first non-flag word is the pattern, not a path.
const patternFirst = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ugrep', 'zgrep', 'pcregrep', 'ag', 'ack', 'fd']);
const shells = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
// Loop and function keywords (a command can run again, or later, from a different directory), and the
// commands that change directory.
const loopWords = new Set(['for', 'while', 'until', 'select', 'function']);
const dirMovers = new Set(['cd', 'pushd', 'popd']);
const dirFlags = new Set(['-C', '--dir', '--directory', '--cwd']);
const declarers = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);
// The program a word names: its file name (/usr/bin/env -> env).
const baseName = (v) => v.slice(v.lastIndexOf('/') + 1);
// Words that can precede the real command.
const prefixWords = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'done', 'fi', 'while', 'until', 'time', 'command', 'builtin', 'exec', 'nohup']);
// Wrappers whose own flags come before the real command; the set lists flags that take a value.
// A wrapper's own positional words (a lock file, a priority, a CPU mask) are skipped by `skip`.
const wrappers = {
  busybox: new Set(),
  setsid: new Set(),
  unbuffer: new Set(),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid']),
  flock: new Set(['-w', '-E', '--timeout', '--conflict-exit-code']),
  chrt: new Set(['-p', '-T', '-P', '-D']),
  taskset: new Set(['-p']),
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']),
  env: new Set(['-u', '-C', '-S', '--chdir', '--unset', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set(['-I', '-i', '-n', '-d', '-P', '-L', '-l', '-s', '-a', '-E', '-e', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace']),
  stdbuf: new Set(['-i', '-o', '-e']),
};
// Programs whose heredoc body is data or code for that program, not shell.
const heredocDataReaders = new Set(['python', 'python3', 'node', 'cat', 'tee', 'sqlite3', 'jq', 'awk', 'sed', 'wc', 'sort', 'head', 'tail', 'grep', 'git', 'gh']);
const sshValueFlags = new Set(['-p', '-i', '-o', '-l', '-J', '-F', '-b', '-c', '-D', '-E', '-L', '-R', '-S', '-W', '-w', '-m', '-O', '-Q', '-B', '-e', '-I']);

// Names that are secret wherever they sit (the repo's own Rets/ included; see .gitignore). The guard only
// asks whether an entry with one of these exact names exists; it never lists a directory.
const protectedEntries = ['Rets', 'secrets', 'keystore', 'wallets', 'wallets.enc', 'wallets.json', 'MINT_BOT_SECRETS', 'TEST_BOT',
  '.env', '.env.local', '.env.development', '.env.production', '.env.test'];

// A path segment that the shell would expand: * ? [ or an extended glob group like @(x).
const GLOB_SEGMENT = /[*?[{]|[@!+](\()/;

// A shell glob segment as a regex. Like bash without dotglob, a leading * ? or [ never matches a dot.
function globRegex(seg) {
  // Extended globs (@(..), !(..), +(..), *(..), ?(..)) can match nearly anything: treat as any name.
  if (/[@!+*?]\(/.test(seg)) return seg.startsWith('.') ? /^/ : /^(?!\.)/;
  let re = '';
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      // A bracket expression ends at the first ] after its first character; [:class:], [.x.] and [=x=]
      // inside it are read whole. Any of those makes it "any one character" (never narrower).
      let j = i + 1;
      if (seg[j] === '!' || seg[j] === '^') j += 1;
      if (seg[j] === ']') j += 1;
      let posix = false;
      while (j < seg.length && seg[j] !== ']') {
        const inner = seg.slice(j).match(/^\[([:.=])[^\]]*?\1\]/);
        if (inner) { posix = true; j += inner[0].length; } else j += 1;
      }
      if (j >= seg.length) { re += '\\['; continue; }
      const body = seg.slice(i + 1, j);
      re += posix ? '[^/]' : `[${body.replace(/^[!^]/, '^').replace(/\\/g, '\\\\').replace(/\[/g, '\\[')}]`;
      i = j;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  const dotSafe = seg.startsWith('.') ? '' : '(?!\\.)';
  try { return new RegExp(`^${dotSafe}${re}$`); } catch { return /^/; }
}

// Commands that walk directory trees, and the flags that make the others recursive.
const alwaysRecursive = new Set(['find', 'rg', 'ag', 'ack', 'fd', 'du', 'tree', 'rsync', '7z', '7za', '7zz', 'pax', 'locate']);
// Short flags that make each command recursive (ls -a, grep -a, and similar are not).
const recursiveFlags = {
  grep: 'rR', egrep: 'rR', fgrep: 'rR', ugrep: 'rR', zgrep: 'rR', pcregrep: 'rR', cp: 'rRa', scp: 'r', ls: 'R', dir: 'R', vdir: 'R',
  eza: 'RT', exa: 'RT', lsd: 'R', zip: 'r', chmod: 'R', chown: 'R', diff: 'r', gzip: 'r', ctags: 'R', getfacl: 'R',
};
const isRecursive = (name, args) => {
  if (alwaysRecursive.has(name)) return true;
  // tar and bsdtar walk folders only when creating, appending, or updating an archive.
  if (name === 'tar' || name === 'bsdtar') {
    const mode = args.find((a) => !/^--?[a-zA-Z]/.test(a.v) || /^-?[a-zA-Z]+$/.test(a.v))?.v ?? '';
    return /^-?[a-zA-Z]*[cru]/.test(mode) || args.some((a) => /^--(create|append|update)$/.test(a.v));
  }
  // grep -d recurse / --directories=recurse, and ugrep/eza long forms.
  if (args.some((a, k) => /^--(directories=recurse|recurse|tree)$/.test(a.v) || /^-drecurse$/.test(a.v) || (a.v === '-d' && args[k + 1]?.v === 'recurse'))) return true;
  const letters = Object.hasOwn(recursiveFlags, name) ? recursiveFlags[name] : undefined;
  if (!letters) return false;
  // Combined short flags may carry a value (-rA3, -rm1): any recursion letter in the token counts.
  return args.some((a) => (/^-[a-zA-Z][a-zA-Z0-9]*$/.test(a.v) && [...a.v.slice(1)].some((c) => letters.includes(c)))
    || /^--(recursive|archive|dereference-recursive)$/.test(a.v));
};

const wrapperFor = (name) => (Object.hasOwn(wrappers, name) ? wrappers[name] : undefined);

function makeJudge(home, exists = existsSync) {
  const w3 = `${home}/W3`;
  const under = (p, root) => p === root || p.startsWith(`${root}/`);
  // ~/W3 and every folder above it: searching or copying any of them reaches ~/W3/Rets and ~/W3/Docs.
  const roots = { has: (p) => p === '/' || (typeof p === 'string' && under(w3, p)) };
  // Every value each variable is given anywhere in the command: name -> [{ v, glob, dynamic }]. A use of
  // $name is checked against all of them, so order, subshells, pipelines, and later reassignment can
  // only add blocks, never hide a value.
  const vars = new Map();
  // \u0001 marks a ${NAME<op>} form whose result cannot be worked out (it may trim, slice, or recase).
  const DYNAMIC = /\$(SUB|ARITH|[A-Za-z_{?#@*!$0-9-])|\u0001/;
  // Put known variable values in place. Returns one word per combination of values, or null when there
  // would be more than 256. A value's wildcard characters count wherever it is used.
  const substituteAll = (w) => {
    if (!w.dynamic) return [w];
    const out = [];
    const walk = (v, glob) => {
      if (out.length > 256) return;
      const re = /\$\{(\w+)([^}]*)\}|\$([A-Za-z_]\w*)/g;
      let hit = null;
      let opaque = false;
      for (let m = re.exec(v); m; m = re.exec(v)) {
        const name = m[1] ?? m[3];
        const op = m[2] ?? '';
        // A known variable is substituted; an operator form on a known variable, or one carrying letters
        // (a default or replacement text), cannot be worked out and is marked opaque.
        if (vars.has(name) && !op) { hit = m; break; }
        if (op && (vars.has(name) || /[A-Za-z.]/.test(op))) { hit = m; opaque = true; break; }
      }
      if (!hit) { out.push({ ...w, v, glob, dynamic: DYNAMIC.test(v), derived: w.derived || v !== w.v }); return; }
      const before = v.slice(0, hit.index);
      const after = v.slice(hit.index + hit[0].length);
      // An unset-default form on a variable with no known value (${X:-word}, ${X-word}, ${X:=word},
      // ${X:+word}) is either the word or the unknown value (or empty): check each.
      const dflt = !vars.has(hit[1] ?? hit[3]) && (hit[2] ?? '').match(/^:?([-=+])(.*)$/);
      if (dflt) {
        walk(before + dflt[2] + after, glob || /[*?[]/.test(dflt[2]));
        walk(`${before}${dflt[1] === '+' ? '' : '$UNKNOWN'}${after}`, glob);
        return;
      }
      if (opaque) { walk(`${before}\u0001${after}`, glob); return; }
      for (const x of vars.get(hit[1] ?? hit[3])) walk(before + (x.dynamic ? '$UNKNOWN' : x.v) + after, glob || x.glob);
    };
    walk(w.v, w.glob);
    return out.length > 256 ? null : out;
  };
  // Expand what the shell would expand from known state. Returns null when the value is not knowable.
  // The word must already have its variables substituted.
  const expand = (w, base) => {
    let v = w.v;
    if (w.tilde0) {
      const t = v.match(/^~([^/]*)(\/[\s\S]*)?$/);
      if (t === null) return null;
      if (t[1] === '') v = home + (t[2] ?? '');
      else if (t[1] === '+') { if (base === null) return null; v = base + (t[2] ?? ''); } else return null;
    }
    const here = v.match(/^(\$PWD|\$\{PWD\}|\$HOME|\$\{HOME\})(\/[\s\S]*)?$/);
    if (here) {
      const isHome = here[1].includes('HOME');
      if (!isHome && base === null) return null;
      v = (isHome ? home : base) + (here[2] ?? '');
    }
    if (DYNAMIC.test(v)) return null;
    return v;
  };
  const locateOne = (w, base) => {
    const e = expand(w, base);
    if (e === null || e === '') return null;
    if (isAbsolute(e)) return resolve(e);
    return base === null ? null : resolve(base, e);
  };
  const risky = (w) => {
    const q = w.v.replace(/\$\{[^}]*\}|\$(SUB|ARITH|[\w?#$!*@-]+)/g, '\u0000');
    return /(^|\/)\.\.(\/|$)/.test(q) || w.glob || q.split('/').some((s) => {
      if (s.includes('\u0001')) return true;
      if (s === 'Docs' || s === 'Rets' || s === 'secrets' || protectedEntries.includes(s)) return true;
      // Unknown text joined to literal text ("${X:-R}ets", "$(echo R)ets") could spell a protected name.
      if (!s.includes('\u0000') || s === '\u0000') return false;
      const re = new RegExp(`^${s.split('\u0000').map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return ['Docs', ...protectedEntries].some((n) => re.test(n));
    });
  };
  // Every concrete word a word can become: variable values first, then brace expansion (bash expands
  // braces before variables, but the values here are literal text either way). Null when too many.
  const alternatives = (w) => {
    const subs = substituteAll(w);
    if (subs === null) return null;
    const out = [];
    for (const s of subs) {
      if (!s.brace) { out.push(s); continue; }
      const expanded = expandBraces(s.v, 256);
      if (expanded === null) return null;
      for (const v of expanded) out.push({ ...s, v, brace: false, glob: /[*?[]/.test(v), tilde0: s.tilde0 || v.startsWith('~'), derived: true });
      if (out.length > 256) return null;
    }
    return out;
  };
  // Where a word points, when every alternative points to the same place; otherwise unknown (null).
  const locate = (w, base) => {
    const alts = alternatives(w);
    if (!alts || !alts.length) return null;
    const places = alts.map((a) => locateOne(a, base));
    return places.every((p) => p === places[0]) ? places[0] : null;
  };
  // Judge a word as a path from base. allowRoot lets harmless commands name /, ~, or ~/W3.
  const judge = (w, base, allowRoot) => {
    const alts = alternatives(w);
    if (alts === null) return MSG.built;
    for (const a of alts) { const why = judgeOne(a, base, allowRoot); if (why) return why; }
    return null;
  };
  // Remember an assignment's values (after ~ expansion) for later $name uses in this command.
  const assign = (name, valueWord, base) => {
    const list = vars.get(name) ?? [];
    for (const w of alternatives(valueWord) ?? [{ ...valueWord, dynamic: true }]) {
      const e = expand(w, base);
      const entry = { v: e ?? w.v, glob: w.glob, dynamic: e === null };
      if (!list.some((x) => x.v === entry.v && x.glob === entry.glob && x.dynamic === entry.dynamic)) list.push(entry);
    }
    vars.set(name, list);
  };
  const judgeOne = (w, base, allowRoot) => {
    if (w.v === '' || w.v === '-') return null;
    const abs = locateOne(w, base);
    if (abs === null) {
      if (!risky(w)) return null;
      return expand(w, base) === null ? MSG.built : MSG.unknownDir;
    }
    if (under(abs, `${w3}/Docs`)) return MSG.docs;
    if (under(abs, `${w3}/Rets`)) return MSG.rets;
    if (w.glob) {
      // The fixed part before the first wildcard segment: if it is ~/W3 or any folder above it, the
      // wildcard can match W3, Rets, or Docs (~/*, /home/*, /*, ~/W3/R*).
      const parts = abs.split('/');
      const first = parts.findIndex((s) => GLOB_SEGMENT.test(s));
      const prefix = first < 0 ? abs : parts.slice(0, first).join('/') || '/';
      if (roots.has(prefix)) return MSG.wildcard;
    }
    // A protected name that brace expansion or a variable produced (typed names are the text rules' job;
    // a typed word like a grep pattern "secrets" is not a path).
    if (w.derived && abs.split('/').some((s) => protectedEntries.includes(s))) return MSG.protectedEntry;
    if (w.glob && globHitsProtected(abs)) return MSG.protectedGlob;
    if (!allowRoot && roots.has(abs)) return MSG.root;
    return null;
  };
  // True when a wildcard segment could match a protected entry: one that exists in a fixed parent, or
  // any protected name when the parent itself has a wildcard (it cannot be checked without listing).
  const globHitsProtected = (abs) => {
    const parts = abs.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      if (!GLOB_SEGMENT.test(parts[i])) continue;
      const re = globRegex(parts[i]);
      const parent = parts.slice(0, i).join('/') || '/';
      const parentFixed = !GLOB_SEGMENT.test(parent);
      for (const n of protectedEntries) if (re.test(n) && (!parentFixed || exists(`${parent === '/' ? '' : parent}/${n}`))) return true;
    }
    return false;
  };
  // True when dir directly holds an entry with a protected name.
  const holdsProtected = (dir) => typeof dir === 'string' && protectedEntries.some((n) => exists(`${dir === '/' ? '' : dir}/${n}`));
  // Total number of remembered values; when a pass adds none, every use has seen every assignment.
  const knownValues = () => [...vars.values()].reduce((n, list) => n + list.length, 0);
  // Does this word point at a permission list (settings.json or settings.local.json inside a .claude
  // folder) or at the .claude folder itself? Variables, braces and wildcards count; an unknown
  // directory counts when the word is a bare file name.
  const permissionAt = (abs) => {
    const parts = abs.split('/');
    const last = parts[parts.length - 1];
    const dir = parts[parts.length - 2];
    const lastRe = GLOB_SEGMENT.test(last) ? globRegex(last) : null;
    const dirRe = dir !== undefined && GLOB_SEGMENT.test(dir) ? globRegex(dir) : null;
    const dirOk = dir !== undefined && (dirRe ? dirRe.test('.claude') : dir === '.claude');
    const lastIsFile = lastRe ? PERMISSION_NAMES.some((n) => lastRe.test(n)) : PERMISSION_NAMES.includes(last);
    const lastIsFolder = lastRe ? lastRe.test('.claude') : last === '.claude';
    return (dirOk && lastIsFile) || lastIsFolder;
  };
  const touchesPermissionFile = (word, base) => {
    const alts = alternatives(word);
    if (alts === null) return false;
    for (const a of alts) {
      // A value written as NAME=path or --flag=path (dd of=..., --output=...) names a path too.
      const eq = a.v.match(/^-{0,2}[A-Za-z_][\w-]*=(.+)$/);
      for (const w of eq ? [a, { ...a, v: eq[1], tilde0: false }] : [a]) {
        const abs = locateOne(w, base);
        if (abs !== null) { if (permissionAt(abs)) return true; continue; }
        const parts = w.v.split('/');
        const last = parts[parts.length - 1];
        if ((PERMISSION_NAMES.includes(last) && (parts.length === 1 || parts[parts.length - 2] === '.claude' || /\$|\u0000/.test(parts[parts.length - 2]))) || last === '.claude') return true;
      }
    }
    return false;
  };
  // Does this word name the grant function (T-019)? Plain text, braces, variables and wildcards count; a
  // wildcard counts when its folder is the hooks folder (or cannot be told).
  const touchesGrantFunction = (word, base) => {
    const alts = alternatives(word);
    if (alts === null) return false;
    for (const a of alts) {
      if (/grant-edit/.test(a.v)) return true;
      const last = a.v.split('/').pop();
      if (!GLOB_SEGMENT.test(last) || !globRegex(last).test('grant-edit.mjs')) continue;
      const abs = locateOne(a, base);
      if (abs === null) return true;
      const parent = abs.split('/').slice(-2, -1)[0];
      if (parent === undefined || (GLOB_SEGMENT.test(parent) ? globRegex(parent).test('hooks') : parent === 'hooks')) return true;
    }
    return false;
  };
  return { judge, locate, roots, assign, knownValues, holdsProtected, alternatives, touchesPermissionFile, touchesGrantFunction };
}

// Bash brace expansion: {a,b,c} lists and {x..y} ranges of single letters or integers, nested, left to
// right. Returns null when the result would exceed limit words.
function expandBraces(s, limit) {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '{') { if (depth === 0) open = i; depth += 1; }
    else if (s[i] === '}' && depth > 0) {
      depth -= 1;
      if (depth > 0) continue;
      const body = s.slice(open + 1, i);
      const pre = s.slice(0, open);
      const post = s.slice(i + 1);
      let items = null;
      const parts = [];
      let d = 0;
      let last = 0;
      for (let k = 0; k < body.length; k += 1) {
        if (body[k] === '{') d += 1;
        else if (body[k] === '}') d -= 1;
        else if (body[k] === ',' && d === 0) { parts.push(body.slice(last, k)); last = k + 1; }
      }
      if (parts.length) items = [...parts, body.slice(last)];
      const range = body.match(/^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(\.\.-?\d+)?$/);
      if (!items && range) {
        const num = /\d/.test(range[1]);
        const a = num ? Number(range[1]) : range[1].charCodeAt(0);
        const b = num ? Number(range[2]) : range[2].charCodeAt(0);
        if (Math.abs(b - a) >= limit) return null;
        items = [];
        for (let x = a; a <= b ? x <= b : x >= b; x += a <= b ? 1 : -1) items.push(num ? String(x) : String.fromCharCode(x));
      }
      if (!items) continue;
      const out = [];
      for (const it of items) {
        const rest = expandBraces(pre + it + post, limit);
        if (rest === null) return null;
        out.push(...rest);
        if (out.length > limit) return null;
      }
      return out;
    }
  }
  return [s];
}

const lit = (v) => ({ v, dynamic: false, glob: false, tilde0: false, tildeEq: false, subs: [] });
const valueOf = (w) => {
  const eq = w.v.indexOf('=');
  // No expansion happens at assignment, but an unquoted $var expands the value's wildcards where it is
  // used, so any wildcard character in the value counts, quoted or not.
  const v = w.v.slice(eq + 1);
  return { ...w, v, glob: /[*?[]/.test(v), tilde0: w.tildeEq, tildeEq: false };
};

// Analyze a command string from dir. Returns { why, dir }. forceShell treats every heredoc body as shell.
function analyze(src, startDir, ctx, depth, forceShell = false) {
  if (depth > MAX_NESTING) return { why: MSG.nested, dir: startDir };
  const { tokens, subs } = lex(src);
  const { judge, locate, roots, home, assign } = ctx;
  // Judge an assignment's value, then remember it for later $name uses.
  const setVar = (w, base) => { const v = valueOf(w); const why = judge(v, base, false); if (!why) assign(w.v.slice(0, w.v.indexOf('=')), v, base); return why; };
  const nested = (s, d, force) => analyze(s, d, ctx, depth + 1, force);
  let dir = startDir;
  const seenDirs = [dir];

  for (const pipeline of parse(tokens)) {
    // A later pipeline stage that runs stdin as shell makes earlier heredoc bodies shell too.
    const names = pipeline.map((c) => {
      const w = c.words.find((x) => !/^\w+=/.test(x.v) && !prefixWords.has(baseName(x.v)));
      return w && baseName(w.v);
    });
    // A permission-list name passed down a pipe (printf ... | xargs rm) may only reach read-only programs.
    let upstream = false;
    for (let p = 0; p < pipeline.length; p += 1) {
      const stdinIsShell = names.slice(p + 1).some((n) => shells.has(n) || n === 'xargs' || n === 'source' || n === '.' || n === 'eval');
      // Loops, functions, and traps can run a command after a directory change written later in the
      // text. Directories are followed in text order, so a directory change at or after the first of
      // these is refused (ctx.cdAfterLoop). A command name built from a variable could be cd or eval.
      const words = pipeline[p].words;
      let lead = 0;
      while (lead < words.length && (prefixWords.has(baseName(words[lead].v)) || /^\w+=/.test(words[lead].v))) {
        if (loopWords.has(words[lead].v)) ctx.sawLoop = true;
        lead += 1;
      }
      const head = words[lead];
      // An alias, like a function or trap, is code defined now that runs later from another directory.
      if (pipeline[p].funcDef || loopWords.has(head?.v) || head?.v === 'trap' || head?.v === 'alias') ctx.sawLoop = true;
      if (head && (dirMovers.has(head.v) || head.dynamic) && ctx.sawLoop) ctx.cdAfterLoop = true;
      const r = command(pipeline[p], forceShell || stdinIsShell, upstream);
      if (r.why) return r;
      upstream ||= r.named === true;
      dir = r.dir;
      if (!seenDirs.includes(dir)) seenDirs.push(dir);
    }
  }
  // Command substitutions run in whichever directory the shell is in when it reaches them; check each
  // from every directory this command passed through. They are checked after the main commands so that
  // every variable value and directory is known; any loop, trap, or cd inside them still sets the
  // shared flags, and a cd inside one runs in a subshell and cannot move the outer command.
  for (const s of subs) {
    for (const d of seenDirs) { const why = nested(s, d, forceShell).why; if (why) return { why, dir }; }
  }
  return { why: null, dir };

  function command(cmd, shellBodies, upstream = false) {
    let here = dir;
    let named = false;
    const fail = (why) => ({ why, dir: here });
    const ok = (next = here) => ({ why: null, dir: next, named });
    for (const t of cmd.redirects) {
      const why = judge(t, here, false);
      if (why) return fail(why);
      if (ctx.touchesPermissionFile(t, here) || (t.subs ?? []).some((x) => PERMISSION_TEXT.test(x))) { if (t.write) return fail(MSG.permFile); named = true; }
    }
    let words = cmd.words;
    let i = 0;
    let viaXargs = false;
    // Skip assignments, prefix words, and wrapper commands with their flags.
    for (;;) {
      while (i < words.length && (/^\w+=/.test(words[i].v) || prefixWords.has(baseName(words[i].v)))) {
        if (/^\w+=/.test(words[i].v)) { const why = setVar(words[i], here); if (why) return fail(why); }
        else if (words[i].v.includes('/')) { const why = judge(words[i], here, false); if (why) return fail(why); }
        i += 1;
      }
      const wname = words[i] && baseName(words[i].v);
      const valueFlags = wname === undefined ? undefined : wrapperFor(wname);
      if (!valueFlags) break;
      if (words[i].v.includes('/')) { const why = judge(words[i], here, false); if (why) return fail(why); }
      viaXargs ||= wname === 'xargs';
      i += 1;
      while (i < words.length && (words[i].v.startsWith('-') || (wname === 'env' && /^\w+=/.test(words[i].v)))) {
        const f = words[i].v;
        if (wname === 'env' && (f === '-C' || f === '--chdir')) {
          const target = words[i + 1] ?? lit('');
          const why = judge(target, here, true);
          if (why) return fail(why);
          here = locate(target, here);
          i += 2;
          continue;
        }
        if (/^\w+=/.test(f)) { const why = setVar(words[i], here); if (why) return fail(why); }
        i += valueFlags.has(f) ? 2 : 1;
      }
      // Wrappers that take positional words before the command: a duration, lock file, priority, or mask.
      if (['timeout', 'flock', 'chrt', 'taskset'].includes(wname) && i < words.length) i += 1;
    }
    words = words.slice(i);
    const nameWord = words[0];
    // A program named by path (/usr/bin/find) is judged as a path, then treated by its file name.
    const name = nameWord ? nameWord.v.slice(nameWord.v.lastIndexOf('/') + 1) : undefined;
    const args = words.slice(1);

    // Text that names a permission list or the grant function: in a word, in a $(...) body inside a word, or
    // in a heredoc body (T-019). Any program can be handed such text (sh -c, pnpm exec, python3 on stdin), so
    // only read-only programs, git and gh may carry it, and it counts as naming the list for later stages.
    // A patch against a permission list is refused outright (git apply or patch would write it).
    if (nameWord) {
      // A plain path word is judged by where it resolves (below); only words that look like script or
      // shell text (spaces, quotes, operators) are searched as text.
      const plainPath = (v) => /^[\w@%+=:,.\/~-]+$/.test(v);
      const texts = [nameWord, ...args].flatMap((w) => [...(plainPath(w.v) ? [] : [w.v]), ...(w.subs ?? [])]).concat(cmd.heredocs.map((h) => h.body ?? ''));
      if (texts.some((t) => PATCH_OF_LIST.test(t))) return fail(MSG.permFile);
      const mentionsList = texts.some((t) => PERMISSION_TEXT.test(t));
      const mentionsGrant = texts.some((t) => /grant-edit/.test(t));
      const sub1 = args.find((a) => !a.v.startsWith('-'))?.v;
      if (name !== 'gh' && !permissionReadOnly(name, sub1, args)) {
        if (mentionsGrant) return fail(MSG.grantEdit);
        if (mentionsList) return fail(MSG.permFile);
      }
      if (mentionsList || mentionsGrant) named = true;
    }

    // The grant function is run by the owner in a terminal, never by a session (T-019). Programs that
    // only read, and git and gh (commit messages, PR text), may mention it.
    if (nameWord && name !== 'gh' && !permissionReadOnly(name, args.find((a) => !a.v.startsWith('-'))?.v, args)
      && [nameWord, ...args].some((w) => ctx.touchesGrantFunction(w, here))) return fail(MSG.grantEdit);

    // A permission-list name that came down a pipe may only reach read-only programs (xargs rm, sh, while read).
    if (upstream && !permissionReadOnly(name, args.find((a) => !a.v.startsWith('-'))?.v, args)) return fail(MSG.permFile);

    // Heredoc bodies: shell for shells, unknown receivers, xargs, and stdin-to-shell pipelines; otherwise
    // data, where only $(...) and backticks in an unquoted-delimiter body run.
    const bodiesAsShell = shellBodies || viaXargs || (name !== undefined && (!heredocDataReaders.has(name) || nameWord.dynamic));
    for (const h of cmd.heredocs) {
      if (bodiesAsShell) {
        const why = nested(h.body, here, true).why;
        if (why) return fail(why);
      } else if (!h.quoted) {
        for (const s of lex(`"${h.body.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).subs) {
          const why = nested(s, here, false).why;
          if (why) return fail(why);
        }
      }
    }
    if (name === undefined) return ok();

    // A command name that is a path, or built from a variable or command output.
    if (nameWord.dynamic || nameWord.v.includes('/')) {
      const why = judge(nameWord, here, false);
      if (why) return fail(why);
      for (const s of nameWord.subs) { const w = nested(s, here, true).why; if (w) return fail(w); }
    }
    // A program named by a variable with known values (f=find; $f .) is checked as each of them.
    if (nameWord.dynamic) {
      for (const alt of ctx.alternatives(nameWord) ?? []) {
        if (alt.dynamic) continue;
        const r = command({ words: [alt, ...args], redirects: [], heredocs: [] }, shellBodies, upstream);
        if (r.why) return fail(r.why);
      }
    }
    // for/select NAME in WORDS: each word is a value of NAME (after glob expansion, so wildcards count).
    if ((name === 'for' || name === 'select') && args[1]?.v === 'in') {
      for (const w of args.slice(2)) {
        const why = judge(w, here, true);
        if (why) return fail(why);
        assign(args[0].v, w, here);
      }
      return ok();
    }
    // watch runs its command through sh -c, repeatedly.
    // script runs a command string under a pseudo-terminal: check that string like bash -c.
    if (name === 'script') {
      const k = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a.v) || a.v === '--command' || a.v.startsWith('--command='));
      const text = k < 0 ? undefined : args[k].v.startsWith('--command=') ? args[k].v.slice(10) : args[k + 1]?.v;
      if (text) { const why = nested(text, here, true).why; if (why) return fail(why); }
      return ok();
    }
    if (name === 'watch') {
      let k = 0;
      while (k < args.length && args[k].v.startsWith('-')) k += ['-n', '--interval'].includes(args[k].v) ? 2 : 1;
      const why = nested(args.slice(k).map((a) => a.v).join(' '), here, true).why;
      return why ? fail(why) : ok();
    }

    if (name === 'cd' || name === 'pushd') {
      const target = args.find((a) => a.v === '-' || !a.v.startsWith('-')) ?? { ...lit('~'), tilde0: true };
      if (target.v === '-' || /CDPATH|OLDPWD/.test(src)) return ok(null);
      const why = judge(target, here, true);
      if (why) return fail(why);
      return ok(locate(target, here));
    }
    if (name === 'popd' || name === 'source' || name === '.') {
      for (const a of args) { const why = judge(a, here, false); if (why) return fail(why); }
      return ok(null);
    }
    if (name === 'eval') {
      for (const a of args) for (const s of a.subs) { const why = nested(s, here, true).why; if (why) return fail(why); }
      const why = nested(args.map((a) => a.v).join(' '), here, true).why;
      return why ? fail(why) : ok(null);
    }
    if (name === 'alias') {
      for (const a of args) {
        const eq = a.v.indexOf('=');
        if (eq > 0) { const why = nested(a.v.slice(eq + 1), here, true).why; if (why) return fail(why); }
      }
      return ok(null);
    }
    if (shells.has(name)) {
      for (let k = 0; k < args.length; k += 1) {
        const f = args[k].v;
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(f)) {
          const script = args[k + 1];
          if (!script) return ok();
          // Output of $(...) inside the script becomes shell code, so its heredoc bodies are shell.
          for (const s of script.subs) { const why = nested(s, here, true).why; if (why) return fail(why); }
          const why = nested(script.v, here, true).why;
          return why ? fail(why) : ok();
        }
        if (!f.startsWith('-')) { const why = judge(args[k], here, false); return why ? fail(why) : ok(); }
      }
      return ok();
    }
    // A trap handler is shell code that runs later and repeatedly (DEBUG before every command).
    if (name === 'trap') {
      const handler = args.find((a) => !a.v.startsWith('-'));
      if (handler) {
        for (const s of handler.subs) { const why = nested(s, here, true).why; if (why) return fail(why); }
        const why = nested(handler.v, here, true).why;
        if (why) return fail(why);
      }
      return ok();
    }
    if (name === 'ssh') {
      let k = 0;
      while (k < args.length && args[k].v.startsWith('-')) k += sshValueFlags.has(args[k].v) ? 2 : 1;
      const remote = args.slice(k + 1).map((a) => a.v).join(' ');
      if (remote) { const why = nested(remote, home, true).why; if (why) return fail(why); }
      return ok();
    }

    let segDir = here;
    // Words split two ways: values written as --flag=value, and every other word (a path, a pattern, or
    // the value of a flag like -I x; which one is not guessed).
    const flagValues = [];
    const positional = [];
    for (let k = 0; k < args.length; k += 1) {
      const a = args[k];
      const flag = a.v.match(/^(-C|--dir|--directory|--cwd)=(.+)$/);
      const target = flag ? { ...a, v: flag[2], tilde0: false } : dirFlags.has(a.v) ? args[k + 1] : undefined;
      if (target !== undefined) {
        if (!flag) k += 1;
        const why = judge(target, segDir, true);
        if (why) return fail(why);
        segDir = locate(target, segDir);
      } else if (a.v.startsWith('-')) {
        const eq = a.v.indexOf('=');
        if (eq > 0) flagValues.push({ ...a, v: a.v.slice(eq + 1), tilde0: false });
      } else if (declarers.has(name) && /^\w+=/.test(a.v)) {
        const why = setVar(a, segDir);
        if (why) return fail(why);
      } else {
        positional.push({ w: a });
      }
    }
    // git reads ignored files (the repo's protected entries) with grep --no-index/--untracked, diff
    // --no-index, and add -f.
    const sub = name === 'git' ? positional[0]?.w.v : undefined;
    const gitFsGrep = sub === 'grep' && args.some((a) => /^--(no-index|untracked|no-exclude-standard)$/.test(a.v));
    const gitWalks = gitFsGrep || (sub === 'diff' && args.some((a) => a.v === '--no-index'))
      || (sub === 'add' && args.some((a) => a.v === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a.v)));
    // The search pattern of a grep-style tool is text, not a path: it may be "/" but not a protected path.
    // rg --files lists files and takes no pattern, so all of its words are paths.
    const rgFiles = name === 'rg' && args.some((a) => a.v === '--files');
    const patterns = gitFsGrep ? 2 : patternFirst.has(name) && !rgFiles ? 1 : 0;
    for (const v of flagValues) { const why = judge(v, segDir, true); if (why) return fail(why); }
    for (let k = 0; k < positional.length; k += 1) {
      const why = judge(positional[k].w, segDir, harmless.has(name) || k < patterns);
      if (why) return fail(why);
    }
    // Permission lists (T-019): only read-only programs may name them, or the .claude folder itself, and a
    // name that came down a pipe may only reach read-only programs.
    const readOnlyHere = permissionReadOnly(name, sub, args);
    for (const w of [...args, ...flagValues]) {
      if (ctx.touchesPermissionFile(w, segDir)) {
        if (!readOnlyHere) return fail(MSG.permFile);
        named = true;
      }
    }
    // find and fd can pick the lists by pattern and then act on them, or hand their names to a later stage.
    // Refuse an action when they start where a list could be (this folder or above, or the home folder)
    // and the tests could match one; without an action, remember that the names went downstream.
    if (name === 'find' || name === 'fd') {
      // find: the start paths are the words before the first expression word; fd: the words after the pattern.
      const exprAt = args.findIndex((a) => /^(-|!$|\()/.test(a.v));
      const starts = name === 'find'
        ? args.slice(0, exprAt === -1 ? args.length : exprAt)
        : positional.slice(1).map((p) => p.w);
      const places = starts.length ? starts.map((w) => locate(w, segDir)) : [segDir];
      const reaches = name === 'fd' || places.some((p) => p === null || segDir === null || p === '/' || segDir === p || segDir.startsWith(`${p}/`) || home === p || home.startsWith(`${p}/`));
      const acts = name === 'find' ? args.some((a) => FIND_ACTIONS.test(a.v)) : args.some((a) => FD_ACTIONS.test(a.v));
      const couldMatch = name === 'find' ? findCouldMatchList(args, exprAt) : fdCouldMatchList(args);
      if (reaches && couldMatch) {
        if (acts) return fail(MSG.permFile);
        named = true;
      }
    }
    // A listing run from inside the .claude folder itself also names the lists to a later stage.
    if (listingTools.has(name) && ctx.touchesPermissionFile(lit('.'), segDir)) named = true;
    // Which words a tool reads as folders, patterns, or flag values differs per tool and cannot be told
    // apart reliably, so listing and recursive commands are judged by where they run, not by their
    // words: from ~/W3, a folder above it, or an unknown folder, they are refused; and a recursive command
    // is refused when its folder, or any folder it names, directly holds a protected entry.
    const walks = isRecursive(name, args) || gitWalks;
    if ((listingTools.has(name) || walks) && segDir === null) return fail(MSG.unknownList);
    if ((listingTools.has(name) || walks) && roots.has(segDir)) return fail(MSG.root);
    if (walks) {
      const folders = [segDir, ...positional.map((p) => locate(p.w, segDir)), ...flagValues.map((v) => locate(v, segDir))];
      if (folders.some((t) => ctx.holdsProtected(t))) return fail(MSG.protectedTree);
    }
    // A command name built from a variable could be cd, pushd, eval, or source: the directory after it
    // is unknown.
    return ok(nameWord.dynamic ? null : here);
  }
}

export function check(cmd, home = homedir(), cwd = process.cwd(), exists = existsSync) {
  if (!cmd) return null;
  if (Buffer.byteLength(cmd) > MAX_COMMAND_BYTES) return MSG.tooLong;
  const norm = normalize(cmd, home);
  const destroy = destructiveCommand(cmd) ?? destructiveCommand(norm);
  if (destroy) return destroy;
  for (const [re, why] of rules) if (re.test(cmd) || re.test(norm)) return why;
  if (grew(cmd, norm)) return MSG.split;
  const ctx = { ...makeJudge(home, exists), home, sawLoop: false, cdAfterLoop: false };
  try {
    // Loops, functions, and reordering can run a use after an assignment written later in the text.
    // Repeat the analysis with the remembered values until a pass adds no new value (at most 5 passes).
    for (let pass = 0; pass < 5; pass += 1) {
      const before = ctx.knownValues();
      ctx.sawLoop = false;
      const why = analyze(cmd, cwd, ctx, 0).why;
      if (why) return why;
      // Directories are followed in text order only, which a loop, function, or trap can break.
      if (ctx.cdAfterLoop) return MSG.loopCd;
      if (ctx.knownValues() === before) return null;
    }
    return MSG.unstable;
  } catch (e) {
    // Nesting deep enough to exhaust the stack (for example thousands of "$(") is blocked, not crashed.
    if (e instanceof RangeError) return MSG.nested;
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let cmd = '';
  let cwd = process.cwd();
  let why = null;
  try {
    const input = JSON.parse(raw);
    cmd = String(input.tool_input?.command ?? '');
    if (typeof input.cwd === 'string' && isAbsolute(input.cwd)) cwd = input.cwd;
  } catch {
    why = 'unreadable hook input';
  }
  why ??= check(cmd, homedir(), cwd);
  if (why) {
    process.stderr.write(`Blocked by .claude/hooks/guard.mjs: ${why}. Ask the human to run it or approve another way.\n`);
    process.exit(2);
  }
  process.exit(0);
}
