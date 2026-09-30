// Tests for the PreToolUse(Bash) guard. Commands here are data only; nothing is executed except guard.sh itself.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check, normalize } from './guard.mjs';

const home = '/home/tester';
const repo = `${home}/W3/MintBot`;
const guardSh = fileURLToPath(new URL('./guard.sh', import.meta.url));
const runHook = (stdin) => spawnSync('bash', [guardSh], { input: stdin, encoding: 'utf8', env: { ...process.env, HOME: home } });

describe('guard blocks (fail closed)', () => {
  it.each([
    // destructive git and worktree commands
    ['git push --force origin main', 'force or deleting push'],
    ['git push origin --delete task/x', 'force or deleting push'],
    ['git push origin +main', 'force or deleting push'],
    ['git reset --hard HEAD~1', 'git reset --hard'],
    ['git clean -fd', 'git clean -f'],
    ['git branch -D task/x', 'branch deletion'],
    ['git worktree prune', 'forced worktree removal or prune'],
    ['rm -rf ../MintBot-wt/foo', 'rm -r on a worktree folder'],
    ['g"it" reset --hard', 'git reset --hard'],
    // secret paths, literal
    ['cat ~/W3/Rets/x', 'secret path Rets'],
    ['ls ./Rets', 'secret path Rets'],
    ['cat secrets/a.txt', 'secret path secrets/'],
    ['cat app.env', 'secret file (.env, .key, keystore, wallets)'],
    ['cat app.env; echo', 'secret file (.env, .key, keystore, wallets)'],
    ['cat .env.local', 'secret file (.env, .key, keystore, wallets)'],
    ['cat signer.key', 'secret file (.env, .key, keystore, wallets)'],
    ['ls data/keystore/', 'secret file (.env, .key, keystore, wallets)'],
    // secret paths, split or escaped (the 2026-09-28 bypass and variants)
    ['node -e \'const s="sec"+"rets";fs.mkdirSync(`${b}/${s}`)\'', 'protected name assembled from split or escaped pieces'],
    ['node -e \'fs.readFileSync(process.env.HOME+"/W3/"+"Re"+"ts/x")\'', 'secret path Rets'],
    ['cat "$HOME/W3/Re""ts/x"', 'secret path Rets'],
    ["cat $'\\x73ecrets/a'", 'secret path secrets/'],
    ["python3 -c 'open(\"a.e\" + \"nv\")'", 'secret file (.env, .key, keystore, wallets)'],
    ["python3 -c 'p = \"key\" + \"store\"'", 'protected name assembled from split or escaped pieces'],
    // off-limits docs backup
    ['cat ~/W3/Docs/Live/PROJECT.md', 'off-limits docs backup ~/W3/Docs'],
    [`cat ${home}/W3/Docs/PROJECT.md`, 'off-limits docs backup ~/W3/Docs'],
    ['cat "${HOME}/W3/Docs"', 'off-limits docs backup ~/W3/Docs'],
    ['cat ../Docs/Live/PROJECT.md', 'off-limits docs backup ~/W3/Docs'],
    ['cd packages && grep -r x ../../Docs', 'off-limits docs backup ~/W3/Docs'],
    ['cat ~/W3/Do""cs/x', 'off-limits docs backup ~/W3/Docs'],
    // enumeration that reaches secret paths
    ['ls ~/W3/*', 'wildcard inside ~/W3 or a folder above it (can expand to secret paths)'],
    ['cat ~/W3/R*/x', 'wildcard inside ~/W3 or a folder above it (can expand to secret paths)'],
    ['cat ~/W3/{A,B}/x', 'wildcard inside ~/W3 or a folder above it (can expand to secret paths)'],
    ['find ~ -name x', 'listing or copying all of ~, ~/W3, or / (reaches secret paths)'],
    [`ls -la ${home}/W3/`, 'listing or copying all of ~, ~/W3, or / (reaches secret paths)'],
    ['grep -r token $HOME', 'listing or copying all of ~, ~/W3, or / (reaches secret paths)'],
    ['find / -name x', 'listing or copying all of ~, ~/W3, or / (reaches secret paths)'],
  ])('%s', (cmd, why) => {
    expect(check(cmd, home, repo)).toBe(why);
  });
});

