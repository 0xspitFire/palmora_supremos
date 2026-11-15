import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(join(root, 'ops/host/core-dump-policy.sh'), 'utf8');
const expected = 'kernel.core_pattern = |/bin/false\n';
const mock = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),child=require('node:child_process');
const command=path.basename(process.argv[1]),args=process.argv.slice(2),scenario=process.env.CORE_SCENARIO;
const directory=process.env.CORE_DIRECTORY,pattern=process.env.CORE_PATTERN,trace=process.env.CORE_TRACE;
if(command==='stat'){
 const target=args[2],format=args[1],mode=fs.lstatSync(target).mode;
 const isDirectory=target===directory;
 const owner=scenario==='wrong-owner'&&isDirectory?'999:0':'0:0';
 const text=format==='%f:%u:%g'?mode.toString(16)+':'+owner:owner+':'+(mode&511).toString(8);
 console.log(text);process.exit(scenario==='directory-stat-fail'&&isDirectory||scenario==='file-stat-fail'&&!isDirectory?1:0);
}
if(command==='id'){console.log(scenario==='nonroot'?'1000':'0');process.exit(scenario==='id-fail'?1:0);}
if(command==='cat'){
 process.stdout.write(fs.readFileSync(args[0]));
 process.exit(scenario==='policy-read-fail'&&args[0]!==pattern||scenario==='pattern-read-fail'&&args[0]===pattern?1:0);
}
if(command==='sysctl'){
 fs.appendFileSync(trace,'apply\\n');
 if(scenario==='sysctl-fail')process.exit(1);
 if(scenario!=='sysctl-no-effect')fs.writeFileSync(pattern,'|/bin/false\\n');
 process.exit(0);
}
if(command==='ln'){
 if(scenario==='publication-race'){fs.writeFileSync(args[1],'owner-race-policy\\n');process.exit(1);}
 const result=child.spawnSync('/usr/bin/ln',args,{stdio:'inherit'});process.exit(result.status??1);
}
throw new Error('unexpected mocked command');
`;
function fixture(work: (input: { directory: string; target: string; pattern: string; trace: string; run: (scenario?: string, mode?: string) => ReturnType<typeof spawnSync> }) => void) {
  const scratch = mkdtempSync(join(tmpdir(), 'core-policy-'));
  try {
    const directory = join(scratch, 'sysctl.d'), pattern = join(scratch, 'kernel-pattern'), bin = join(scratch, 'bin'), trace = join(scratch, 'trace');
    mkdirSync(directory, {mode: 0o700}); mkdirSync(bin);
    const target = join(directory, '99-mint-bot-no-coredumps.conf');
    writeFileSync(pattern, '|/usr/lib/systemd/systemd-coredump %P\n'); writeFileSync(trace, '');
    for (const command of ['stat', 'id', 'cat', 'sysctl', 'ln']) writeFileSync(join(bin, command), mock, {mode: 0o700});
    const script = join(scratch, 'policy.sh');
    // Root fixtures redirect only the two fixed system paths. All file
    // creation/publication, shell branches and postconditions execute for real
    // inside this private fixture; uid observation/sysctl are explicit mocks.
    writeFileSync(script, source.replaceAll('/etc/sysctl.d', directory).replaceAll('/proc/sys/kernel/core_pattern', pattern));
    const run = (scenario = '', mode = '--apply') => spawnSync('bash', [script, mode], {encoding:'utf8',env:{PATH:`${bin}:${process.env.PATH}`,CORE_SCENARIO:scenario,CORE_DIRECTORY:directory,CORE_PATTERN:pattern,CORE_TRACE:trace}});
    work({directory,target,pattern,trace,run});
  } finally { rmSync(scratch, {recursive:true,force:true}); }
}
describe('persistent discard-only host policy', () => {
  it('installs exclusively, verifies actual state, checks without mutation and reapplies without rewriting the owner file', () => fixture(({target,pattern,trace,run}) => {
    expect(run().status).toBe(0); expect(readFileSync(target,'utf8')).toBe(expected); expect(statSync(target).mode&0o777).toBe(0o644);
    expect(readFileSync(pattern,'utf8')).toBe('|/bin/false\n'); const inode=statSync(target).ino,mtime=statSync(target).mtimeMs;
    expect(run('','--check').status).toBe(0); expect(readFileSync(trace,'utf8')).toBe('apply\n');
    expect(run().status).toBe(0); expect(statSync(target).ino).toBe(inode); expect(statSync(target).mtimeMs).toBe(mtime);
  }));
  it('check mode reports absent policy without creating a file or applying anything', () => fixture(({target,trace,run}) => {
    expect(run('','--check').status).toBe(1); expect(existsSync(target)).toBe(false); expect(readFileSync(trace,'utf8')).toBe('');
  }));
  it.each(['wrong-owner','directory-stat-fail','nonroot','id-fail'])('fails before publication when inspection/identity is untrusted: %s', scenario => fixture(({target,trace,run}) => {
    expect(run(scenario).status).toBe(1); expect(existsSync(target)).toBe(false); expect(readFileSync(trace,'utf8')).toBe('');
  }));
  it('refuses a writable directory and a symlinked directory', () => {
    fixture(({directory,target,run}) => {chmodSync(directory,0o777);expect(run().status).toBe(1);expect(existsSync(target)).toBe(false);});
    fixture(({directory,trace,run}) => {rmSync(directory,{recursive:true});symlinkSync(dirname(directory),directory);expect(run().status).toBe(1);expect(readFileSync(trace,'utf8')).toBe('');});
  });
  it.each(['different-content','symlink','directory','wrong-mode','file-stat-fail','policy-read-fail'])('preserves owner material and refuses an unsafe existing policy: %s', scenario => fixture(({target,pattern,trace,run}) => {
    if(scenario==='symlink')symlinkSync(pattern,target);
    else if(scenario==='directory')mkdirSync(target);
    else {writeFileSync(target,scenario==='different-content'?'retained-owner-policy\n':expected,{mode:0o644});if(scenario==='wrong-mode')chmodSync(target,0o666);}
    const before=readFileSync(pattern,'utf8');const result=run(scenario);
    expect(result.status).toBe(1);expect(readFileSync(pattern,'utf8')).toBe(before);expect(readFileSync(trace,'utf8')).toBe('');
    if(scenario==='different-content')expect(readFileSync(target,'utf8')).toBe('retained-owner-policy\n');
  }));
  it.each(['sysctl-fail','sysctl-no-effect','pattern-read-fail'])('does not claim success after a failed/unverified kernel update: %s', scenario => fixture(({target,run}) => {
    const result=run(scenario);expect(result.status).toBe(1);expect(String(result.stdout)).not.toContain('CORE_PAYLOAD_STORAGE_DISABLED');
    expect(readFileSync(target,'utf8')).toBe(expected);
  }));
  it('cannot overwrite a policy created after its precheck', () => fixture(({target,trace,run}) => {
    expect(run('publication-race').status).toBe(1);expect(readFileSync(target,'utf8')).toBe('owner-race-policy\n');expect(readFileSync(trace,'utf8')).toBe('');
  }));
});
