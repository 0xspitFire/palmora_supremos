import { resolve } from 'node:path';
import { CanonicalStoreBridge, pathKillSwitchProbe, PERSONAL_LIVE_FLEET_POLICY, loadHostSecretStore, loadServiceConfig } from '@mint-bot/backend';
import { openDatabase } from '@mint-bot/database';
import { createPublicClient, http, type Address } from 'viem';
import { getStrategy, resolveChainConfigFromSecrets, verifyTurnkeyFundingRecord, projectTurnkeyFundingPolicy, type SignedTurnkeyFundingRecord } from '@mint-bot/engine';
import { assertOpsEvidenceAccepted } from '../../../scripts/ops-evidence-runtime.mjs';
import { configuredSecretRoot, configuredWalletPath, configuredWallets } from './runtime.js';
import { createMintStageRuntime } from './mint-stage-runtime.js';
import { createPaidFundingRuntime } from './paid-funding-runtime.js';
import { readFundingRootFile } from './native-funding-worker.js';
import type { NativeFundingBrokerProfile } from './native-funding-runtime.js';
import type { PaidFundingCommandRuntime } from './paid-funding-commands.js';
/** Public owner queue writer only. It never constructs the funding coordinator,
 * IPC client, funding signer or worker and never opens the hub credential. */
export async function createPaidFundingOwnerRuntime(options:{projectRoot:string;ownerId:string;sessionId:string;environment?:NodeJS.ProcessEnv}):Promise<PaidFundingCommandRuntime>{
 const environment=options.environment??process.env;const config=loadServiceConfig(environment,options.projectRoot);
 if(config.mode!=='host'||!config.secretStorePath||!environment.MINT_BOT_FUNDING_PROFILE_PATH)throw new Error('PAID_FUNDING_NOT_CONFIGURED');
 const configuredOwner=(await loadHostSecretStore(config.secretStorePath)).get('TG_OWNER_USER_ID');
 if(!configuredOwner||!/^\d{1,20}$/.test(configuredOwner)||options.ownerId!==configuredOwner)throw new Error('PAID_FUNDING_OWNER_SESSION_REQUIRED');
 const profile=JSON.parse(await readFundingRootFile(environment.MINT_BOT_FUNDING_PROFILE_PATH)) as NativeFundingBrokerProfile;
 if(profile.version!==1||profile.role!=='mint-broker'||profile.enabled!==true||profile.killSwitchPath!==config.killSwitchPath)throw new Error('PAID_FUNDING_NOT_CONFIGURED');
 const publicKey=await readFundingRootFile(profile.ownerPublicKeyPath);const catalog=JSON.parse(await readFundingRootFile(profile.catalogPath)) as SignedTurnkeyFundingRecord[];
 if(!Array.isArray(catalog))throw new Error('PAID_FUNDING_NOT_CONFIGURED');
 const policies=catalog.map(record=>projectTurnkeyFundingPolicy(verifyTurnkeyFundingRecord(record,publicKey),publicKey,true)).filter(policy=>policy.chainId===1);
 if(policies.length!==1)throw new Error('PAID_FUNDING_NOT_CONFIGURED');const policy=policies[0]!;
 const store=new CanonicalStoreBridge(openDatabase(resolve(config.projectRoot,config.statePath)),{durable:true,fleetPolicy:PERSONAL_LIVE_FLEET_POLICY,walletKeyReferencePrefix:'turnkey-wallet-map'});
 try{
  await store.open();const session=store.telegramAccessRepository().openSession();if(!session||session.id!==options.sessionId||Date.parse(session.expiresAt)<=Date.now())throw new Error('PAID_FUNDING_OWNER_SESSION_REQUIRED');
  const secretRoot=configuredSecretRoot(config.projectRoot);const endpoints=(await resolveChainConfigFromSecrets(1,'mainnet',secretRoot)).rpcEndpoints;if(endpoints.length<2||new URL(endpoints[0]!).hostname===new URL(endpoints[1]!).hostname)throw new Error('PAID_FUNDING_INDEPENDENT_READERS_REQUIRED');
  const clients=endpoints.slice(0,2).map(endpoint=>createPublicClient({transport:http(endpoint,{timeout:10000,retryCount:0})}));
  const stage=createMintStageRuntime({store,readDrop:async campaign=>{const drops=await Promise.all(clients.map(client=>getStrategy(campaign.strategy).readDrop(client,campaign.contract as Address,1)));const semantic=(drop:typeof drops[number])=>JSON.stringify(drop,(_k,v:unknown)=>typeof v==='bigint'?v.toString():v);if(semantic(drops[0]!)!==semantic(drops[1]!))throw new Error('PAID_FUNDING_STAGE_DISAGREEMENT');return drops[0]!;},validate:async()=>{throw new Error('PAID_FUNDING_OWNER_CLI_CANNOT_SIMULATE');}});
  const wallets=async()=>{const fleet=(await configuredWallets(config.projectRoot,configuredWalletPath(config.projectRoot))).map(wallet=>wallet.address.toLowerCase());if(fleet.length!==policy.recipients.length||fleet.some(wallet=>!policy.recipients.some(recipient=>recipient.toLowerCase()===wallet)))throw new Error('PAID_FUNDING_CURRENT_FLEET_CHANGED');return fleet;};
  const forbidden=async():Promise<never>=>{throw new Error('PAID_FUNDING_OWNER_CLI_QUEUE_ONLY');};
  const service=createPaidFundingRuntime({store,ownerId:configuredOwner,stage:()=>stage,wallets,balance:async wallet=>{const values=await Promise.all(clients.map(client=>client.getBalance({address:wallet as Address,blockTag:'latest'})));if(values[0]!==values[1])throw new Error('PAID_FUNDING_BALANCE_DISAGREEMENT');return values[0]!;},coordinator:{prepareFunding:forbidden,fundHold:forbidden,reconcileFunding:forbidden,releaseFundingHold:forbidden},killSwitchOn:async()=>await pathKillSwitchProbe(config.killSwitchPath)||store.snapshot().killed,
   assertReady:async(campaign,selected)=>{await assertOpsEvidenceAccepted({environment});const perWallet=campaign.mintPriceWei*BigInt(campaign.quantity)+(campaign.feePolicy.totalFeeBudgetWei??0n);if(perWallet>policy.maxTransferWei||perWallet>policy.recipientMaxBalanceWei||perWallet*BigInt(selected.length)>policy.fleetMaxBalanceWei||perWallet*BigInt(selected.length)>campaign.spendPolicy.maxRunWei)throw new Error('PAID_FUNDING_LIMITS_EXCEEDED');const custody=store.snapshot().runtime.operational?.custody;if(!custody||custody.healthStatus!=='healthy'||custody.policyStatus!=='approved'||Date.parse(custody.expiresAt)<=Date.now())throw new Error('PAID_FUNDING_CUSTODY_REQUIRED');},simulate:forbidden,notify:async()=>undefined});
  return {service,owner:{ownerId:configuredOwner,sessionId:session.id,expiresAt:session.expiresAt},close:async()=>store.close()};
 }catch(error){store.close();throw error;}
}