describe('guard allows normal work', () => {
  it.each([
    'pnpm test',
    'pnpm ops:fork-replay',
    'git push -u origin task/guard-hardening',
    'git branch --list',
    'git log --grep=secrets --oneline',
    'cat packages/engine/src/secrets.ts',
    'grep -rn "secrets" packages/engine/src',
    'node -e \'console.log(Object.keys(process.env))\'',
    'node -e "const e = process.env"',
    'ls Docs/Live',
    `cat ${home}/W3/MintBot/Docs/Live/PROJECT.md`,
    `ls ${home}/W3/MintBot/*`,
    'find . -name "*.ts"',
    'ls ~/.claude/agents',
    'echo "a" + "b"',
    '',
  ])('%s', (cmd) => {
    expect(check(cmd, home, repo)).toBeNull();
  });
});

const docs = 'off-limits docs backup ~/W3/Docs';
const listing = 'listing or copying all of ~, ~/W3, or / (reaches secret paths)';
const unknownDir = 'relative path from an unknown directory (use an absolute path)';
const built = 'path built from a variable or command output (use a literal path)';
const loopCd = 'cd after a loop, function, or trap starts (run the cd as its own command first, or use absolute paths)';
const wildcard = 'wildcard inside ~/W3 or a folder above it (can expand to secret paths)';

describe('guard resolves paths from the working directory (fail closed)', () => {
  it.each([
    // T-002 review: the backup reached by changing directory first
    ['cd ~/W3 && cat Docs/PROJECT.md', repo, docs],
    ['cd $HOME/W3 && cat Docs/x', repo, docs],
    ["alias go='cd ~/W3'; go && cat Docs/x", repo, unknownDir],
    ["alias go='cd ..'; go && cat Docs/x", repo, unknownDir],
    // other ways to change directory
    ['cd .. && cat Docs/x', repo, docs],
    ['cd ..; ls Docs', repo, docs],
    ['(cd ~/W3; cat ./Docs/x)', repo, docs],
    ['{ cd ~/W3; }; cat Docs/x', repo, docs],
    ['builtin cd ~/W3 && cat Docs/x', repo, docs],
    ['cd ~/W3/Docs', repo, docs],
    ['git -C ~/W3 show HEAD:x -- Docs/x', repo, docs],
    ['tar --directory=.. -cf - Docs', repo, docs],
    ['pnpm --dir .. exec cat Docs/x', repo, docs],
    ['cat --file=../Docs/x', repo, docs],
    ['cat < ../Docs/x', repo, docs],
    ['bash -c "cd ~/W3 && cat Docs/x"', repo, docs],
    ['eval cd ~/W3; cat Docs/x', repo, unknownDir],
    ['bash -c "cd .. && cat Docs/x"', repo, docs],
    ['eval cd ..; cat Docs/x', repo, unknownDir],
    ['cd $TARGET && cat Docs/x', repo, unknownDir],
    ['cd - && cat Docs/x', repo, unknownDir],
    ['source x.sh; cat Rets/y', repo, 'secret path Rets'],
    // the shell's own working directory is already ~/W3 or elsewhere (cwd carries over between calls)
    ['cat Docs/x', `${home}/W3`, docs],
    ['cat ../Docs/x', `${home}/W3/MintBot-run`, docs],
    ['cat ../../Docs/x', `${home}/W3/MintBot-wt/heartbeat`, docs],
    ['cat R*/x', `${home}/W3`, 'wildcard inside ~/W3 or a folder above it (can expand to secret paths)'],
    ['cd .. && cat Doc*/x', repo, 'wildcard inside ~/W3 or a folder above it (can expand to secret paths)'],
    // listing ~/W3, ~, or / by directory
    ['cd ~/W3 && ls -la', repo, listing],
    ['cd .. && find . -name x', repo, listing],
    ['ls', `${home}/W3`, listing],
    ['cd && ls', repo, listing],
    ['alias x=y; ls', repo, 'listing or recursive command from a folder that cannot be known here (use an absolute path or run the cd on its own first)'],
  ])('%s (cwd %s)', (cmd, cwd, why) => {
    expect(check(cmd, home, cwd)).toBe(why);
  });
});

