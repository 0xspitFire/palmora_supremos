import { redactText } from './observability.js';
export type BackendErrorCode = 'KILLED' | 'SPEND_CAP_EXCEEDED' | 'DAILY_SPEND_CAP_EXCEEDED' | 'EVIDENCE_REQUIRED' | 'SIMULATION_REQUIRED' | 'STATE_CONFLICT' | 'INVALID_INPUT' | 'NOT_FOUND' | 'DEPENDENCY_UNAVAILABLE' | 'UNKNOWN';
export interface NormalizedError { code: BackendErrorCode; message: string; retryable: boolean; }
export function normalizeError(error: unknown): NormalizedError {
  const raw = error instanceof Error ? error.message : String(error); const message = redactText(raw).slice(0, 512);
  const code: BackendErrorCode = message.includes('KILLED') ? 'KILLED' : message.includes('DAILY_SPEND_CAP_EXCEEDED') ? 'DAILY_SPEND_CAP_EXCEEDED' : message.includes('SPEND_CAP_EXCEEDED') ? 'SPEND_CAP_EXCEEDED' : message.includes('EVIDENCE') ? 'EVIDENCE_REQUIRED' : message.includes('SIMULATION') ? 'SIMULATION_REQUIRED' : message.includes('NOT_FOUND') ? 'NOT_FOUND' : message.includes('TRANSITION') || message.includes('ALREADY_') || message.includes('NOT_ARMED') ? 'STATE_CONFLICT' : message.includes('UNAVAILABLE') ? 'DEPENDENCY_UNAVAILABLE' : message.startsWith('INVALID_') ? 'INVALID_INPUT' : 'UNKNOWN';
  return { code, message, retryable: code === 'DEPENDENCY_UNAVAILABLE' };
}
