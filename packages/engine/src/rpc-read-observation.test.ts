import { expect, it, vi } from 'vitest';
import { diagnosticRpcMethod, diagnosticRpcOutcome } from './rpc-read-observation.js';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
it('returns only allowlisted methods without echoing arguments or unsupported method names', () => {
 expect(diagnosticRpcMethod(JSON.stringify({method:'eth_getLogs',params:['private']}))).toBe('eth_getLogs');
 for (const value of ['private',JSON.stringify({method:'secret-method'}),JSON.stringify([{method:'eth_call'}]),'x'.repeat(131073)]) expect(diagnosticRpcMethod(value)).toBe('other');
});
it('distinguishes quota, rate limit, RPC error and malformed responses using fixed codes', () => {
 expect(diagnosticRpcOutcome(200,bytes({result:'0x1'}))).toBe('success');
 expect(diagnosticRpcOutcome(429,bytes({error:{message:'private'}}))).toBe('rate_limited');
 expect(diagnosticRpcOutcome(200,bytes({error:{code:429}}))).toBe('rate_limited');
 expect(diagnosticRpcOutcome(403,bytes({error:{message:'Monthly capacity limit exceeded.'}}))).toBe('monthly_capacity');
 expect(diagnosticRpcOutcome(403,bytes({error:{message:'Forbidden private key material'}}))).toBe('http_error');
 expect(diagnosticRpcOutcome(200,bytes({error:{code:3,message:'reverted'}}))).toBe('rpc_error');
 expect(diagnosticRpcOutcome(200,new Uint8Array([0]))).toBe('invalid_response');
});


it('does not decode oversized or adversarial bodies and preserves fixed HTTP rate-limit classification', () => {
 const decode=vi.spyOn(TextDecoder.prototype,'decode');
 try {
  const large=new TextEncoder().encode('monthly capacity '.repeat(100000));
  expect(diagnosticRpcOutcome(200,large)).toBe('uninspected');
  expect(diagnosticRpcOutcome(429,large)).toBe('rate_limited');
  expect(decode).not.toHaveBeenCalled();
 } finally { decode.mockRestore(); }
 const message='monthly capacity '.repeat(700);
 expect(diagnosticRpcOutcome(200,bytes({error:{code:-32000,message}}))).toBe('rpc_error');
 expect(diagnosticRpcOutcome(200,bytes({error:{message:'x'.repeat(512)+' monthly capacity exceeded'}}))).toBe('rpc_error');
});
