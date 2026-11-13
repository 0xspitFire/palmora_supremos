import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({owner:'123',session:'session',closed:vi.fn(),files:vi.fn(),db:vi.fn(),rpc:vi.fn(),state:{campaigns:[] as unknown[],events:[] as unknown[],runtime:{startupState:'Ready',operational:{custody:{healthStatus:'healthy',policyStatus:'approved',expiresAt:'2099-01-01T00:00:00Z'}}},killed:false}}));
vi.mock('@mint-bot/backend',async()=>{const real=await vi.importActual<typeof import('@mint-bot/backend')>('@mint-bot/backend');return {...real,loadServiceConfig:()=>({mode:'host',secretStorePath:'/synthetic/host-secrets',projectRoot:'/synthetic',statePath:'state.sqlite',killSwitchPath:'/synthetic/kill'}),loadHostSecretStore:async()=>new Map([['TG_OWNER_USER_ID',mocks.owner]]),CanonicalStoreBridge:class{open=async()=>undefined;close=mocks.closed;snapshot=()=>mocks.state;transaction=async(fn:(s:typeof mocks.state)=>void)=>fn(mocks.state);telegramAccessRepository=()=>({openSession:()=>({id:mocks.session,expiresAt:'2099-01-01T00:00:00Z'})});}};});
vi.mock('@mint-bot/database',async()=>({...await vi.importActual<object>('@mint-bot/database'),openDatabase:(...args:unknown[])=>mocks.db(...args)}));
vi.mock('./native-funding-worker.js',()=>({readFundingRootFile:(path:string)=>mocks.files(path)}));
vi.mock('./runtime.js',()=>({configuredSecretRoot:()=>'/synthetic/mint-public',configuredWalletPath:()=>'/synthetic/wallet-map',configuredWallets:async()=>[{address:`0x${'1'.repeat(40)}`}]}));
vi.mock('../../../scripts/ops-evidence-runtime.mjs',()=>({assertOpsEvidenceAccepted:async()=>undefined}));
vi.mock('@mint-bot/engine',async()=>({...await vi.importActual<object>('@mint-bot/engine'),verifyTurnkeyFundingRecord:(value:unknown)=>value,projectTurnkeyFundingPolicy:()=>({chainId:1,recipients:[`0x${'1'.repeat(40)}`],maxTransferWei:1000n,recipientMaxBalanceWei:1000n,fleetMaxBalanceWei:10000n}),resolveChainConfigFromSecrets:async()=>({rpcEndpoints:['https://first.example','https://second.example']}),getStrategy:()=>({readDrop:async()=>{throw new Error('UNUSED_PREVIEW');}})}));
vi.mock('viem',async()=>({...await vi.importActual<object>('viem'),createPublicClient:()=>({getBalance:mocks.rpc})}));
import {createPaidFundingOwnerRuntime} from './paid-funding-owner-runtime.js';
beforeEach(()=>{vi.clearAllMocks();mocks.owner='123';mocks.session='session';mocks.state.events=[];mocks.files.mockImplementation(async(path:string)=>path==='/synthetic/profile'?JSON.stringify({version:1,role:'mint-broker',enabled:true,killSwitchPath:'/synthetic/kill',ownerPublicKeyPath:'/synthetic/owner.pub',catalogPath:'/synthetic/catalog'}):path==='/synthetic/catalog'?'[{}]':path==='/synthetic/owner.pub'?'public-owner-pin':Promise.reject(new Error('HUB_CREDENTIAL_MUST_NOT_BE_READ')));});
describe('paid funding owner CLI public queue composition',()=>{
 it('authenticates configured owner and active session, opens only public profile/catalog, and never runs a funding worker',async()=>{
  const runtime=await createPaidFundingOwnerRuntime({projectRoot:'/synthetic',ownerId:'123',sessionId:'session',environment:{MINT_BOT_FUNDING_PROFILE_PATH:'/synthetic/profile'}});
  expect(runtime.owner.ownerId).toBe('123');expect(runtime.service.status()).toEqual([]);await runtime.service.tick();
  expect(mocks.files.mock.calls.map(row=>row[0])).toEqual(['/synthetic/profile','/synthetic/owner.pub','/synthetic/catalog']);expect(mocks.rpc).not.toHaveBeenCalled();await runtime.close();expect(mocks.closed).toHaveBeenCalledOnce();
 });
 it('refuses a caller-supplied different owner before opening the queue or profile',async()=>{
  await expect(createPaidFundingOwnerRuntime({projectRoot:'/synthetic',ownerId:'999',sessionId:'session',environment:{MINT_BOT_FUNDING_PROFILE_PATH:'/synthetic/profile'}})).rejects.toThrow('OWNER_SESSION_REQUIRED');expect(mocks.files).not.toHaveBeenCalled();expect(mocks.db).not.toHaveBeenCalled();
 });
 it('requires an exact current unlock session and closes the store on rejection',async()=>{
  await expect(createPaidFundingOwnerRuntime({projectRoot:'/synthetic',ownerId:'123',sessionId:'stale-session',environment:{MINT_BOT_FUNDING_PROFILE_PATH:'/synthetic/profile'}})).rejects.toThrow('OWNER_SESSION_REQUIRED');expect(mocks.closed).toHaveBeenCalledOnce();expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it('stays disabled unless the protected funding profile is explicitly configured',async()=>{
  await expect(createPaidFundingOwnerRuntime({projectRoot:'/synthetic',ownerId:'123',sessionId:'session',environment:{}})).rejects.toThrow('NOT_CONFIGURED');expect(mocks.files).not.toHaveBeenCalled();expect(mocks.db).not.toHaveBeenCalled();
 });
});
