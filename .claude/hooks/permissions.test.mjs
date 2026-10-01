// Tests for T-019: the permission-list lock (Write/Edit hook and Bash guard) and the owner-run grant function.
// Commands and paths here are data only; the only things executed are the hook wrapper and the CLI, which
// refuse without a terminal.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, applyRevoke, looksLikeClaude, merge, parentCommandLines, parsePatch, printable, revoke, validateRule } from './grant-edit.mjs';
import { check } from './guard.mjs';
import { isPermissionFile } from './protect-permissions.mjs';

const home = '/home/tester';
const repo = `${home}/W3/MintBot`;
const hookSh = fileURLToPath(new URL('./protect-permissions.sh', import.meta.url));
const grantScript = fileURLToPath(new URL('./grant-edit.mjs', import.meta.url));
const noEntries = () => false;
const bash = (cmd, cwd = repo) => check(cmd, home, cwd, noEntries);

const permFile = 'permission lists change only with the owner (propose the rules in Docs/permission-patch/ and ask the owner to apply them)';
const grantEdit = 'the grant function is run by the owner in a terminal, never by a session';

const SEVEN = [
  'Write(packages/engine/src/pre-sign.ts)',
  'Write(packages/engine/src/pre-sign.test.ts)',
  'Edit(packages/engine/src/mint-engine.ts)',
  'Edit(packages/engine/src/index.ts)',
  'Edit(packages/cli/src/engine-adapter.ts)',
  'Edit(packages/cli/src/engine-adapter.test.ts)',
  'Write(packages/database/src/spend-reservation-boundary.test.ts)',
];

