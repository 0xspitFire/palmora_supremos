import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {openDatabase,DurableRepository} from '@mint-bot/database';
import {CanonicalStoreBridge} from './canonical-store.js';
import {EvidenceService,REVIEWED_ERC721_PUBLIC_BASELINE} from './evidence.js';
import {fixture,close,campaign,campaignInput,armed,WALLET_ONE,OPEN_FLEET_POLICY,ETHEREUM,BASE,ROBINHOOD,NOW} from './canonical-fixtures.js';
import {revokeEthereumChainEvidence,ethereumChainEvidenceRevokePhrase} from './personal-live-readiness.js';
import type {ChainEvidenceRecord} from './types.js';
function evidence(chainId:1|8453|4663):ChainEvidenceRecord{return {id:`reviewed-${chainId}`,chainId,status:'pending',executionEnabled:false,seaDropCompatible:false,positiveLivePath:true,archiveForkPassed:true,reconciliationPassed:true,finalityPassed:true,negativeCases:{revert:true,sold_out:true,price_drift:true,insufficient_funds:true,quantity_limit:true,stale_phase:true,fee_recipient:true,kill:true,cap:true},endpointIdentity:chainId===4663?'https://sequencer.mainnet.chain.robinhood.com':'configured-primary',...(chainId===4663?{archiveEndpointIdentity:'Rets/MINT_BOT_SECRETS.env:ROBINHOOD_RPC_URL'}:{}),strategyVersion:REVIEWED_ERC721_PUBLIC_BASELINE,sourceBlock:10n,sourceBlockHash:`0x${'a'.repeat(64)}`,checkedAt:NOW,expiresAt:'2099-01-01T00:00:00.000Z',reviewedProtocol:{family:'erc721-reviewed-public-v1',registryDigest:`sha256:${'1'.repeat(64)}`,descriptorDigests:[`sha256:${'2'.repeat(64)}`]}};}
describe('distinct reviewed baseline durable persistence',()=>{
 it.each([ETHEREUM,BASE,ROBINHOOD])('persists/revokes chain %s independently of legacy profile and reads exact registry after SQLite restart',async chainId=>{const f=await fixture(chainId);let reader:CanonicalStoreBridge|undefined;try{
  const profileBefore=f.db.prepare('SELECT execution_enabled,verification_status FROM chain_profile WHERE chain_id=?').get(chainId);const legacy=f.store.snapshot().chainEvidence;
  const service=new EvidenceService(f.store,()=>new Date(NOW),{verify:(_record,approval)=>approval.proof==='owner-proof'});const record=evidence(chainId);
  await service.recordChainEvidence(record);await service.acceptChainEvidence(record.id,{verifierId:'owner-cli',proof:'owner-proof',acceptedAt:NOW});
  expect(f.db.prepare('SELECT execution_enabled,verification_status FROM chain_profile WHERE chain_id=?').get(chainId)).toEqual(profileBefore);
  const reopen=async()=>{reader?.close();reader=new CanonicalStoreBridge(openDatabase(join(f.directory,'state.sqlite')),{now:()=>new Date(NOW)});await reader.open();return reader;};
  const first=await reopen();expect(first.snapshot().chainEvidence.find(value=>value.id===record.id)).toMatchObject({reviewedProtocol:record.reviewedProtocol,seaDropCompatible:false,status:'accepted'});
  expect(first.snapshot().chainEvidence.filter(value=>legacy.some(old=>old.id===value.id))).toEqual(legacy);
  await f.store.transaction(state=>{state.chainEvidence.find(value=>value.id===record.id)!.executionEnabled=false;});
  const restarted=await reopen();expect(restarted.snapshot().chainEvidence.find(value=>value.id===record.id)?.executionEnabled).toBe(false);expect(f.db.prepare('SELECT execution_enabled,verification_status FROM chain_profile WHERE chain_id=?').get(chainId)).toEqual(profileBefore);
 }finally{reader?.close();await close(f);}});
 it('rejects malformed/legacy/mislabeled baselines atomically at the database writer',async()=>{const f=await fixture(ETHEREUM);try{const repo=new DurableRepository(f.db);const source=evidence(1);for(const change of [{strategyVersion:'erc721-reviewed-public-v1-baseline@2'},{seaDropCompatible:true},{reviewedProtocol:{...source.reviewedProtocol,registryDigest:'bad'}},{archiveForkPassed:false},{negativeCases:{...source.negativeCases,kill:false}}]){
  const before=f.db.prepare('SELECT COUNT(*) AS count FROM chain_verification').get();expect(()=>repo.recordChainVerification({id:'bad',chainProfileId:'profile-1',chainId:1,status:'verified',executionEnabled:true,approvedBy:'owner-cli',approvedAt:NOW,checkedAt:NOW,evidence:{...source,status:'accepted',executionEnabled:true,approvalProof:'owner-proof',...change}})).toThrow(/Reviewed protocol/);expect(f.db.prepare('SELECT COUNT(*) AS count FROM chain_verification').get()).toEqual(before);
 }}finally{await close(f);}});
});