describe('guard closes the T-002 security review findings (fail closed)', () => {
  it.each([
    // security round 1, high: redirect targets written without a space
    ['cat<../R*/x', wildcard],
    ['wc -c<../R*/x', wildcard],
    ['cat<../Docs/x', docs],
    ['cat 0<../Docs/x', docs],
    ['cat <<<x >../Docs/y', docs],
    ['cat <<EOF >../Docs/y\nhello\nEOF', docs],
    // security round 1, high: paths that start with a shell expansion
    ['cat $PWD/../R*/x', wildcard],
    ['cat ${PWD}/../R*/x', wildcard],
    ['cat $(pwd)/../R*/x', built],
    ['cat `pwd`/../R*/x', built],
    ['cat ~+/../R*/x', wildcard],
    ['cat $PWD/../Docs/x', docs],
    ['cat ~+/../Docs/x', docs],
    ['cat ~tester/W3/./Docs/x', built],
    ['cat ~-/Docs/x', built],
    ['cat $X/../y', built],
    ['cat ${X}/*', built],
    ['cat <(cat ../Docs/x)', docs],
    // security round 1, high: unknown directory blocks wildcards and ..
    ['eval :; cat ../R*/x', unknownDir],
    ['eval :; cat ../*/x', unknownDir],
    ['source x.sh; cat ../R*', unknownDir],
    ['. x.sh; cat R*/x', unknownDir],
    ['alias a=b; cat ../x', unknownDir],
    ['pushd x; cat ../../*/y', wildcard],
    ['popd; cat ../*/y', unknownDir],
    ['sh -c x; cat ../*/y', wildcard],
    ['cd $V; cat ../*/y', unknownDir],
    ['cd -; cat ../*/y', unknownDir],
    ['cd $PWD/.. && cat R*/x', wildcard],
    // security round 1, medium: one protected name cannot mask another
    ["node -e \"fs.readFileSync(path.join(os.homedir(),'W3','Re'+'ts','x')); process''.env\"", 'protected name assembled from split or escaped pieces'],
    // security round 1, low: size cap, more tools, symlinks, escapes, variables set to a root
    [`git ${'push '.repeat(20_000)}`, 'command too long to check (over 64 KB)'],
    ['ag tok ..', listing],
    ['ack tok ..', listing],
    ['7z a x.7z ..', listing],
    ['ln -s ~/W3 w', listing],
    ['ln -s ~/W3/Docs d', docs],
    ["cat $'\\U00000073ecrets/a'", 'secret path secrets/'],
    ["echo -e '\\0163ecrets/a'", 'secret path secrets/'],
    ['D=~/W3; ls $D', listing],
    ['export D=..; ls $D', listing],
  ])('%s', (cmd, why) => {
    expect(check(cmd, home, repo)).toBe(why);
  });

  it.each([
    // security round 2, high: a redirect before the command puts the path in command-name position
    ['< ../R*/x cat', wildcard],
    ['<../R*/x cat', wildcard],
    ['0< ../R*/x cat', wildcard],
    ['< ../Docs/x cat', docs],
    ['../R*/x', wildcard],
    ['../Docs/run.sh', docs],
    // security round 2, high: heredoc bodies run by a shell are checked
    ['bash <<EOF\ncat ../R*/x\nEOF', wildcard],
    ['sh <<EOF\ncat ../Docs/x\nEOF', docs],
    ["zsh <<'EOF'\ncat ../R*/x\nEOF", wildcard],
    ['cat <<EOF | bash\ncat ../Docs/x\nEOF', docs],
    ['bash -c "$(cat <<EOF\ncat ../Docs/x\nEOF\n)"', docs],
    ['xargs -0 cat <<EOF\n../Docs/x\nEOF', docs],
    ['unknowncmd <<EOF\ncat ../Docs/x\nEOF', docs],
    // security round 2, low: write redirects in every spelling, and filesystem git grep
    ['echo x >| ../R*/y', wildcard],
    ['echo x &> ../Docs/x', docs],
    ['echo x &>> ../Docs/x', docs],
    ['echo x 2> ../Docs/x', docs],
    ['cd ~/W3 && git grep --no-index tok', listing],
    ['git -C .. grep --no-index tok', listing],
    ['cd ~/W3 && grep -r tok', listing],
    ['cd .. && rg tok', listing],
    // review round 13: an alias is code that runs later, like a function
    ['shopt -s expand_aliases\nalias f="cat R*/k"\ncd ~/W3\nf', loopCd],
    ['shopt -s expand_aliases; alias f="cat R*/k"; cd ~/W3; f', loopCd],
    [`alias f='cat Docs/x'; cd ${home}/W3; f`, loopCd],
    // review round 12: a command name from a variable may change directory; trap handlers run later
    ['c=cd; $c ..; $c ..; cat R?ts/k', listing],
    ['c=cd; $c packages; cat ../../R*/k', unknownDir],
    ['e=eval; $e "cd .."; cat R*/k', unknownDir],
    ['for i in 1 2; do c=cd; $c ..; cat R*/k; done', listing],
    ['for i in 1 2; do $c x; cat R*/k; done', unknownDir],
    ['for i in 1 2; do $c x; done', loopCd],
    ['trap "cd .." DEBUG; cat R*/k', loopCd],
    ["trap 'cd ..' RETURN; f() { cat R*/k; }; f", loopCd],
    ["trap 'cat ../Docs/x' EXIT", docs],
    // review round 11: cd combined with a loop or function is blocked (directories follow text order only)
    ['for i in 1 2; do cat R*/k; cd ..; done', loopCd],
    ['for i in 1 2; do cat R?ts/k; cd ..; done', loopCd],
    ['while true; do cat D*/k; cd ..; done', loopCd],
    ['f() { cat R*/k; }; cd ..; f', loopCd],
    ['for i in 1 2; do cat $d/k; d=Rets; cd ..; done', loopCd],
    ['for i in 1 2; do ls; cd ..; done', loopCd],
    ['for i in 1 2; do grep -r tok; cd ..; done', loopCd],
    ['for i in 1 2; do cat Docs/x; cd ..; done', loopCd],
    ['function g { cat Docs/x; }; cd ..; g', loopCd],
    ['for p in cli web; do (cd packages/$p && pnpm build); done', loopCd],
    ['bash -c "for i in 1 2; do cd ..; done"', loopCd],
    // review round 10: a use checked against assignments written later in the text (loops, functions)
    ['for i in 1 2; do cat ~/W3/$a/x; a=Rets; done', 'secret path Rets'],
    ['while true; do cat ~/W3/$a/x; a=Rets; done', 'secret path Rets'],
    ['f(){ cat ~/W3/$a/x; }; a=Rets; f', 'secret path Rets'],
    ['until false; do ls $d; d=..; done', listing],
    ['x=b; x=$x/a; x=$x/a', 'variable values keep changing across passes; too complex to check'],
    // review round 9: every value a variable is given counts, whatever the order, subshell, or pipeline
    ['a=Rets; echo $(cat ~/W3/$a/x); a=ok', 'secret path Rets'],
    ['a=Rets; echo `cat ~/W3/$a/x`; a=ok', 'secret path Rets'],
    ['a=Rets; echo "$(cat ~/W3/$a/x)"; a=ok', 'secret path Rets'],
    ['a=Rets; x=$(cat ~/W3/$a/x); a=ok', 'secret path Rets'],
    ['a=Rets; echo $(cat ~/W3/$a/x) && a=ok', 'secret path Rets'],
    ['a=Rets; a=ok | true; cat ~/W3/$a/x', 'secret path Rets'],
    ['a=Rets; (a=ok); cat ~/W3/$a/x', 'secret path Rets'],
    ['a=Rets; echo $(a=ok); cat ~/W3/$a/x', 'secret path Rets'],
    ['d=Docs; d=x; cat ../$d/y', docs],
    // review round 8: brace alternatives are separate paths; literal variable values are substituted
    ['rg x {/home/tester,/tmp}', listing],
    ['rg x {/,/tmp}', listing],
    ['ls {/home,/tmp}', listing],
    ['rg x {~,/tmp}', listing],
    ['rg x {.,..}/..', listing],
    ['rg x /{h..h}ome', listing],
    ['cat {../Docs,/tmp}/x', docs],
    ['a=*; rg x /$a', wildcard],
    ['a=*; rg x /home/$a', wildcard],
    ['a=*; rg x ~/$a', wildcard],
    ['a=Rets; cat ~/W3/$a/x', 'secret path Rets'],
    ['a=~/W3; cd $a && cat Docs/x', listing],
    ['export D=/home; grep -r x "$D"', listing],
    ['p=..; q=Docs; cat $p/$q/x', listing],
    ['cd packages/cli; p=../../..; q=Docs; cat $p/$q/x', listing],
    ['cd packages; p=x/../../..; q=Docs; cat $p/$q/x', listing],
    ['cd packages; q=Docs; cat ../../$q/x', docs],
    ['q=Docs; cd ..; cat $q/x', docs],
    // review round 15: a quote after a variable keeps the name separate; flag values do not hide the cwd
    ['X=R; cat ~/W3/"$X"ets/k', 'secret path Rets'],
    ['cd ~/W3 && ls --color=auto', listing],
    ['cd ~/W3 && grep -rn x --exclude-dir=y', listing],
    // review round 7: a wildcard whose fixed part is ~/W3 or a folder above it
    ['rg x ~/*', wildcard],
    ['grep -r x $HOME/*', wildcard],
    ['find ~/* -name x', wildcard],
    ['ls -R ~/*', wildcard],
    ['grep -r x /home/*', wildcard],
    ['grep -r x /*', wildcard],
    ['rg x /home/J*', wildcard],
    ['a=/home/J*; grep -r x $a', wildcard],
    ['cat /home/*/W3/Rets/x', 'secret path Rets'],
    ['rg --files /home', listing],
    // review round 6: folders above ~ are roots too, and wildcards stored in variables count
    ['grep -r x /home', listing],
    ['rg x /home', listing],
    ['cp -r /home x', listing],
    ['tar c /home', listing],
    ['find /home -name x', listing],
    ['cd /home && ls', listing],
    ['a=../R*; cat $a/x', wildcard],
    ['a="../R*/x"; cat $a', wildcard],
    ['FOO=../R* cat $FOO', wildcard],
    ["export A='../R*'", wildcard],
    ['env A=../Do* cat $A', wildcard],
    // review round 5: escaped or ANSI-C quoted root is still the root
    ['ls \\/', listing],
    ['find \\/ -name x', listing],
    ["ls $'/'", listing],
    ["find $'/' -name x", listing],
    ["ls $'\\x2f'", listing],
    ['ls ~""', listing],
    // a bare / still counts as the root for tree tools; other root forms for any non-harmless command
    ['ls /', listing],
    ['ag tok /', listing],
    ['ln -s / r', listing],
    ['tar -cf x.tar /', listing],
    ['ls "/"', listing],
    ["grep -r tok '/'", listing],
    ['bash -c "grep -r tok /"', listing],
    ['xargs grep -r tok /', listing],
    ['xargs -I{} grep -r tok {} /', listing],
    ['git add ~', listing],
    ['node x.js ~/W3', listing],
    // two heredocs on one line: the shell one keeps its body checked
    ['cat <<EOF; bash <<X\nhi\nEOF\ncat ../Docs/x\nX', docs],
  ])('%s', (cmd, why) => {
    expect(check(cmd, home, repo)).toBe(why);
  });

  it('blocks, rather than crashes on, nesting deep enough to exhaust the stack', () => {
    expect(check('"$(echo '.repeat(2000), home, repo)).toBe('command nested too deeply to check');
    expect(check('$('.repeat(5000), home, repo)).toBe('command nested too deeply to check');
  });

  it('never throws on malformed input', () => {
    const odd = ['"unterminated', "'x", '$(', '$((', '`x', 'cat <<', 'cat <<EOF', 'cat <<EOF\nno end', '${', '\\', 'a >', '<<<', '((', '~+', "$'\\",
      '/=*\n?|&(~\'=>9/-~\nZ~|[\\-=', '~\\]";&/\n>(]"\\>&*Z".|-;\\/;\''];
    for (const s of odd) expect(() => check(s, home, repo)).not.toThrow();
  });

  it('checks a 64 KB command quickly', () => {
    const start = Date.now();
    check(`git ${'push '.repeat(13_000)}`, home, repo);
    expect(Date.now() - start).toBeLessThan(1_500);
  });
});

