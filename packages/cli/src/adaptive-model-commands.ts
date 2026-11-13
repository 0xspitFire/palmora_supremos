import type { Argv } from 'yargs';
import { AdaptiveFeedbackController, feedbackSamplesFromOutcomes, measuredAnalyticsOutcomes, type AdaptiveGovernancePolicy, type BackendStore } from '@mint-bot/backend';
import { resolve } from 'node:path';
import { openDatabase } from '@mint-bot/database';
import { CanonicalStoreBridge } from '@mint-bot/backend';
import { readAdaptivePolicyProfile } from './roadmap-intelligence.js';
export interface AdaptiveModelCommandOptions {
 runtimeRoot:string; now?:()=>Date; write?:(text:string)=>void;
 policies?:(path:string|undefined,now:Date)=>Promise<readonly AdaptiveGovernancePolicy[]>;
 runtime?:()=>Promise<{store:BackendStore;close():void|Promise<void>}>;
}
/** Public reports plus explicit initial owner acceptance. No signer/provider is opened. */
export function registerAdaptiveModelCommands<T>(cli:Argv<T>,options:AdaptiveModelCommandOptions):Argv<T>{
 const now=options.now??(()=>new Date());const write=options.write??(text=>process.stdout.write(text));
 cli.command('adaptive-model <action>','Report, propose, accept and govern measured scoring epochs',args=>args
 .positional('action',{type:'string',choices:['status','propose','accept','promote','rollback'] as const,demandOption:true})
 .option('chain',{type:'number',choices:[1,8453,4663],demandOption:true})
 .option('policy-profile',{type:'string'}).option('candidate-id',{type:'string'}).option('confirm',{type:'string'})
 .option('write',{type:'boolean',default:false}),async args=>{
  let runtime:Awaited<ReturnType<NonNullable<AdaptiveModelCommandOptions['runtime']>>>|undefined;
  const output=(value:unknown)=>write(`${JSON.stringify(value,null,2)}\n`);
  try{
   const policies=await (options.policies??readAdaptivePolicyProfile)(args.policyProfile??process.env.MINT_BOT_ADAPTIVE_POLICY_PATH,now());
   const policy=policies.find(row=>row.chainId===args.chain);if(!policy)throw new Error('ADAPTIVE_OWNER_POLICY_REQUIRED');
   runtime=options.runtime?await options.runtime():await (async()=>{const store=new CanonicalStoreBridge(openDatabase(resolve(options.runtimeRoot,process.env.MINT_BOT_STATE_PATH??'Rets/state/backend.sqlite')));await store.open();return {store,close:()=>store.close()};})();
   const controller=new AdaptiveFeedbackController(runtime.store,policy,now);
   const events=runtime.store.snapshot().events;
   const samples=feedbackSamplesFromOutcomes(measuredAnalyticsOutcomes(events,now()),events,now()).filter(sample=>sample.chainId===args.chain);
   const candidates=events.filter(event=>event.type==='adaptive_model_candidate'&&(event.data.candidate as {chainId?:number}|undefined)?.chainId===args.chain).map(event=>event.data.candidate);
   if(args.action==='status'){output({chainId:args.chain,active:controller.active(policy.chainId)??null,measuredDecisionSamples:samples.length,minimumOutcomes:policy.minimumOutcomes,minimumCollections:policy.minimumCollections,candidates});return;}
   if(args.action==='propose'){if(!args.write){output({preview:true,chainId:args.chain,samples:samples.length,next:'Use --write to train and persist a candidate; this does not activate it.'});return;}output({candidate:await controller.propose(samples),active:false});return;}
   if(args.action==='rollback'){const phrase=`ROLLBACK-ADAPTIVE CHAIN-${args.chain}`;if(!args.write||args.confirm!==phrase){output({preview:true,confirmation:phrase,chainId:args.chain});return;}await controller.rollback();output({rolledBack:true,active:null});return;}
   if(!args.candidateId)throw new Error('ADAPTIVE_CANDIDATE_INVALID');
   const phrase=args.action==='accept'?controller.initialAcceptancePhrase(args.candidateId):`PROMOTE-ADAPTIVE ${args.candidateId.slice(-12)}`;
   const candidate=candidates.find(value=>(value as {id?:string}|undefined)?.id===args.candidateId);
   if(!args.write||args.confirm!==phrase){output({preview:true,confirmation:phrase,candidate: candidate??null,action:args.action});return;}
   if(args.action==='accept'){await controller.acceptInitialCandidate(args.candidateId,args.confirm);output({accepted:true,candidateId:args.candidateId,activated:false,next:'Review the promote preview, then confirm promotion.'});return;}
   output({active:await controller.promote(args.candidateId)});
  }catch(error){output({state:'blocked',code:error instanceof Error&&/^ADAPTIVE_[A-Z_]{1,90}$/.test(error.message)?error.message:'ADAPTIVE_OPERATOR_UNAVAILABLE'});}
  finally{await runtime?.close();}
 });return cli;
}