describe('Write/Edit hook: permission lists are locked (fail closed)', () => {
  it.each([
    ['.claude/settings.json', repo],
    ['.claude/settings.local.json', repo],
    [`${repo}/.claude/settings.local.json`, '/tmp'],
    ['./.claude/../.claude/settings.local.json', repo],
    ['../MintBot/.claude/settings.json', `${home}/W3/MintBot-wt/x`],
    ['~/.claude/settings.json', repo],
    ['~/.claude/settings.local.json', repo],
    [`${home}/W3/MintBot-wt/guardrails/.claude/settings.json`, '/tmp'],
    ['settings.local.json', `${repo}/.claude`],
    ['settings.json', `${repo}/.claude`],
  ])('blocks %s (cwd %s)', (path, cwd) => {
    expect(isPermissionFile(path, cwd, home)).toBe(true);
  });

  it.each([
    ['packages/engine/src/pre-sign.ts', repo],
    ['packages/engine/src/mint-engine.ts', repo],
    ['.claude/hooks/guard.mjs', repo],
    ['.claude/agents/reviewer.md', repo],
    ['.claude/settings.json.bak', repo],
    ['.claude/settings.jsonc', repo],
    ['Docs/permission-patch/settings.local.json', repo],
    ['.vscode/settings.json', repo],
    ['settings.json', repo],
    ['tasks/active/T-019.md', repo],
    ['', repo],
  ])('allows %s (cwd %s)', (path, cwd) => {
    expect(isPermissionFile(path, cwd, home)).toBe(false);
  });

  it('blocks a symlink that points at a permission list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perm-link-'));
    try {
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', 'settings.local.json'), '{}');
      symlinkSync(join(dir, '.claude', 'settings.local.json'), join(dir, 'innocent.json'));
      symlinkSync(join(dir, '.claude'), join(dir, 'alias'));
      expect(isPermissionFile('innocent.json', dir, home)).toBe(true);
      expect(isPermissionFile('alias/settings.local.json', dir, home)).toBe(true);
      expect(isPermissionFile('alias/hooks.json', dir, home)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const run = (stdin) => spawnSync('bash', [hookSh], { input: stdin, encoding: 'utf8' });
  it('exits 2 with a message for a Write to a permission list', () => {
    const r = run(JSON.stringify({ cwd: repo, tool_name: 'Write', tool_input: { file_path: '.claude/settings.local.json', content: '{}' } }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("permission lists change only with the owner's approval");
  });
  it('exits 2 for an Edit and for a notebook edit of a permission list', () => {
    expect(run(JSON.stringify({ cwd: repo, tool_input: { file_path: `${repo}/.claude/settings.json` } })).status).toBe(2);
    expect(run(JSON.stringify({ cwd: repo, tool_input: { notebook_path: '.claude/settings.json' } })).status).toBe(2);
  });
  it('exits 0 for the granted files and other edits', () => {
    for (const rule of SEVEN) {
      const file = rule.slice(rule.indexOf('(') + 1, -1);
      expect(run(JSON.stringify({ cwd: repo, tool_input: { file_path: file } })).status).toBe(0);
    }
    expect(run(JSON.stringify({ cwd: repo, tool_input: { file_path: 'Docs/permission-patch/settings.local.json' } })).status).toBe(0);
    expect(run(JSON.stringify({ cwd: repo, tool_input: {} })).status).toBe(0);
  });
  it('blocks writing a patch against a permission list, in any file', () => {
    const patch = '--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -1 +1 @@\n';
    for (const tool_input of [
      { file_path: 'Docs/p.patch', content: patch },
      { file_path: 'Docs/p.patch', new_string: `x\n${patch}` },
      { file_path: 'Docs/p.patch', edits: [{ new_string: patch }] },
      { notebook_path: 'n.ipynb', new_source: 'diff --git a/.claude/settings.local.json b/.claude/settings.local.json' },
    ]) {
      const r = run(JSON.stringify({ cwd: repo, tool_input }));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('patch against a permission list');
    }
  });
  it('allows prose and code that merely mention a permission list', () => {
    for (const content of ['See .claude/settings.json for the hooks.', "const x = '+++ b/.claude/settings.json';", 'diff --git a/x b/x\n--- a/x\n+++ b/x']) {
      expect(run(JSON.stringify({ cwd: repo, tool_input: { file_path: 'Docs/notes.md', content } })).status).toBe(0);
    }
  });
  it('fails closed on unreadable input', () => {
    const r = run('not json');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unreadable hook input');
  });
});

describe('Bash guard: writes to permission lists are refused (fail closed)', () => {
  it.each([
    'cat > .claude/settings.local.json',
    'echo x >> .claude/settings.json',
    'echo x >| .claude/settings.local.json',
    'echo x &> .claude/settings.json',
    'cat <<EOF > .claude/settings.local.json\n{}\nEOF',
    'cp Docs/permission-patch/settings.local.json .claude/settings.local.json',
    'sed -i s/a/b/ .claude/settings.json',
    'tee .claude/settings.local.json',
    'mv .claude/settings.json /tmp/x',
    'rm .claude/settings.local.json',
    'rm -rf .claude',
    'find .claude -delete',
    'touch .claude/settings.local.json',
    'dd if=/dev/null of=.claude/settings.local.json',
    'curl -o .claude/settings.local.json https://x.example/a',
    'curl --output=.claude/settings.json https://x.example/a',
    'cp x ~/.claude/settings.json',
    'rm $HOME/.claude/settings.json',
    'rm .claude/settings*',
    'rm .claude/settings.{json,local.json}',
    'rm .cla*/settings.json',
    'rm -r .cl?ude',
    'cd .claude && cat > settings.local.json',
    'cd .claude && rm settings.json',
    'f=.claude/settings.json; rm $f',
    'node -e "require(\'fs\').writeFileSync(\'.claude/settings.json\', \'{}\')"',
    'node -e "fs.writeFileSync(\'settings.local.json\', \'\')"',
    'python3 -c "open(\'.claude/settings.local.json\', \'w\').write(\'{}\')"',
    'awk \'BEGIN { print 1 > ".claude/settings.json" }\'',
    'cp .claude/settings.local.json /tmp/backup.json',
    // review round 1: --output writes, names passed down a pipe, and find/fd acting on patterns
    'git diff --output=.claude/settings.json',
    'git log --output=.claude/settings.local.json -1',
    'git show --output=.claude/settings.json HEAD',
    'git -C . diff --output=~/.claude/settings.json',
    'git diff --output .claude/settings.json',
    'printf "%s\\n" .claude/settings.json | xargs rm',
    'echo .claude/settings.json | xargs tee',
    'cat .claude/settings.json | xargs rm',
    'cat < .claude/settings.json | tee /tmp/x',
    'echo .claude/settings.json | while read f; do rm $f; done',
    'echo .claude/settings.json | sh',
    'find . -name settings.local.json -delete',
    'find . -name settings.json -delete',
    "find . -name 'settings*' -exec rm {} +",
    "find . -name '*.json' -delete",
    'find -name settings.json -delete',
    'fd settings.local.json -x rm',
    "fd -g 'settings*' . -X rm",
    'cat .claude/settings.json | python3 -c "import sys; print(sys.stdin.read())"',
    // review round 2: other find tests, fd, no test at all, and find/ls output passed downstream
    'find . -iname SETTINGS.JSON -delete',
    "find . -regex '.*/settings\\.json' -delete",
    "find . -regex '.*s.*json' -delete",
    "find . -ipath '*/.CLAUDE/*' -delete",
    'fd settings -X rm',
    'fd -e json -X rm',
    'find . -delete',
    'find . -exec rm {} +',
    'find . -type f -newer x -delete',
    'find . -name settings.json | xargs rm',
    "find . -name 'settings*' | xargs -n1 tee",
    'find . | xargs rm',
    'cd .claude && ls | xargs rm',
    'cd .claude && find . | xargs rm',
    // security review: names built inside $(...), wrapper strings, script text on stdin, heredocs, patches
    'cp x "$(echo .claude/settings.json)"',
    'echo x > $(echo .claude/settings.json)',
    'echo x > `echo .claude/settings.json`',
    'tee $(echo .claude/settings.local.json)',
    'rm "$(echo .claude/settings.json)"',
    'pnpm exec sh -c "echo > .claude/settings.json"',
    'npx sh -c "echo > .claude/settings.json"',
    'pnpm exec node -e "require(\'fs\').writeFileSync(\'.claude/settings.json\', \'{}\')"',
    'echo "echo x > .claude/settings.json" | bash',
    'echo "open(\'.claude/settings.json\', \'w\')" | python3',
    'python3 <<EOF\nopen(".claude/settings.json", "w")\nEOF',
    "node <<'EOF'\nrequire('fs').writeFileSync('.claude/settings.local.json', '{}')\nEOF",
    'cat <<EOF | bash\necho x > .claude/settings.json\nEOF',
    "cat <<'EOF' > Docs/p.patch\n--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -1 +1 @@\nEOF",
    "printf '+++ b/.claude/settings.json\\n' > p.patch",
    "echo '--- a/.claude/settings.local.json' >> p.patch",
    "cat <<'EOF' > p.patch\ndiff --git a/.claude/settings.json b/.claude/settings.json\nEOF",
  ])('%s', (cmd) => {
    expect(bash(cmd)).toBe(permFile);
  });

  it.each([
    "find .. -path '*/.claude/*' -delete",
    'find ~ -name settings.json -exec rm {} ;',
    'find / -name settings.json -delete',
  ])('find above the repo is refused (for one reason or another): %s', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });

  it.each([
    'node .claude/hooks/grant-edit.mjs Docs/permission-patch/settings.local.json',
    'node .claude/hooks/grant-edit.mjs --revoke-all',
    'cd .claude/hooks && node ./grant-edit.mjs --show',
    'bash -c "node .claude/hooks/grant-edit.mjs x"',
    'script -qc "node .claude/hooks/grant-edit.mjs x" /dev/null',
    'node .claude/hooks/grant-e*.mjs',
    'node .claude/hooks/grant-?dit.mjs',
    'node .claude/hooks/*-edit.mjs',
    'node .claude/hooks/*.mjs',
    'node .claude/hooks/grant-{edit,x}.mjs',
    'node .claude/hooks/gra[n]t-edit.mjs',
    'G=grant-edit; node .claude/hooks/$G.mjs',
    'echo x | script -qc "node .claude/hooks/grant-e*.mjs p.json" /dev/null',
    'script -qc "node .claude/hooks/grant-edit.mjs --revoke-all" /dev/null',
    'script --command="node .claude/hooks/grant-edit.mjs x" /dev/null',
    'cd .claude/hooks && node grant-e*.mjs x',
    'unbuffer node .claude/hooks/grant-edit.mjs',
    'nohup node .claude/hooks/grant-edit.mjs',
    'node "$(echo .claude/hooks/grant-edit.mjs)" p.json',
    'python3 <<EOF\nimport pty; pty.spawn(["node", ".claude/hooks/grant-edit.mjs"])\nEOF',
    'xargs node .claude/hooks/grant-edit.mjs',
    'echo x | xargs -n1 node .claude/hooks/grant-edit.mjs',
    'bash .claude/hooks/grant-edit.mjs --revoke-all',
    'sh <<EOF\nnode .claude/hooks/grant-edit.mjs --show\nEOF',
    'env node .claude/hooks/grant-edit.mjs',
    '.claude/hooks/grant-edit.mjs',
  ])('the grant function cannot be run by a session: %s', (cmd) => {
    expect(bash(cmd)).toBe(grantEdit);
  });

  it.each([
    'node ".claude/hooks/grant""-edit.mjs" x',
    'node .claude/hooks/grant-\\edit.mjs x',
    'echo "node .claude/hooks/grant-edit.mjs --show" | bash',
  ])('split names of the grant function are refused too: %s', (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });
});

describe('Bash guard: read-only commands on permission lists and everyday commands still pass', () => {
  it.each([
    'cat .claude/settings.local.json',
    'cat .claude/settings.json',
    'jq . .claude/settings.json',
    'jq .permissions.allow .claude/settings.local.json',
    'grep -n allow .claude/settings.local.json',
    'ls .claude',
    'ls -la .claude/hooks',
    'stat .claude/settings.local.json',
    'git add .claude/settings.json',
    'git diff .claude/settings.json',
    'git status --short .claude',
    'git log --oneline -3 -- .claude/settings.json',
    'git commit -m "update settings.json docs" -- .claude/settings.json',
    'diff .claude/settings.json /tmp/x',
    'wc -l .claude/settings.json',
    'cd .claude && cat settings.json',
    'echo see .claude/settings.json',
    'pnpm exec vitest run .claude/hooks',
    'node --check .claude/hooks/guard.mjs',
    'chmod +x .claude/hooks/guard.sh',
    'cat Docs/permission-patch/settings.local.json',
    'cp Docs/permission-patch/settings.local.json /tmp/x.json',
    'gh pr create --title "x" --body "changes .claude/settings.json rules"',
    'git commit -m "T-019: lock the permission lists"',
    'git add .claude/hooks/grant-edit.mjs',
    'chmod +x .claude/hooks/*.sh',
    'node --check .claude/hooks/protect-permissions.mjs',
    'ls .claude/hooks/*.mjs',
    'script -qc "pnpm test" /dev/null',
    "find . -iname '*.ts' -delete",
    'find dist -delete',
    'find . -name settings.json | head -3',
    'find packages -type f | xargs wc -l',
    'cd .claude && ls | head',
    'curl -s https://json.schemastore.org/claude-code-settings.json -o /tmp/schema.json',
    "cat <<'EOF' > Docs/notes.md\nSee .claude/settings.json for the hooks.\nEOF",
    'git commit -F - <<EOF\nupdate .claude/settings.json docs\nEOF',
    'gh pr create --body-file - <<EOF\nmentions .claude/settings.json\nEOF',
    'cp Docs/permission-patch/settings.local.json /tmp/copy.json',
    'git commit -m "T-019: add grant-edit.mjs, the owner-run function"',
    'gh pr create --title "x" --body "run grant-edit.mjs yourself, in a terminal"',
    'cat .claude/hooks/grant-edit.mjs',
    'grep -n validateRule .claude/hooks/grant-edit.mjs',
    'git diff --stat',
    'git log --oneline -3',
    'git show HEAD --stat',
    'cat .claude/settings.json | head -5',
    'cat .claude/settings.local.json | grep -c Edit',
    'git diff .claude/settings.json | wc -l',
    "find dist -name '*.json' -delete",
    "find packages -name settings.json -delete",
    "find . -name '*.ts' -delete",
    "find . -name settings.json",
    "find . -name 'settings*'",
    'fd -e ts -x echo',
    'pnpm test',
    'node scripts/lint.mjs',
  ])('%s', (cmd) => {
    expect(bash(cmd)).toBeNull();
  });
});

describe('grant function: validation (fail closed)', () => {
  it.each(SEVEN)('accepts %s', (rule) => {
    expect(validateRule(rule)).toEqual({ ok: true, rule });
  });
  it('canonicalizes a leading ./ and accepts files named like protected words', () => {
    expect(validateRule('Edit(./a/b.ts)')).toEqual({ ok: true, rule: 'Edit(a/b.ts)' });
    expect(validateRule('Edit(packages/engine/src/secrets.ts)').ok).toBe(true);
  });
  it.each([
    ['Bash(npm test)', 'only Edit'],
    ['Read(src/a.ts)', 'only Edit'],
    ['WebFetch(domain:x.com)', 'only Edit'],
    ['Edit', 'only Edit'],
    ['Edit()', 'only Edit'],
    ['Edit(**)', 'wildcards'],
    ['Edit(src/*.ts)', 'wildcards'],
    ['Edit(src/{a,b}.ts)', 'wildcards'],
    ['Edit(~/x.ts)', 'wildcards'],
    ['Edit(a\\b.ts)', 'wildcards'],
    ['Edit(/etc/passwd)', 'absolute'],
    ['Edit(//etc/passwd)', 'absolute'],
    ['Edit(../x.ts)', '..'],
    ['Edit(a/../b.ts)', '..'],
    ['Edit(a//b.ts)', '..'],
    ['Edit(a/./b.ts)', '..'],
    ['Edit(src/)', 'folder'],
    ['Edit( a.ts)', 'spaces'],
    ['Edit(.claude/settings.json)', '.claude'],
    ['Write(.claude/hooks/guard.mjs)', '.claude'],
    ['Edit(.git/config)', '.claude'],
    ['Edit(node_modules/x/index.js)', '.claude'],
    ['Edit(Rets/x.txt)', 'secret'],
    ['Edit(packages/x/secrets/a.ts)', 'secret'],
    ['Edit(wallets.json)', 'secret'],
    ['Edit(keystore/a)', 'secret'],
    ['Edit(.env)', 'secret'],
    ['Edit(app/.env.local)', 'secret'],
    ['Edit(signer.key)', 'secret'],
    ['Edit(cert.pem)', 'secret'],
    ['Edit(package.json)', 'folder'],
    ['Edit(src/.Claude/x.ts)', '.claude'],
    ['Edit(src/.GIT/config)', '.claude'],
    ['Edit(app/.ENV)', 'secret'],
    ['Edit(src/RETS/a.ts)', 'secret'],
    ['Edit(src/Wallets.JSON)', 'secret'],
    ['Edit(settings.local.json)', 'folder'],
    ['Edit(guard.mjs)', 'folder'],
    ['Edit(!src/a.ts)', '! or #'],
    ['Edit(#src/a.ts)', '! or #'],
    ['Edit(src/a.ts\u001b[2J)', 'printable ASCII'],
    ['Edit(src/\u001bc/a.ts)', 'printable ASCII'],
    ['Edit(src/a.ts\r)', 'printable ASCII'],
    ['Edit(src/a\b.ts)', 'printable ASCII'],
    ['Edit(src/a.ts\u0007)', 'printable ASCII'],
    ['Edit(src/a.ts\u202e)', 'printable ASCII'],
    ['Edit(src/caf\u00e9.ts)', 'printable ASCII'],
    ['Edit(src/a.ts\u0000)', 'printable ASCII'],
    [`Edit(${'a/'.repeat(120)}b.ts)`, 'too long'],
    [42, 'not text'],
    [null, 'not text'],
  ])('refuses %j', (rule, why) => {
    const r = validateRule(rule);
    expect(r.ok).toBe(false);
    expect(r.why).toContain(why);
  });
});

describe('grant function: patches', () => {
  it('accepts both patch shapes and removes duplicates', () => {
    expect(parsePatch(JSON.stringify({ permissions: { allow: SEVEN } }))).toEqual(SEVEN);
    expect(parsePatch(JSON.stringify({ $schema: 'x', allow: [SEVEN[0], SEVEN[0], './packages/a.ts'].map((r) => r.replace('./packages', 'Edit(packages').replace('Edit(packages/a.ts', 'Edit(packages/a.ts)')) }))).toContain('Edit(packages/a.ts)');
  });
  it.each([
    [{ permissions: { allow: ['Edit(src/a.ts)'], deny: [] } }, 'only add allow rules'],
    [{ permissions: { allow: ['Edit(src/a.ts)'], ask: ['Bash(x)'] } }, 'only add allow rules'],
    [{ allow: ['Edit(src/a.ts)'], hooks: {} }, 'only contain an allow list'],
    [{ allow: ['Edit(src/a.ts)'], deny: ['Read(x)'] }, 'only contain an allow list'],
    [{ allow: ['Edit(src/a.ts)'], permissions: { allow: ['Edit(src/b.ts)'] } }, 'either'],
    [{ permissions: { allow: [] } }, 'non-empty'],
    [{}, 'non-empty'],
    [[], 'JSON object'],
    [null, 'JSON object'],
    [{ allow: Array.from({ length: 51 }, (_, i) => `Edit(src/f${i}.ts)`) }, 'too many'],
  ])('refuses %j', (patch, why) => {
    expect(() => parsePatch(JSON.stringify(patch))).toThrow(why);
  });
  it('refuses invalid JSON, and one bad rule refuses the whole patch with every problem listed', () => {
    expect(() => parsePatch('{')).toThrow('not valid JSON');
    let message = '';
    try { parsePatch(JSON.stringify({ allow: ['Edit(src/a.ts)', 'Bash(rm -rf /)', 'Edit(../x)'] })); } catch (e) { message = e.message; }
    expect(message).toContain('nothing was changed');
    expect(message).toContain('Bash(rm -rf /)');
    expect(message).toContain('Edit(../x)');
  });
});

describe('grant function: merge, apply and revoke', () => {
  let root;
  const file = () => join(root, '.claude', 'settings.local.json');
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'grant-')); mkdirSync(join(root, '.claude')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const patch = (rules) => JSON.stringify({ permissions: { allow: rules } });
  const yes = async () => true;
  const no = async () => false;

  it('merge keeps other keys and other allow rules, and is idempotent', () => {
    const base = { theme: 'x', permissions: { deny: ['Read(a)'], allow: ['Bash(pnpm test)'] } };
    const first = merge(base, ['Edit(src/a.ts)']);
    expect(first.settings).toEqual({ theme: 'x', permissions: { deny: ['Read(a)'], allow: ['Bash(pnpm test)', 'Edit(src/a.ts)'] } });
    const second = merge(first.settings, ['Edit(src/a.ts)']);
    expect(second.added).toEqual([]);
    expect(second.already).toEqual(['Edit(src/a.ts)']);
    expect(merge({}, ['Edit(src/a.ts)']).settings.$schema).toContain('schemastore');
  });

  it('creates the file after a yes, with the seven rules, and leaves no temporary file', async () => {
    const r = await apply({ root, patchText: patch(SEVEN), confirm: yes });
    expect(r.written).toBe(true);
    expect(JSON.parse(readFileSync(file(), 'utf8')).permissions.allow).toEqual(SEVEN);
    expect(readdirSync(join(root, '.claude'))).toEqual(['settings.local.json']);
  });

  it('writes nothing unless the owner confirms', async () => {
    const r = await apply({ root, patchText: patch(SEVEN), confirm: no });
    expect(r.written).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(existsSync(file())).toBe(false);
  });

  it('shows a plain summary to the confirm step', async () => {
    let seen = '';
    await apply({ root, patchText: patch(['Edit(src/a.ts)']), confirm: async (s) => { seen = s; return false; } });
    expect(seen).toContain('create or edit these 1 file(s)');
    expect(seen).toContain('+ Edit(src/a.ts)');
    expect(seen).toContain('deny rules and the Bash guard stay in force');
  });

  it('adds to an existing file without losing deny rules or other allow rules', async () => {
    writeFileSync(file(), JSON.stringify({ permissions: { deny: ['Read(secret)'], allow: ['Bash(pnpm test)', 'Edit(src/old.ts)'] } }));
    await apply({ root, patchText: patch(['Edit(src/old.ts)', 'Write(src/new.ts)']), confirm: yes });
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ permissions: { deny: ['Read(secret)'], allow: ['Bash(pnpm test)', 'Edit(src/old.ts)', 'Write(src/new.ts)'] } });
  });

  it('does nothing and does not ask when every rule is already allowed', async () => {
    await apply({ root, patchText: patch(['Edit(src/a.ts)']), confirm: yes });
    let asked = false;
    const r = await apply({ root, patchText: patch(['Edit(src/a.ts)']), confirm: async () => { asked = true; return true; } });
    expect(r.written).toBe(false);
    expect(asked).toBe(false);
  });

  it('refuses a broken or wrongly shaped existing file instead of overwriting it', async () => {
    writeFileSync(file(), '{ not json');
    await expect(apply({ root, patchText: patch(['Edit(src/a.ts)']), confirm: yes })).rejects.toThrow('not valid JSON');
    expect(readFileSync(file(), 'utf8')).toBe('{ not json');
    writeFileSync(file(), JSON.stringify({ permissions: { allow: 'Edit(src/a.ts)' } }));
    await expect(apply({ root, patchText: patch(['Edit(src/b.ts)']), confirm: yes })).rejects.toThrow('not a list');
    writeFileSync(file(), '[]');
    await expect(apply({ root, patchText: patch(['Edit(src/b.ts)']), confirm: yes })).rejects.toThrow('JSON object');
  });

  it('refuses an invalid patch before reading or writing anything', async () => {
    await expect(apply({ root, patchText: patch(['Bash(x)']), confirm: yes })).rejects.toThrow('nothing was changed');
    expect(existsSync(file())).toBe(false);
  });

  it('cleans control characters from anything it prints from an existing file', async () => {
    expect(printable('a\u001b[2Jb\r\u202e')).toBe('a?[2Jb??');
    writeFileSync(file(), JSON.stringify({ permissions: { allow: ['Edit(src/a.ts\u001b[2J)'] } }));
    let seen = '';
    await applyRevoke({ root, which: 'all', confirm: async (t) => { seen = t; return false; } });
    expect(seen).toContain('Edit(src/a.ts?[2J)');
    expect(seen).not.toContain('\u001b');
  });

  it('does not follow a planted link: the temporary file is created exclusively under a random name', async () => {
    await apply({ root, patchText: patch(['Edit(src/a.ts)']), confirm: yes });
    expect(readdirSync(join(root, '.claude'))).toEqual(['settings.local.json']);
  });

  it('revokes only file-edit rules, one or all, and only after a yes', async () => {
    writeFileSync(file(), JSON.stringify({ permissions: { allow: ['Bash(pnpm test)', 'Edit(src/a.ts)', 'Write(src/b.ts)'] } }));
    expect(revoke(JSON.parse(readFileSync(file(), 'utf8')), 'Edit(src/a.ts)').removed).toEqual(['Edit(src/a.ts)']);
    expect((await applyRevoke({ root, which: 'Edit(src/a.ts)', confirm: no })).written).toBe(false);
    expect(JSON.parse(readFileSync(file(), 'utf8')).permissions.allow).toHaveLength(3);
    await applyRevoke({ root, which: 'all', confirm: yes });
    expect(JSON.parse(readFileSync(file(), 'utf8')).permissions.allow).toEqual(['Bash(pnpm test)']);
    expect((await applyRevoke({ root, which: 'Edit(src/zzz.ts)', confirm: yes })).written).toBe(false);
  });
});