describe('guard protects entries that exist inside the repo (review round 14, simulated filesystem)', () => {
  const files = new Set([`${repo}/Rets`, `${repo}/wallets.json`, `${repo}/packages/cli/.env`]);
  const exists = (p) => files.has(p);
  const protectedGlob = 'wildcard can match a protected entry here (Rets, secrets, .env, wallets)';
  const protectedTree = 'recursive command run from, or aimed at, a folder that holds a protected entry (Rets, secrets, .env, wallets); cd into a subfolder first, or use the Grep or Glob tool';
  const protectedEntry = 'path through a protected entry (Rets, secrets, keystore, .env, wallets)';
  it.each([
    ['cat R*/k', repo, protectedGlob],
    ['cat [R]ets/k', repo, protectedGlob],
    ['cat ?ets/k', repo, protectedGlob],
    ['cat Re*', repo, protectedGlob],
    ['cat ./R*/k', repo, protectedGlob],
    ['cat */k', repo, protectedGlob],
    ['cat w*', repo, protectedGlob],
    ['cat packages/cli/.e*', repo, protectedGlob],
    ['cat ../R*/k', `${repo}/packages`, protectedGlob],
    ['cp -r R* /tmp/x', repo, protectedGlob],
    ['cat {R,S}ets/k', repo, protectedEntry],
    ['d=Re; cat ${d}ts/k', repo, protectedEntry],
    ['grep -r x .', repo, protectedTree],
    ['grep -rn x', repo, protectedTree],
    ['rg tok', repo, protectedTree],
    ['find . -name x', repo, protectedTree],
    ['cp -a . /tmp/x', repo, protectedTree],
    ['tar c .', repo, protectedTree],
    ['ls -R', repo, protectedTree],
    ['grep -r x cli', `${repo}/packages`, protectedTree],
    // review round 16: recursive commands are judged by where they run, not by guessing their words
    ['grep -r x packages/web', repo, protectedTree],
    ['find packages -name x', repo, protectedTree],
    ['rg -g "*.ts" x', repo, protectedTree],
    ['rg -t ts x', repo, protectedTree],
    ['rg -A 3 x', repo, protectedTree],
    ['fd -t f x', repo, protectedTree],
    ['fd -e ts x', repo, protectedTree],
    ['grep -r -A 3 x', repo, protectedTree],
    ['grep -r -m 1 x', repo, protectedTree],
    ['grep -rn --include "*.ts" x', repo, protectedTree],
    ['grep -r --exclude-dir node_modules x', repo, protectedTree],
    ['ag -G x y', repo, protectedTree],
    ['grep -rA3 x', repo, protectedTree],
    ['grep -rC2 x', repo, protectedTree],
    ['grep -rm1 x', repo, protectedTree],
    ['find ! -name x', repo, protectedTree],
    ['cp -r dist /tmp/x', repo, protectedTree],
    ['X=R; cat ${X:-q}ets/k', repo, built],
    ['X=R; cat ${X:+R}ets/k', repo, built],
    ['X=R; cat ${X:0:1}ets/k', repo, built],
    ['X=Rxx; cat ${X%xx}ets/k', repo, built],
    ['cat ${X:-R}ets/k', repo, protectedEntry],
    // review round 18: wrappers named by path are wrappers too
    ['cat <<EOF | /bin/bash\ncat ../Docs/x\nEOF', repo, docs],
    ['/usr/bin/env find .', repo, protectedTree],
    ['/usr/bin/timeout 5 find .', repo, protectedTree],
    ['/usr/bin/xargs find .', repo, protectedTree],
    ['/usr/bin/nice find .', repo, protectedTree],
    ['/usr/bin/sudo find .', repo, protectedTree],
    ['/usr/bin/nohup find .', repo, protectedTree],
    ['/usr/bin/setsid find .', repo, protectedTree],
    ['/usr/bin/busybox find .', repo, protectedTree],
    ['/usr/bin/time find .', repo, protectedTree],
    ['/usr/bin/env sh -c "ls ~/W3"', repo, listing],
    ['/usr/bin/env bash -c "find ."', repo, protectedTree],
    ['c=find; /usr/bin/env $c .', repo, protectedTree],
    // review round 17: parameter forms on known variables, more recursive tools, program names by path,
    // variable, or wrapper, and git reading ignored files
    ['X=Rets; cat ${X:-q}/k', repo, built],
    ['X=Rets; cat ${X%z}/k', repo, built],
    ['X=rets; cat ${X^}/k', repo, built],
    ['grep -d recurse x .', repo, protectedTree],
    ['grep --directories=recurse x .', repo, protectedTree],
    ['diff -r . /tmp/x', repo, protectedTree],
    ['gzip -rc .', repo, protectedTree],
    ['ugrep -r x', repo, protectedTree],
    ['ctags -R', repo, protectedTree],
    ['eza -R', repo, protectedTree],
    ['7za a x.7z .', repo, protectedTree],
    ['bsdtar -cf x.tar .', repo, protectedTree],
    ['/usr/bin/find .', repo, protectedTree],
    ['/usr/bin/grep -r x .', repo, protectedTree],
    ['f=find; $f .', repo, protectedTree],
    ['busybox find .', repo, protectedTree],
    ['setsid find .', repo, protectedTree],
    ['ionice -c 3 find .', repo, protectedTree],
    ['flock /tmp/l find .', repo, protectedTree],
    ['watch -n 5 "grep -r x ."', repo, protectedTree],
    ['git grep --untracked --no-exclude-standard x', repo, protectedTree],
    ['git diff --no-index . /tmp/empty', repo, protectedTree],
    ['git add -f .', repo, protectedTree],
    ['for d in Rets; do cat $d/k; done', repo, protectedEntry],
    ['cat $(echo R)ets/k', repo, built],
    // review round 15: POSIX classes, flag values, find without a path, quote boundaries, extglob
    ['cat [[:upper:]]ets/k', repo, protectedGlob],
    ['cat R[[:alpha:]]ts', repo, protectedGlob],
    ['cat [[:upper:]]*', repo, protectedGlob],
    ['cat [[.R.]]ets', repo, protectedGlob],
    ['cat [[=R=]]ets', repo, protectedGlob],
    ['grep -rn x --exclude-dir=node_modules', repo, protectedTree],
    ['grep -r x --include=*.ts', repo, protectedTree],
    ['ls -R --ignore=x', repo, protectedTree],
    ['tree -I x', repo, protectedTree],
    ['du --exclude foo', repo, protectedTree],
    ['rg -uu x -g "*.ts"', repo, protectedTree],
    ['ag x --ignore y', repo, protectedTree],
    ['find -name x', repo, protectedTree],
    ['fd -I x', repo, protectedTree],
    ['X=R; cat "$X"ets/k', repo, protectedEntry],
    ["X=R; cat $X'ets'/k", repo, protectedEntry],
    ['cat @(R)ets/k', repo, protectedGlob],
    ['cat !(x)', repo, protectedGlob],
  ])('%s (cwd %s)', (cmd, cwd, why) => {
    expect(check(cmd, home, cwd, exists)).toBe(why);
  });
  it.each([
    ['cat *.ts', repo],
    ['grep -r x web', `${repo}/packages`],
    ['rg tok engine/src', `${repo}/packages`],
    ['find web -name "*.ts"', `${repo}/packages`],
    ['grep -rn x . --exclude-dir=node_modules', `${repo}/packages`],
    ['du -sh web', `${repo}/packages`],
    ['cat ${X:-default}.txt', repo],
    ['tar tf a.tar', repo],
    ['tar xzf a.tgz', repo],
    ['git add packages/web/src/x.ts', repo],
    ['git diff --stat HEAD', repo],
    ['git grep -n x', repo],
    ['/usr/bin/env node -v', repo],
    ['/usr/bin/env pnpm test', repo],
    ['/usr/bin/timeout 60 pnpm test', repo],
    ['toString -x', repo],
    ['constructor -x', repo],
    ['f=cat; $f README.md', repo],
    ['for p in cli web; do echo $p; done', repo],
    ['ls -la', repo],
    ['ls', repo],
    ['grep -a x file.txt', repo],
    ['cat .*rc', repo],
    ['cat packages/engine/src/secrets.ts', repo],
    ['ls --color=auto packages', repo],
    ['X=packages; ls "$X"/web', repo],
    ['cat [a-c]*.md', repo],
  ])('%s (cwd %s)', (cmd, cwd) => {
    expect(check(cmd, home, cwd, exists)).toBeNull();
  });
});

