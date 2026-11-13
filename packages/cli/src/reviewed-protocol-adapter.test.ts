import { describe, expect, it } from 'vitest';
import { REVIEWED_ERC721_PUBLIC_BASELINE, type Campaign, type BackendState, type ChainEvidenceRecord } from '@mint-bot/backend';
import { assertReviewedProtocolCampaignReady } from './engine-adapter.js';
const now=new Date('2026-11-13T12:00:00Z');
const scope={family:'erc721-reviewed-public-v1' as const,registryDigest:`sha256:${'a'.repeat(64)}`,descriptorDigest:`sha256:${'b'.repeat(64)}`};
const campaign={id:'campaign-one',chainId:1,strategy:'erc721-reviewed-public-v1',chainVerification:{chainId:1,status:'verified',seaDropCompatible:false,evidenceId:'reviewed-one',endpointReference:'rpc'},custodyPolicy:{provider:'turnkey',policyReference:'policy-one',policyDigest:'digest',recordDigest:'signed-digest',reviewedProtocol:scope}} as Campaign;
function state(){return {campaigns:[structuredClone(campaign)],chainEvidence:[{id:'reviewed-one',chainId:1,status:'accepted',executionEnabled:true,seaDropCompatible:false,strategyVersion:REVIEWED_ERC721_PUBLIC_BASELINE,expiresAt:'2026-12-01T00:00:00Z',reviewedProtocol:{family:scope.family,registryDigest:scope.registryDigest,descriptorDigests:[scope.descriptorDigest]}} as unknown as ChainEvidenceRecord]} satisfies Pick<BackendState,'campaigns'|'chainEvidence'>;}
describe('reviewed protocol final adapter gate',()=>{
 it('allows only the distinct current registry/descriptor/custody baseline',()=>{expect(()=>assertReviewedProtocolCampaignReady(campaign,state(),now)).not.toThrow();});
 it('rechecks expiry, revocation, chain and protocol drift after an awaited engine operation',()=>{
 for(const override of [{status:'rejected'},{executionEnabled:false},{chainId:8453},{seaDropCompatible:true},{strategyVersion:'seadrop-v1-public'},{expiresAt:now.toISOString()},{reviewedProtocol:{family:scope.family,registryDigest:'different',descriptorDigests:[scope.descriptorDigest]}}]){const current=state();Object.assign(current.chainEvidence[0]!,override);expect(()=>assertReviewedProtocolCampaignReady(campaign,current,now)).toThrow('REVIEWED_PROTOCOL_BASELINE_REQUIRED');}
 });
 it('refuses removed grant, changed owner record and a generic SeaDrop compatibility claim',()=>{
 const missing=state();missing.chainEvidence=[];expect(()=>assertReviewedProtocolCampaignReady(campaign,missing,now)).toThrow();
 const changed=state();changed.campaigns[0]!.custodyPolicy!.recordDigest='rotated';expect(()=>assertReviewedProtocolCampaignReady(campaign,changed,now)).toThrow();
 expect(()=>assertReviewedProtocolCampaignReady({...campaign,chainVerification:{...campaign.chainVerification,seaDropCompatible:true}},state(),now)).toThrow();
 });
});
