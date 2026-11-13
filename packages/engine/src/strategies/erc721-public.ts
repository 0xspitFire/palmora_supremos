import { encodeFunctionData, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { assertReviewedRegistryCurrent, verifyErc721WalletAuthority, type VerifiedReviewedErc721Registry } from '../verified-erc721-authority.js';
import type { DropConfig, DropValidation, MintStrategy, SupportedChainId } from '../types.js';
import { reviewedErc721Abi, reviewedErc721FactoryAbi, reviewedErc721DescriptorDigest, validateReviewedErc721Deployment, type ReviewedErc721Deployment } from '../protocol-registry.js';
function immutableCode(code:Hex):boolean {let bytes=Buffer.from(code.slice(2),'hex');if(bytes.length>4){const metadataLength=bytes.readUInt16BE(bytes.length-2);const start=bytes.length-2-metadataLength;if(start>0&&bytes[start-1]===0xfe&&bytes[start]!>=0xa0&&bytes[start]!<=0xbf&&bytes.subarray(start,bytes.length-2).includes(Buffer.from('solc')))bytes=bytes.subarray(0,start);}for(let i=0;i<bytes.length;i++){const opcode=bytes[i]!;if([0xf2,0xf4,0xff].includes(opcode))return false;if(opcode>=0x60&&opcode<=0x7f)i+=opcode-0x5f;}return true;}
/** Bounded per-deployment adapter, deliberately unavailable to existing SeaDrop custody policies. */
export class ReviewedErc721PublicStrategy implements MintStrategy {
 public readonly name='erc721-reviewed-public-v1';private readonly descriptor:ReviewedErc721Deployment;
 private readonly authorities=new WeakMap<DropConfig,{at:number;digest:string}>();
 public constructor(descriptor:ReviewedErc721Deployment,private readonly independentClient:(chainId:SupportedChainId)=>Promise<PublicClient>,private readonly now:()=>number=()=>Date.now(),private readonly registry?:VerifiedReviewedErc721Registry,private readonly authorityClients?:()=>Promise<readonly [PublicClient,PublicClient]>){this.descriptor=validateReviewedErc721Deployment(descriptor);}
 private async views(client:PublicClient,contract:Address,chainId:SupportedChainId,wallet?:Address){
  const descriptor=this.descriptor;if(chainId!==descriptor.chainId||(descriptor.binding==='deployment'&&contract.toLowerCase()!==descriptor.contract.toLowerCase()))throw new Error('ERC721_DEPLOYMENT_BINDING_INVALID');
  const second=await this.independentClient(chainId);if(second===client)throw new Error('ERC721_INDEPENDENT_PROVIDER_REQUIRED');
  const pair=[client,second];const heads=await Promise.all(pair.map(reader=>reader.getBlockNumber()));if(heads.some(value=>value<2n))throw new Error('ERC721_AUTHORITY_UNAVAILABLE');
  const blockNumber=(heads[0]!<heads[1]!?heads[0]!:heads[1]!)-2n;const abi=reviewedErc721Abi(descriptor);
  const views=await Promise.all(pair.map(async reader=>{
   const [actualChain,block,code,supports,...values]=await Promise.all([reader.getChainId(),reader.getBlock({blockNumber}),reader.getCode({address:contract,blockNumber}),reader.readContract({address:contract,abi,functionName:'supportsInterface',args:['0x80ac58cd'],blockNumber}),...['price','totalMinted','maxSupply','startsAt','endsAt','maxPerWallet'].map(key=>reader.readContract({address:contract,abi,functionName:descriptor.methods[key as keyof typeof descriptor.methods],blockNumber}))]);
   const age=this.now()-Number(block.timestamp)*1000;
   if(actualChain!==chainId||!block.hash||age< -30000||age>300000||!Number.isFinite(age)||!code||code==='0x'||keccak256(code)!==descriptor.bytecodeHash.toLowerCase()||supports!==true||values.some(value=>typeof value!=='bigint'||value<0n))throw new Error('ERC721_DEPLOYMENT_AUTHORITY_INVALID');
   const latestCode=await reader.getCode({address:contract});if(!latestCode||latestCode!==code||!immutableCode(code))throw new Error('ERC721_IMMUTABLE_CODE_REQUIRED');
   if(descriptor.binding==='factory-template') {
    const template=descriptor.template;
    const [factoryCode,deployed]=await Promise.all([reader.getCode({address:template.factory,blockNumber}),reader.readContract({address:template.factory,abi:reviewedErc721FactoryAbi(descriptor),functionName:template.deploymentRegistryMethod,args:[contract],blockNumber})]);
    const currentFactoryCode=await reader.getCode({address:template.factory});
    if(!factoryCode||factoryCode==='0x'||currentFactoryCode!==factoryCode||!immutableCode(factoryCode)||keccak256(factoryCode)!==template.factoryBytecodeHash.toLowerCase()||deployed!==true)throw new Error('ERC721_FACTORY_PROVENANCE_REQUIRED');
   }
   const walletMinted=wallet?await reader.readContract({address:contract,abi,functionName:descriptor.methods.walletMinted,args:[wallet],blockNumber}):0n;
   if(typeof walletMinted!=='bigint'||walletMinted<0n)throw new Error('ERC721_WALLET_COUNTER_UNKNOWN');
   return {hash:block.hash.toLowerCase(),timestamp:block.timestamp.toString(),values:values as bigint[],walletMinted};
  }));
  if(JSON.stringify(views[0],(_,value)=>typeof value==='bigint'?value.toString():value)!==JSON.stringify(views[1],(_,value)=>typeof value==='bigint'?value.toString():value))throw new Error('ERC721_PROVIDER_STATE_DISAGREEMENT');
  const view=views[0]!;const finalAge=this.now()-Number(view.timestamp)*1000;if(!Number.isFinite(finalAge)||finalAge< -30000||finalAge>300000)throw new Error('ERC721_AUTHORITY_UNAVAILABLE');const [price,totalMinted,maxSupply,startsAt,endsAt,maxPerWallet]=view.values as [bigint,bigint,bigint,bigint,bigint,bigint];
  if(price!==0n||maxSupply<=0n||totalMinted>maxSupply||maxPerWallet<=0n||maxPerWallet>10000n||startsAt>BigInt(Number.MAX_SAFE_INTEGER)||endsAt>BigInt(Number.MAX_SAFE_INTEGER)||startsAt>=endsAt)throw new Error('ERC721_FREE_STAGE_INVALID');
  return {pair,blockNumber,blockHash:view.hash,price,totalMinted,maxSupply,startsAt:Number(startsAt),endsAt:Number(endsAt),maxPerWallet:Number(maxPerWallet),walletMinted:view.walletMinted};
 }
 public async signingAuthority(client:PublicClient,drop:DropConfig,wallet:Address,quantity:number){
  if(!this.registry)throw new Error('ERC721_OWNER_REGISTRY_REQUIRED');assertReviewedRegistryCurrent(this.registry,new Date(this.now()));
  this.buildCalldata(drop,wallet,quantity);
  return verifyErc721WalletAuthority({registry:this.registry,descriptorDigest:reviewedErc721DescriptorDigest(this.descriptor),clients:this.authorityClients?await this.authorityClients():[client,await this.independentClient(drop.chainId)],contract:drop.nftContract,wallet,quantity,now:()=>new Date(this.now())});
 }
 public async readDrop(client:PublicClient,nftContract:Address,chainId:SupportedChainId):Promise<DropConfig>{
  const view=await this.views(client,nftContract,chainId);const digest=reviewedErc721DescriptorDigest(this.descriptor);
  const drop:DropConfig={nftContract,mintPrice:0n,maxTotalMintableByWallet:Math.min(view.maxPerWallet,this.descriptor.maxQuantity),maxTokenSupply:view.maxSupply,totalMinted:view.totalMinted,startTime:view.startsAt,endTime:view.endsAt,feePayer:zeroAddress,strategyName:this.name,chainId,extra:{descriptorDigest:digest,authorityBlock:view.blockNumber.toString(),authorityHash:view.blockHash,totalSupplyKnown:true,maxSupplyKnown:true}};
  Object.freeze(drop.extra);Object.freeze(drop);this.authorities.set(drop,{at:this.now(),digest});return drop;
 }
 public buildCalldata(drop:DropConfig,_minter:Address,quantity:number):Hex{
  const authority=this.authorities.get(drop);if(!authority||this.now()-authority.at<0||this.now()-authority.at>30000||authority.digest!==reviewedErc721DescriptorDigest(this.descriptor)||drop.chainId!==this.descriptor.chainId||(this.descriptor.binding==='deployment'&&drop.nftContract.toLowerCase()!==this.descriptor.contract.toLowerCase())||drop.mintPrice!==0n||!Number.isSafeInteger(quantity)||quantity<1||quantity>this.descriptor.maxQuantity||quantity>drop.maxTotalMintableByWallet||BigInt(quantity)>drop.maxTokenSupply-drop.totalMinted)throw new Error('ERC721_FRESH_AUTHORITY_REQUIRED');
  return encodeFunctionData({abi:reviewedErc721Abi(this.descriptor),functionName:'mint',args:[BigInt(quantity)]});
 }
 public async estimateGas(client:PublicClient,drop:DropConfig,minter:Address,quantity:number):Promise<bigint>{
  const data=this.buildCalldata(drop,minter,quantity);const view=await this.views(client,drop.nftContract,drop.chainId,minter);
  if(view.price!==drop.mintPrice||view.startsAt!==drop.startTime||view.endsAt!==drop.endTime||view.maxSupply!==drop.maxTokenSupply||view.totalMinted<drop.totalMinted||Math.min(view.maxPerWallet,this.descriptor.maxQuantity)!==drop.maxTotalMintableByWallet)throw new Error('ERC721_STAGE_CHANGED');
  if(view.totalMinted+BigInt(quantity)>view.maxSupply)throw new Error('ERC721_SUPPLY_EXCEEDED');
  const now=Math.floor(this.now()/1000);if(now<view.startsAt||now>=view.endsAt||view.walletMinted+BigInt(quantity)>BigInt(view.maxPerWallet))throw new Error('ERC721_WALLET_NOT_ELIGIBLE');
  const estimates=await Promise.all(view.pair.map(async reader=>{await reader.call({account:minter,to:drop.nftContract,data,value:0n,blockNumber:view.blockNumber});return reader.estimateGas({account:minter,to:drop.nftContract,data,value:0n});}));
  if(estimates.some(value=>value<=0n||value>500000n))throw new Error('ERC721_GAS_BOUND_EXCEEDED');return estimates[0]!>estimates[1]!?estimates[0]!:estimates[1]!;
 }
 public validateDrop(drop:DropConfig,nowUnix=Math.floor(this.now()/1000)):DropValidation{const errors:string[]=[];try{this.buildCalldata(drop,zeroAddress,1);}catch{errors.push('ERC721_FRESH_AUTHORITY_REQUIRED');}if(drop.mintPrice!==0n||drop.totalMinted>=drop.maxTokenSupply||nowUnix>=drop.endTime)errors.push('ERC721_FREE_STAGE_INVALID');return {valid:errors.length===0,errors,warnings:nowUnix<drop.startTime?['Stage has not opened yet.']:[]};}
}
