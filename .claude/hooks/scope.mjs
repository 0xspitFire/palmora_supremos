#!/usr/bin/env node
// Subagent PreToolUse scope guard. Exit 2 blocks the call and shows stderr to the agent.
//   scope.mjs writes '<regex>'  -> Edit/Write only to files whose absolute path matches regex
//   scope.mjs git               -> Bash only for single read-only git commands
import { resolve } from 'node:path';

const [mode, pattern] = process.argv.slice(2);
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || '{}');
const tool = input.tool_input ?? {};
const block = (why) => { process.stderr.write(`Blocked by .claude/hooks/scope.mjs: ${why}\n`); process.exit(2); };

if (mode === 'writes') {
  if (!tool.file_path) process.exit(0);
  const target = resolve(input.cwd ?? process.cwd(), tool.file_path);
  if (!new RegExp(pattern).test(target)) block(`this agent may only write files matching ${pattern}; got ${target}`);
} else if (mode === 'git') {
  const cmd = String(tool.command ?? '').trim();
  const readOnlyGit = /^git (status|diff|log|show|rev-parse|merge-base|ls-files|blame|branch( -vv| -a| --list\b.*)?|worktree list)\b/;
  if (!readOnlyGit.test(cmd) || /[;&|<>`$]|--output/.test(cmd)) block('this agent may only run single read-only git commands');
} else {
  block(`unknown mode ${mode}`);
}
process.exit(0);
