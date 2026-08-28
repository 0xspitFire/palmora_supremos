export type BackendErrorCode = 'KILLED' | 'SPEND_CAP_EXCEEDED' | 'SIMULATION_REQUIRED' | 'INVALID_INPUT' | 'NOT_FOUND' | 'UNKNOWN';
export interface NormalizedError { code: BackendErrorCode; message: string; retryable: boolean; }
const secrets = /(passphrase|private\s*key|calldata|provider\s*payload|credential|authorization)\s*[:=]\s*[^,\s]+/gi;
export function normalizeError(error: unknown): NormalizedError {
  const raw = error instanceof Error ? error.message : String(error); const message = raw.replace(secrets, '$1=[REDACTED]');
  const code: BackendErrorCode = message.includes('KILLED') ? 'KILLED' : message.includes('SPEND_CAP_EXCEEDED') ? 'SPEND_CAP_EXCEEDED' : message.includes('SIMULATION_REQUIRED') ? 'SIMULATION_REQUIRED' : message.includes('NOT_FOUND') ? 'NOT_FOUND' : 'UNKNOWN';
  return { code, message, retryable: code === 'UNKNOWN' };
}
