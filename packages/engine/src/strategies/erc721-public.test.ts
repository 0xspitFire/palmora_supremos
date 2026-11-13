import {describe,expect,it} from 'vitest';
import {decodeFunctionData,keccak256,type Address,type PublicClient} from 'viem';
import {ReviewedProtocolRegistry,reviewedErc721Abi,reviewedErc721AbiHash,type ReviewedErc721Deployment} from '../protocol-registry.js';
import {ReviewedErc721PublicStrategy} from './erc721-public.js';
const now=Date.parse('2026-11-13T12:00:00Z');const contract=`0x${'1'.repeat(40)}` as Address;const wallet=`0x${'2'.repeat(40)}` as Address;const hash=`0x${'a'.repeat(64)}`;
function descriptor():ReviewedErc721Deployment{const value:ReviewedErc721Deployment={version:'reviewed-erc721-public-v1',chainId:1,binding:'deployment',contract,deploymentKind:'immutable-direct',bytecodeHash:keccak256('0x1234'),abiHash:'',mintMethod:'mint(uint256)',maxQuantity:10,methods:{price:'cost',totalMinted:'minted',maxSupply:'maximum',startsAt:'opens',endsAt:'closes',maxPerWallet:'limit',walletMinted:'numberMinted'},securityReviewReference:'security-review-1',protocolEvidenceReference:'protocol-local-1',ownerApprovalReference:'owner-descriptor-1'};value.abiHash=reviewedErc721AbiHash(value);return value;}
function client(overrides:Record<string,unknown>={}):PublicClient{const values:Record<string,unknown>={supportsInterface:true,cost:0n,minted:1n,maximum:100n,opens:BigInt(now/1000-60),closes:BigInt(now/1000+3600),limit:10n,numberMinted:0n};return {getChainId:async()=>1,getBlockNumber:async()=>100n,getCode:async()=> '0x1234',getBlock:async()=>({hash,timestamp:BigInt(now/1000-20)}),readContract:async(input:{functionName:string})=>values[input.functionName],call:async()=>({data:'0x'}),estimateGas:async()=>100000n,...overrides} as unknown as PublicClient;}
describe('explicit reviewed ERC721 public deployment',()=>{
 it('defaults to no protocols and builds only the reviewed free mint call after independent reads and simulation',async()=>{
 const config=descriptor();expect(new ReviewedProtocolRegistry().lookup(1,contract)).toBeUndefined();const registry=new ReviewedProtocolRegistry([config]);expect(registry.lookup(8453,contract)).toBeUndefined();
 const primary=client();const strategy=new ReviewedErc721PublicStrategy(config,async()=>client(),()=>now);const drop=await strategy.readDrop(primary,contract,1);
 expect(decodeFunctionData({abi:reviewedErc721Abi(config),data:strategy.buildCalldata(drop,wallet,4)})).toMatchObject({functionName:'mint',args:[4n]});expect(await strategy.estimateGas(primary,drop,wallet,4)).toBe(100000n);expect(strategy.validateDrop(drop).valid).toBe(true);
 expect(()=>strategy.buildCalldata({...drop},wallet,4)).toThrow('ERC721_FRESH_AUTHORITY_REQUIRED');expect(()=>strategy.buildCalldata(drop,wallet,11)).toThrow('ERC721_FRESH_AUTHORITY_REQUIRED');expect(Object.isFrozen(drop)).toBe(true);
 });
 it.each(['code','chain','state','unknown-counter','paid','gas','simulation'] as const)('fails closed for %s disagreement or unavailable evidence',async kind=>{
 const primary=client();let second=client();
 if(kind==='code')second=client({getCode:async()=> '0x5678'});if(kind==='chain')second=client({getChainId:async()=>8453});
 if(kind==='state'||kind==='unknown-counter'||kind==='paid'){const base=client();second=client({readContract:async(input:{functionName:string})=>input.functionName===(kind==='state'?'minted':kind==='paid'?'cost':'numberMinted')?(kind==='unknown-counter'?undefined:2n):base.readContract(input as never)});}
 if(kind==='gas')second=client({estimateGas:async()=>500001n});if(kind==='simulation')second=client({call:async()=>{throw new Error('simulation reverted');}});
 const strategy=new ReviewedErc721PublicStrategy(descriptor(),async()=>second,()=>now);
 if(['code','chain','state','paid'].includes(kind))await expect(strategy.readDrop(primary,contract,1)).rejects.toThrow();else{const drop=await strategy.readDrop(primary,contract,1);await expect(strategy.estimateGas(primary,drop,wallet,1)).rejects.toThrow();}
 });
 it('rejects unknown ABI, missing owner evidence, cross-chain binding and stale drop authority',async()=>{
 expect(()=>new ReviewedProtocolRegistry([{...descriptor(),abiHash:'wrong'}])).toThrow();expect(()=>new ReviewedProtocolRegistry([{...descriptor(),ownerApprovalReference:''}])).toThrow();
 let clock=now;const primary=client();const strategy=new ReviewedErc721PublicStrategy(descriptor(),async()=>client(),()=>clock);await expect(strategy.readDrop(primary,contract,8453)).rejects.toThrow('ERC721_DEPLOYMENT_BINDING_INVALID');const drop=await strategy.readDrop(primary,contract,1);clock+=31000;expect(()=>strategy.buildCalldata(drop,wallet,1)).toThrow('ERC721_FRESH_AUTHORITY_REQUIRED');
 });
});

 it('reuses an approved immutable factory template only after both RPCs prove deployment provenance',async()=>{
 const {contract:_contract,binding:_binding,...base}=descriptor();
 const config:ReviewedErc721Deployment={...base,binding:'factory-template',template:{id:'reviewed-template-v1',factory:`0x${'3'.repeat(40)}`,factoryBytecodeHash:keccak256('0x1234'),deploymentRegistryMethod:'isDeployment'}};
 const registry=new ReviewedProtocolRegistry([config]);expect(registry.templateCandidates(1)).toHaveLength(1);expect(registry.templateCandidates(8453)).toEqual([]);
 const make=(accepted:boolean)=>{const original=client();return client({readContract:async(input:{functionName:string})=>input.functionName==='isDeployment'?accepted:original.readContract(input as never)});};
 const strategy=new ReviewedErc721PublicStrategy(config,async()=>make(true),()=>now);const primary=make(true);const drop=await strategy.readDrop(primary,contract,1);expect(await strategy.estimateGas(primary,drop,wallet,2)).toBe(100000n);
 await expect(new ReviewedErc721PublicStrategy(config,async()=>make(false),()=>now).readDrop(primary,contract,1)).rejects.toThrow('ERC721_FACTORY_PROVENANCE_REQUIRED');
 const wrongFactory={...config,template:{...config.template,factoryBytecodeHash:keccak256('0x5678')}};
 await expect(new ReviewedErc721PublicStrategy(wrongFactory,async()=>make(true),()=>now).readDrop(primary,contract,1)).rejects.toThrow('ERC721_FACTORY_PROVENANCE_REQUIRED');
 });


it('allows monotonic supply progress while retaining enough supply and refuses sold-out/reorg/cap drift',async()=>{
 let minted=1n,maximum=100n;const make=()=>{const base=client();return client({readContract:async(input:{functionName:string})=>input.functionName==='minted'?minted:input.functionName==='maximum'?maximum:base.readContract(input as never)});};const primary=make(),second=make(),strategy=new ReviewedErc721PublicStrategy(descriptor(),async()=>second,()=>now);const drop=await strategy.readDrop(primary,contract,1);minted=20n;expect(await strategy.estimateGas(primary,drop,wallet,3)).toBe(100000n);minted=99n;await expect(strategy.estimateGas(primary,drop,wallet,3)).rejects.toThrow('ERC721_SUPPLY_EXCEEDED');minted=0n;await expect(strategy.estimateGas(primary,drop,wallet,3)).rejects.toThrow('ERC721_STAGE_CHANGED');minted=20n;maximum=101n;await expect(strategy.estimateGas(primary,drop,wallet,3)).rejects.toThrow('ERC721_STAGE_CHANGED');
});