async function acceptReviewed(f:Awaited<ReturnType<typeof fixture>>,record=evidence(1)){
 const service=new EvidenceService(f.store,()=>new Date(NOW),{verify:()=>true});await service.recordChainEvidence(record);await service.acceptChainEvidence(record.id,{verifierId:'owner-cli',proof:'owner-reviewed-protocol',acceptedAt:NOW});return record;
}
async function genericCampaign(f:Awaited<ReturnType<typeof fixture>>,record:ChainEvidenceRecord){
 const scope={family:'erc721-reviewed-public-v1' as const,registryDigest:record.reviewedProtocol!.registryDigest,descriptorDigest:record.reviewedProtocol!.descriptorDigests[0]!};
 return f.application.createCampaign({...campaignInput(1),strategy:'erc721-reviewed-public-v1',custodyPolicy:{provider:'turnkey',policyReference:`turnkey:generic:0x${'b'.repeat(64)}`,policyDigest:`0x${'b'.repeat(64)}`,recordDigest:`sha256:${'c'.repeat(64)}`,reviewedProtocol:scope},chainVerification:{chainId:1,status:'verified',seaDropCompatible:false,evidenceId:record.id,checkedAt:record.checkedAt,sourceBlock:record.sourceBlock,endpointReference:record.endpointIdentity}});
}
describe('family-scoped canonical chain admission',()=>{
 it.each(['revoked','expired'] as const)('keeps valid SeaDrop projection and actual SQLite admission when the later reviewed baseline is %s',async decision=>{
  let at=Date.parse(NOW);const f=await fixture(1,false,true,'2099-01-01T00:00:00.000Z',true,undefined,()=>new Date(at));let restarted:CanonicalStoreBridge|undefined;
  try{const sea=await campaign(f,1);const record=evidence(1);if(decision==='expired')record.expiresAt=new Date(at+1000).toISOString();await acceptReviewed(f,record);
   if(decision==='revoked')await f.store.transaction(state=>{state.chainEvidence.find(value=>value.id===record.id)!.executionEnabled=false;});else at+=2000;
   restarted=new CanonicalStoreBridge(openDatabase(join(f.directory,'state.sqlite')),{now:()=>new Date(at),fleetPolicy:OPEN_FLEET_POLICY});await restarted.open();
   const projected=restarted.snapshot().campaigns.find(value=>value.id===sea.id)!;expect(projected.chainVerification).toMatchObject({status:'verified',seaDropCompatible:true,evidenceId:'verification-1',sourceBlock:1n,checkedAt:NOW});
   const prepared=await armed(f,projected,[WALLET_ONE]);await expect(restarted.admitExecution(prepared.input)).resolves.toMatchObject({reservations:expect.any(Array)});
   expect(f.db.prepare('SELECT COUNT(*) AS count FROM spend_reservation').get()).toEqual({count:1});
  }finally{restarted?.close();await close(f);}
 });
 it('does not authorize a missing/revoked/expired generic binding from a valid later SeaDrop record',async()=>{
  for(const mode of ['missing','revoked','expired','registry','descriptor'] as const){let at=Date.parse(NOW);const f=await fixture(1,false,true,'2099-01-01T00:00:00.000Z',true,undefined,()=>new Date(at));try{
   const record=evidence(1);if(mode==='expired')record.expiresAt=new Date(at+1000).toISOString();await acceptReviewed(f,record);const value=await genericCampaign(f,record);const prepared=await armed(f,value,[WALLET_ONE]);
   if(mode==='missing')prepared.input.campaign.chainVerification.evidenceId='missing';if(mode==='revoked')await f.store.transaction(state=>{state.chainEvidence.find(item=>item.id===record.id)!.executionEnabled=false;});if(mode==='expired')at+=2000;if(mode==='registry')prepared.input.campaign.custodyPolicy!.reviewedProtocol!.registryDigest=`sha256:${'d'.repeat(64)}`;if(mode==='descriptor')prepared.input.campaign.custodyPolicy!.reviewedProtocol!.descriptorDigest=`sha256:${'e'.repeat(64)}`;
   await expect(f.store.admitExecution(prepared.input)).rejects.toThrow('CHAIN_VERIFICATION_REQUIRED');expect(f.db.prepare('SELECT COUNT(*) AS count FROM spend_reservation').get()).toEqual({count:0});
  }finally{await close(f);}}
 });
 it('honors chain-wide owner Ethereum revocation even with a later separate generic baseline',async()=>{
  const f=await fixture(1);try{const record=await acceptReviewed(f);const value=await genericCampaign(f,record);const prepared=await armed(f,value,[WALLET_ONE]);
   // The actual owner command must select its legacy chain-wide anchor, then disable both protocol scopes.
   await revokeEthereumChainEvidence(f.store,'verification-1',ethereumChainEvidenceRevokePhrase('verification-1'),()=>new Date(Date.parse(NOW)+1000));
   expect(f.db.prepare('SELECT execution_enabled FROM chain_profile WHERE chain_id=1').get()).toEqual({execution_enabled:0});expect(f.store.snapshot().chainEvidence.find(item=>item.id===record.id)?.executionEnabled).toBe(false);await expect(f.store.admitExecution(prepared.input)).rejects.toThrow('CHAIN_EXECUTION_DISABLED');
  }finally{await close(f);}
 });
 it('admits an exact current generic family despite a later unrelated expired legacy evidence row',async()=>{
  let at=Date.parse(NOW);const f=await fixture(1,false,true,'2099-01-01T00:00:00.000Z',true,undefined,()=>new Date(at));try{const record=await acceptReviewed(f);const value=await genericCampaign(f,record);
   // A later legacy scope can expire while the chain stays operational. It cannot replace generic evidence.
   const old=f.store.snapshot().chainEvidence.find(item=>item.id==='verification-1')!;const {acceptedAt:_at,acceptedBy:_by,approvalProof:_proof,...publicFields}=old;const sea={...publicFields,id:'later-seadrop',status:'pending' as const,executionEnabled:false,checkedAt:new Date(at+1000).toISOString(),expiresAt:new Date(at+2000).toISOString()};const service=new EvidenceService(f.store,()=>new Date(at+1000),{verify:()=>true});await service.recordChainEvidence(sea);await service.acceptChainEvidence(sea.id,{verifierId:'owner-cli',proof:'owner-seadrop',acceptedAt:new Date(at+1000).toISOString()});at+=3000;
   const projected=f.store.snapshot().campaigns.find(item=>item.id===value.id)!;expect(projected.chainVerification).toMatchObject({status:'verified',seaDropCompatible:false,evidenceId:record.id,sourceBlock:record.sourceBlock});const prepared=await armed(f,projected,[WALLET_ONE]);await expect(f.store.admitExecution(prepared.input)).resolves.toMatchObject({reservations:expect.any(Array)});
  }finally{await close(f);}
 });
});

it('cannot turn the chain-wide Ethereum switch back on by accepting a new generic baseline',async()=>{const f=await fixture(1);try{
 await revokeEthereumChainEvidence(f.store,'verification-1',ethereumChainEvidenceRevokePhrase('verification-1'),()=>new Date(NOW));const record=await acceptReviewed(f);const value=await genericCampaign(f,record);const prepared=await armed(f,value,[WALLET_ONE]);
 expect(f.db.prepare('SELECT execution_enabled FROM chain_profile WHERE chain_id=1').get()).toEqual({execution_enabled:0});expect(f.store.snapshot().campaigns.find(item=>item.id===value.id)?.chainVerification.status).toBe('blocked');await expect(f.store.admitExecution(prepared.input)).rejects.toThrow('CHAIN_EXECUTION_DISABLED');expect(f.db.prepare('SELECT COUNT(*) AS count FROM spend_reservation').get()).toEqual({count:0});
}finally{await close(f);}});
