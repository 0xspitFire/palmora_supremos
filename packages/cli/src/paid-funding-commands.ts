import type { Argv } from 'yargs';
import type { PaidFundingOwner, PaidFundingService } from './paid-funding-service.js';
export interface PaidFundingCommandRuntime {service:PaidFundingService;owner:PaidFundingOwner;close():Promise<void>;}
/** Owner-side command only records funding authority. Host worker owns execution;
 * a later normal /fire remains mandatory for every paid mint. */
export function registerPaidFundingCommands<T>(cli:Argv<T>,options:{runtime(ownerId:string,sessionId:string):Promise<PaidFundingCommandRuntime>;write?:(value:string)=>void}):Argv<T>{
 cli.command('paid-funding <action>','Preview/confirm bounded paid funding only; never mint',args=>args.positional('action',{type:'string',choices:['preview','confirm','status'] as const,demandOption:true}).option('owner-id',{type:'string',demandOption:true}).option('session-id',{type:'string',demandOption:true}).option('campaign-id',{type:'string'}).option('wallets',{type:'string'}).option('max-fee-gwei',{type:'number'}).option('request-id',{type:'string'}).option('confirm',{type:'string'}),async args=>{
  let runtime:PaidFundingCommandRuntime|undefined;const write=options.write??(text=>process.stdout.write(text));
  try{runtime=await options.runtime(args.ownerId,args.sessionId);let result:unknown;
   if(args.action==='status')result=runtime.service.status();
   else if(args.action==='preview'){if(!args.campaignId||!args.wallets||args.maxFeeGwei===undefined)throw new Error('PAID_FUNDING_PREVIEW_ARGUMENTS_REQUIRED');result=await runtime.service.preview(args.campaignId,args.wallets.split(','),args.maxFeeGwei,runtime.owner);}
   else {if(!args.requestId||!args.confirm)throw new Error('PAID_FUNDING_CONFIRM_ARGUMENTS_REQUIRED');result=await runtime.service.confirm(args.requestId,args.confirm,runtime.owner);}
   write(`${JSON.stringify(result,null,2)}\n`);
  }catch(error){write(`${JSON.stringify({state:'blocked',code:error instanceof Error&&/^PAID_FUNDING_[A-Z_]{1,90}$/.test(error.message)?error.message:'PAID_FUNDING_COMMAND_FAILED'})}\n`);}
  finally{await runtime?.close();}
 });return cli;
}