describe('grant function: refuses inside a Claude Code session', () => {
  it.each([
    [{ CLAUDECODE: '1' }, []],
    [{ CLAUDE_CODE_ENTRYPOINT: 'cli' }, []],
    [{ CLAUDE_CODE_SESSION_ID: 'abc' }, []],
    [{}, [['/home/u/.local/bin/claude', '--resume']]],
    [{}, [['node', '/x/node_modules/@anthropic-ai/claude-code/cli.js']]],
    [{}, [['/home/u/.local/share/claude/versions/2.1.0']]],
    [{}, [['-bash'], ['bash', '-c', 'x'], ['/usr/bin/claude']]],
  ])('detects a session: env %j, parents %j', (env, parents) => {
    expect(looksLikeClaude(parents, env)).toBe(true);
  });
  it.each([
    [{}, []],
    [{ PATH: '/usr/bin' }, [['-bash']]],
    [{}, [['bash', '-c', 'node .claude/hooks/grant-edit.mjs --show']]],
    [{}, [['/usr/bin/claude-tool'], ['gnome-terminal'], ['code', '--folder', '/home/u/.claude']]],
  ])('does not flag a normal terminal: env %j, parents %j', (env, parents) => {
    expect(looksLikeClaude(parents, env)).toBe(false);
  });
  it('sees no parents for an orphaned process, which makes the command line refuse', () => {
    expect(parentCommandLines(1)).toEqual([]);
    expect(parentCommandLines(0)).toEqual([]);
  });
  it('reads the parent command lines as lists of words', () => {
    const lines = parentCommandLines();
    expect(Array.isArray(lines)).toBe(true);
    for (const argv of lines) expect(Array.isArray(argv)).toBe(true);
  });
  it('the command line refuses when the environment says it is a session, even with a terminal-like pipe', () => {
    const r = spawnSync('node', [grantScript, '--revoke-all'], { input: 'yes\n', encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('inside a Claude Code session');
  });
});

describe('grant function: command line refuses without a terminal', () => {
  const patchFile = (dir) => { const p = join(dir, 'patch.json'); writeFileSync(p, JSON.stringify({ allow: ['Edit(src/a.ts)'] })); return p; };
  it.each([[['patch']], [['--revoke-all']], [['--revoke', 'Edit(src/a.ts)']]])('exits 2 for %j even when "yes" is piped in', (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'grant-cli-'));
    try {
      const args = mode[0] === 'patch' ? [patchFile(dir)] : mode;
      const r = spawnSync('node', [grantScript, ...args], { input: 'yes\n', encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/must be run by the owner in a terminal|inside a Claude Code session/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('prints usage and exits 2 with no arguments', () => {
    const r = spawnSync('node', [grantScript], { input: '', encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage');
  });
});

describe('the lock stays registered in settings.json', () => {
  it('registers the Bash guard and the permission hook for every file-writing tool', () => {
    const data = JSON.parse(readFileSync(fileURLToPath(new URL('../settings.json', import.meta.url)), 'utf8'));
    const entries = data.hooks.PreToolUse;
    expect(entries.some((e) => e.matcher === 'Bash' && e.hooks.some((h) => h.command.endsWith('/guard.sh')))).toBe(true);
    const write = entries.find((e) => e.hooks.some((h) => h.command.endsWith('/protect-permissions.sh')));
    expect(write).toBeDefined();
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(write.matcher.split('|')).toContain(tool);
  });
});
