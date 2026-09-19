import { createInterface } from 'node:readline';

const sensitiveKey = /(?:private|secret|token|password|passphrase|mnemonic|seed|calldata|rawtx|authorization|api.?key|chat[_.-]?id)/i;
const sensitiveValue = /(0x[0-9a-f]{64,}|-----BEGIN [^-]+PRIVATE KEY-----|(?:Bearer|Basic)\s+\S+|\b\d{6,12}:[A-Za-z0-9_-]{20,}\b)/gi;
const hostSecrets = [process.env.TG_BOT_TOKEN, process.env.TG_CHAT_ID].filter((value) => value);

function redactText(value) {
  return hostSecrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), value).replace(sensitiveValue, '[REDACTED]');
}

function redact(value, key = '') {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((entry) => redact(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry, name)]));
  }
  return typeof value === 'string' ? redactText(value) : value;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  try {
    console.log(JSON.stringify(redact(JSON.parse(line))));
  } catch {
    console.log(redactText(line));
  }
}
