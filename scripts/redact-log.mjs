import { createInterface } from 'node:readline';

const sensitiveKey = /(?:private|secret|token|password|passphrase|mnemonic|seed|calldata|rawtx|authorization|api.?key)/i;
const sensitiveValue = /(0x[0-9a-f]{64}|-----BEGIN [^-]+PRIVATE KEY-----|(?:Bearer|Basic)\s+\S+)/gi;

function redact(value, key = '') {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((entry) => redact(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry, name)]));
  }
  return typeof value === 'string' ? value.replace(sensitiveValue, '[REDACTED]') : value;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  try {
    console.log(JSON.stringify(redact(JSON.parse(line))));
  } catch {
    console.log(line.replace(sensitiveValue, '[REDACTED]'));
  }
}