describe('guard allows the repo and worktrees', () => {
  it.each([
    ['cat Docs/Live/PROJECT.md', repo],
    ['ls Docs/Live', repo],
    ['cd packages && cat ../Docs/Live/PROJECT.md', repo],
    ['cd packages/engine && ls', repo],
    ['ls', repo],
    ['find . -name "*.ts"', repo],
    ['cat ../../MintBot/Docs/Live/PROJECT.md', `${home}/W3/MintBot-wt/heartbeat`],
    [`cat ${repo}/Docs/Live/PROJECT.md`, `${home}/W3/MintBot-wt/heartbeat`],
    ['git -C ../MintBot-run log --oneline -1', repo],
    ['pnpm --dir packages/web build', repo],
    ['node -e "run()" && ls', repo],
    ['cd .. && cd MintBot && cat Docs/Live/PROJECT.md', repo],
    ['cat $FILE', repo],
    ['pnpm lint; echo "lint exit $?"', repo],
    ['echo "${PIPESTATUS[0]} ${S}/x $# $@"', repo],
    ['S=/tmp/x; grep -E "Tests" $S/log', repo],
    ['pnpm test 2>&1 | tail -5', repo],
    ['echo x > out.txt', repo],
    ['node -e "const f = (a) => a"', repo],
    ["tr / _ < in.txt", repo],
    ['git log --oneline e4ec74e..origin/main', repo],
    ['git diff main...HEAD', repo],
    ['echo $(git rev-parse HEAD)', repo],
    ["python3 - <<'EOF'\nx = a / b\nfor p in ['..', '/']: print(p)\nEOF", repo],
    ['cd ~/W3/MintBot && git status', `${home}/W3`],
    ['./node_modules/.bin/vitest run', repo],
    ['git push -u origin task/x; ls -f', repo],
    ['PATTERN="*.ts" pnpm lint', repo],
    ['ls ~/.claude/*', repo],
    ['mkdir -p {a,b}/c', repo],
    ['echo {1..3} {a,b}', repo],
    ['D=dist; rm -rf $D/*', repo],
    ['for f in src/*.ts; do echo $f; done', repo],
    ['v=1; echo "$v"', repo],
    ['for f in packages/*/package.json; do echo $f; done', repo],
    ['cd packages && for f in *.json; do echo $f; done', repo],
    ['cd /home/tester/W3/MintBot; for f in a b; do echo $f; done', repo],
    ["trap 'rm -f /tmp/x' EXIT; pnpm test", repo],
    ["alias ll='ls -la'; ll packages", repo],
    ["cd packages; alias ll='ls -la'", repo],
    ['$EDITOR notes.md', repo],
    ['git commit -m "fix function and for loop; cd docs"', repo],
    ['v=1; v=2; echo $v; S=/tmp/x; pnpm test > $S/log 2>&1', repo],
    ['for p in cli web; do d=packages/$p; ls $d; done', repo],
    ['cp packages/{cli,web}/package.json out/', repo],
    ['rm -f dist/*', repo],
    ['ls /tmp/*', repo],
    ['ls *', repo],
    ['cp packages/*/package.json out/', repo],
    ['rg --files packages', repo],
    ['ls /tmp /usr/lib', repo],
    ['cp dist/a.js /home/tester/W3/MintBot/out/', repo],
    // T-002 review round 5: words like ".", env, source, ssh elsewhere do not re-enable the prose false positive
    ['git add . && git commit -m "fix a / b"', repo],
    ['grep -rn "a / b" .', repo],
    ['pnpm test -t "a / b" -- .', repo],
    ['node -e "console.log(4 / 2)" && ls .', repo],
    ['git commit -m "fix env / config handling"', repo],
    ['git commit -m "source / sink naming"', repo],
    ['gh pr create --title "read / write guard" --body "ssh / exec notes"', repo],
    ['git commit -m "approx ~ 5 files" -m "use ~/W3 here"', repo],
    ['grep -rn "/" src', repo],
    ['echo $((4 / 2))', repo],
    ["git commit -m \"$(cat <<'EOF'\nT-002: guard\n\ncd .. && ls / and ~ notes\nEOF\n)\"", repo],
    // T-002 review round 4: " / " inside quoted prose or code is not the filesystem root
    ['git commit -m "add read / write split"', repo],
    ['gh pr create --title "a / b" --body "x / y"', repo],
    ['git commit -m "msg" -m "- a / b"', repo],
    ['grep "a / b" file.txt', repo],
    ['git log --grep "a / b"', repo],
    ['git grep -n "a / b" -- src', repo],
    ['pnpm test -t "a / b"', repo],
    ['node -e "console.log(4 / 2)"', repo],
    ["git commit -m \"$(cat <<'EOF'\nfix: a / b\nEOF\n)\"", repo],
    ['< in.txt sort > out.txt', repo],
    ['pnpm test 2>/dev/null >/dev/null', repo],
    ["cat <<'EOF' > tasks/notes.md\ncd .. && ls\nEOF", repo],
    ['git grep -n tok', repo],
    ['git grep --no-index tok packages', repo],
    ['grep -r tok packages', repo],
    ['grep -rn tok', repo],
    ['ls ~/.claude', repo],
  ])('%s (cwd %s)', (cmd, cwd) => {
    expect(check(cmd, home, cwd)).toBeNull();
  });
});

describe('normalize', () => {
  it('joins split strings, decodes escapes, and folds the home directory to ~', () => {
    expect(normalize(`"sec" + "rets" $'\\x2e'env ${home}/W3 \${HOME}/x`, home)).toBe('secrets $.env ~/W3 ~/x');
  });
});

describe('guard.sh wrapper', () => {
  it('blocks a matching command with exit 2', () => {
    const r = runHook(JSON.stringify({ tool_input: { command: 'git reset --hard' } }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('git reset --hard');
  });
  it('allows a normal command with exit 0', () => {
    expect(runHook(JSON.stringify({ tool_input: { command: 'pnpm test' } })).status).toBe(0);
  });
  it('resolves relative paths from the cwd in the hook input', () => {
    const r = runHook(JSON.stringify({ cwd: `${home}/W3`, tool_input: { command: 'cat Docs/x' } }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('off-limits docs backup');
  });
  it('fails closed on unreadable input', () => {
    const r = runHook('not json');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unreadable hook input');
  });
});
