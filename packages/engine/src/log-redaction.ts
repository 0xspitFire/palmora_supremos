/** Output boundary shared by engine logs and persisted provider-error summaries. */
const MASK = '[REDACTED]';
const sensitiveKey = /^(?:privatekey|mnemonic|seed|passphrase|password|token|accesstoken|refreshtoken|apitoken|authorization|apikey|apisecret|secret|calldata|rawtx|rawtransaction|payload|providerurl|endpointurl|rpcurl|url|headers|request|body|data|signature)$/;
const sensitiveCompoundKey = /(?:privatekey|privkey|apikey|apisecret|mnemonic|passphrase|password|authorization|accesstoken|refreshtoken|apitoken|calldata|rawtransaction|rawtx|signature|rpcurl|providerurl|endpointurl)/;
const opaqueReference = /^(?:txhash|transactionhash|blockhash|recorddigest|policydigest|walletmapdigest)$/i;

export function redactEngineText(value: string): string {
  return value
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[endpoint]')
    .replace(/\b(?:authorization\s*[:=]\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/gi, MASK)
    .replace(/\b(?:private[_-]?key|mnemonic|seed|passphrase|password|api[_-]?(?:key|secret)|token|secret|authorization)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, MASK)
    .replace(/0x[0-9a-f]{8,}/gi, '[hex]');
}

/** Never invoke toJSON/getters or serialize arbitrary error causes at this boundary. */
export function redactEngineValue(value: unknown, key = '', seen = new WeakSet<object>(), depth = 0): unknown {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (sensitiveKey.test(normalizedKey) || sensitiveCompoundKey.test(normalizedKey)) return MASK;
  if (typeof value === 'string' && /(?:err|error|reason|stack|details|shortmessage)/i.test(key) && !/^[A-Z][A-Z0-9_:-]{0,159}$/.test(value)) return '[ERROR_REDACTED]';
  if (typeof value === 'string') return opaqueReference.test(key) && /^0x[0-9a-f]{64}$/i.test(value) ? value : redactEngineText(value);
  if (typeof value === 'function') return '[function]';
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 12 || seen.has(value)) return '[bounded]';
  seen.add(value);
  if (value instanceof Error) {
    // Upstream Error messages/stacks can contain request dumps and unlabelled credentials.
    // Classify the error at the caller before this output-only boundary.
    return { type: 'Error', message: '[UPSTREAM_ERROR_REDACTED]' };
  }
  if (Array.isArray(value)) return value.map((entry) => redactEngineValue(entry, '', seen, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [entryKey, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || ['__proto__', 'prototype', 'constructor', 'toJSON', 'hasOwnProperty'].includes(entryKey)) continue;
    output[redactEngineText(entryKey)] = 'value' in descriptor ? redactEngineValue(descriptor.value, entryKey, seen, depth + 1) : '[accessor]';
  }
  return output;
}
