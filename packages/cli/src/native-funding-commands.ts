import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Argv } from 'yargs';
import { createTurnkeyFundingRecord, signTurnkeyFundingRecord, turnkeyFundingApproverKeyId, turnkeyFundingProviderPolicy, turnkeyFundingRecordDigest, verifyTurnkeyFundingRecord, type TurnkeyFundingRecord } from '@mint-bot/engine';
import { assertNoSymlinkParents, readProtectedText } from './turnkey-files.js';
export function fundingPolicyConfirmation(record: TurnkeyFundingRecord, publicKey: string): string {
 return `SIGN-FUNDING-POLICY ${turnkeyFundingRecordDigest(record).slice(-12)} CHAIN-${record.chainId} ${record.recipients.length}-WALLETS KEY-${turnkeyFundingApproverKeyId(publicKey).slice(-8)}`;
}
/** Offline owner tooling. Never connects to a provider, installs custody, or funds a wallet. */
export function registerNativeFundingCommands<T>(cli:Argv<T>):Argv<T>{
 cli.command('funding-policy <action>','Preview or sign a separate bounded native funding scope offline',args=>args
 .positional('action',{type:'string',choices:['preview','sign','verify'] as const,demandOption:true})
 .option('input',{type:'string',demandOption:true}).option('approver-public-key',{type:'string',demandOption:true})
 .option('approval-key',{type:'string'}).option('output',{type:'string'}).option('confirm',{type:'string'})
 .option('write',{type:'boolean',default:false}),async args=>{
  const output=(value:unknown)=>process.stdout.write(`${JSON.stringify(value,null,2)}\n`);
  try{
   const text=await readProtectedText(args.input,'TURNKEY_FUNDING_INPUT_PERMISSIONS_REQUIRED',true);
   if(Buffer.byteLength(text)>65536)throw new Error('TURNKEY_FUNDING_INPUT_INVALID');
   const value:unknown=JSON.parse(text);const publicKey=await readProtectedText(args.approverPublicKey,'TURNKEY_FUNDING_APPROVER_PERMISSIONS_REQUIRED',true);
   if(args.action==='verify'){const signed=verifyTurnkeyFundingRecord(value,publicKey);output({ok:true,recordDigest:signed.recordDigest,chainId:signed.record.chainId,walletCount:signed.record.recipients.length});return;}
   const record=createTurnkeyFundingRecord(value as Omit<TurnkeyFundingRecord,'walletSetDigest'|'budgetProfileDigest'>);const confirmation=fundingPolicyConfirmation(record,publicKey);
   if(args.action==='preview'||!args.write||args.confirm!==confirmation){output({preview:true,record,recordDigest:turnkeyFundingRecordDigest(record),providerPolicy:turnkeyFundingProviderPolicy(record),confirmation,activation:false});return;}
   if(!args.approvalKey||!args.output)throw new Error('TURNKEY_FUNDING_OFFLINE_SIGNATURE_ARGUMENTS_REQUIRED');
   const approval=await readProtectedText(args.approvalKey,'TURNKEY_FUNDING_APPROVAL_KEY_PERMISSIONS_REQUIRED',false);
   const signed=signTurnkeyFundingRecord(record,approval);verifyTurnkeyFundingRecord(signed,publicKey);
   await assertNoSymlinkParents(args.output,'TURNKEY_FUNDING_OUTPUT_PERMISSIONS_REQUIRED');
   const handle=await open(args.output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await handle.writeFile(`${JSON.stringify(signed,null,2)}\n`);await handle.sync();}finally{await handle.close();}
   output({ok:true,recordDigest:signed.recordDigest,chainId:record.chainId,walletCount:record.recipients.length,output:args.output,activation:false});
  }catch(error){output({state:'blocked',code:error instanceof Error&&/^TURNKEY_FUNDING_[A-Z_]{1,90}$/.test(error.message)?error.message:'TURNKEY_FUNDING_OFFLINE_COMMAND_FAILED'});}
 });return cli;
}
