import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const violations = [];
const forbidden = [
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, name: 'private key material' },
  { pattern: /(?:mnemonic|seed phrase)\s*[:=]/i, name: 'mnemonic or seed phrase' },
  { pattern: /(?:api[_-]?key|secret|token)\s*[:=]\s*['"][^$]{12,}/i, name: 'hard-coded credential' },
];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    if (!entry.isFile() || !/\.(?:ts|tsx|js|mjs|json)$/.test(entry.name)) continue;
    const source = await readFile(path, 'utf8');
    for (const rule of forbidden) {
      if (rule.pattern.test(source)) violations.push(`${path}: ${rule.name}`);
    }
    if (/[ \t]+\r?\n/.test(source)) violations.push(`${path}: trailing whitespace`);
  }
}

await visit('packages');
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Source hygiene checks passed.');
}
