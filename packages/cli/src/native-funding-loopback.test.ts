import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, type Hex } from 'viem';
import { createTurnkeyFundingRecord, signTurnkeyFundingRecord, projectTurnkeyFundingPolicy, turnkeyFundingProviderPolicy, TurnkeyFundingSigner, NativeFundingEngine, type TurnkeySignerClient } from '@mint-bot/engine';
import { createNativeFundingRpcReader } from './native-funding-worker.js';
import { startReviewedProtocolLocalChain } from './reviewed-protocol-local-fixture.js';
/** Synthetic local EVM exercise. Both adapters reach ONE Anvil; this is not
 * independent production-provider or chain-finality evidence. No real keys. */
describe.skipIf(process.env.MINT_BOT_LOCAL_PROTOCOL_REHEARSAL!=='true')('native funding on compiled-fixture local EVM',()=>{
 it('signs only after durable claim markers and broadcasts the exact shortfall once',async()=>{
 const local=await startReviewedProtocolLocalChain();
 try{
 const [first,second]=local.clients;const hub=privateKeyToAccount(generatePrivateKey()),recipient=privateKeyToAccount(generatePrivateKey());
 await first.request({method:'anvil_setBalance',params:[hub.address,'0x1c6bf526340000']} as never); // synthetic 0.008 ETH
 await first.request({method:'anvil_mine',params:['0x3']} as never);
 const owner=generateKeyPairSync('ed25519'),privatePem=owner.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicPem=owner.publicKey.export({format:'pem',type:'spki'}).toString();
 const at=new Date();const r=createTurnkeyFundingRecord({version:1,kind:'native-fleet-topup-v1',organizationId:'fixture-funding-org',mintOrganizationId:'fixture-mint-org',userId:'fixture-funding-user',keyId:'fixture-hub',policyId:'fixture-native-only',chainId:1,hub:hub.address,recipients:[recipient.address],issuedAt:at.toISOString(),expiresAt:new Date(+at+86400000).toISOString(),maxTransferWei:'4100000000000000',rollingPrincipalCapWei:'8500000000000000',rollingFeeCapWei:'200000000000000',maxTransferFeeWei:'20000000000000',hubMaxBalanceWei:'8700000000000000',recipientMaxBalanceWei:'4100000000000000',fleetMaxBalanceWei:'8500000000000000',gasLimitMax:'21000',maxFeePerGas:'200000000',maxPriorityFeePerGas:'100000000'});
 const envelope=signTurnkeyFundingRecord(r,privatePem);let signs=0;const markers:string[]=[];
 const sdk={getWhoami:async()=>({organizationId:r.organizationId,userId:r.userId}),getOrganizationConfigs:async()=>({configs:{quorum:{threshold:1,userIds:['fixture-offline-owner']}}}),getPolicies:async()=>({policies:[{policyId:r.policyId,...turnkeyFundingProviderPolicy(r)}]}),getPrivateKeys:async()=>({privateKeys:[{privateKeyId:r.keyId,curve:'CURVE_SECP256K1',isExported:false,addresses:[{format:'ADDRESS_FORMAT_ETHEREUM',address:hub.address}]}]}),signTransaction:async(input:{signWith:string;unsignedTransaction:Hex})=>{expect(markers).toEqual(['signing']);signs++;const signed=await hub.signTransaction(parseTransaction(input.unsignedTransaction) as never);return {signedTransaction:signed,activity:{id:'fixture-activity',fingerprint:'fixture-fingerprint',organizationId:r.organizationId,status:'ACTIVITY_STATUS_COMPLETED',type:'ACTIVITY_TYPE_SIGN_TRANSACTION_V2',intent:{signTransactionIntentV2:{...input,type:'TRANSACTION_TYPE_ETHEREUM'}},result:{signTransactionResult:{signedTransaction:signed}}}};}} as unknown as TurnkeySignerClient;
 const signer=new TurnkeyFundingSigner({catalog:[envelope],publicKey:publicPem,chainId:1,client:sdk});
 const engine=new NativeFundingEngine({readers:[{endpoint:'https://fixture-reader-one.invalid',client:createNativeFundingRpcReader(first)},{endpoint:'https://fixture-reader-two.invalid',client:createNativeFundingRpcReader(second)}],signer,broadcast:async signed=>{expect(markers).toEqual(['signing','signed','unknown']);return first.sendRawTransaction({serializedTransaction:signed});}});
 const digest=`sha256:${'d'.repeat(64)}`;const request={id:'fixture-fund-one',parentRunId:'fixture-parent',parentHoldId:'fixture-parent',parentHoldDigest:digest,chainId:1 as const,recipient:recipient.address,requiredBalanceWei:100000000000000n,expiresAt:new Date(Date.now()+600000).toISOString()};const policy=projectTurnkeyFundingPolicy(envelope,publicPem,true);
 const preparation=await engine.prepare(request,policy);expect(preparation.valueWei).toBe(request.requiredBalanceWei);
 const before=await first.getBalance({address:hub.address});const result=await engine.execute({request,policy,preparation,state:'reserved'},{assertCurrent:async()=>undefined,claimForSigning:async()=>{markers.push('signing');},persistSigned:async()=>{markers.push('signed');},markBroadcasting:async()=>{markers.push('unknown');},markSubmitted:async()=>{markers.push('submitted');}});
 const receipt=await first.waitForTransactionReceipt({hash:result.hash as Hex,pollingInterval:50});expect(receipt.status).toBe('success');expect(await first.getBalance({address:recipient.address})).toBe(request.requiredBalanceWei);
 expect(before-await first.getBalance({address:hub.address})).toBe(request.requiredBalanceWei+receipt.gasUsed*receipt.effectiveGasPrice);expect(signs).toBe(1);expect(markers).toEqual(['signing','signed','unknown','submitted']);
 await first.request({method:'anvil_mine',params:['0x3']} as never);await expect(engine.prepare(request,policy)).rejects.toThrow('ALREADY_FUNDED');expect(signs).toBe(1);
 }finally{await local.close();}
 },30000);
});
