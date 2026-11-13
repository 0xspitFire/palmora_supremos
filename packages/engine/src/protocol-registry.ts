import { createHash } from 'node:crypto';
import { parseAbi, type Abi, type Address, type Hex } from 'viem';
import type { SupportedChainId } from './types.js';
/** ERC-721 itself defines ownership/transfer, not minting. No ABI inference is authority.
 * https://eips.ethereum.org/EIPS/eip-721 */
interface ReviewedErc721Base {
 version:'reviewed-erc721-public-v1'; chainId:SupportedChainId; deploymentKind:'immutable-direct';
 bytecodeHash:Hex; abiHash:string; mintMethod:'mint(uint256)'; maxQuantity:number;
 methods:{price:string;totalMinted:string;maxSupply:string;startsAt:string;endsAt:string;maxPerWallet:string;walletMinted:string};
 securityReviewReference:string; protocolEvidenceReference:string; ownerApprovalReference:string;
}
export type ReviewedErc721Deployment = ReviewedErc721Base & ({binding:'deployment';contract:Address;template?:never}|{binding:'factory-template';contract?:never;template:{id:string;factory:Address;factoryBytecodeHash:Hex;deploymentRegistryMethod:string}});
const name=/^[A-Za-z_][A-Za-z0-9_]{0,63}$/;const reference=/^[A-Za-z0-9_.:-]{1,160}$/;
export function reviewedErc721Abi(descriptor:ReviewedErc721Deployment):Abi {
 const values=Object.values(descriptor.methods);if(values.length!==7||!values.every(value=>typeof value==='string'&&name.test(value))||new Set(values).size!==7)throw new Error('ERC721_DESCRIPTOR_METHODS_INVALID');
 return parseAbi(['function supportsInterface(bytes4 interfaceId) view returns (bool)','function mint(uint256 quantity) payable', ...['price','totalMinted','maxSupply','startsAt','endsAt','maxPerWallet'].map(key=>`function ${descriptor.methods[key as keyof ReviewedErc721Deployment['methods']]}() view returns (uint256)`),`function ${descriptor.methods.walletMinted}(address wallet) view returns (uint256)`]);
}
export function reviewedErc721AbiHash(descriptor:ReviewedErc721Deployment):string{return `sha256:${createHash('sha256').update(JSON.stringify(reviewedErc721Abi(descriptor))).digest('hex')}`;}
export function reviewedErc721FactoryAbi(descriptor:ReviewedErc721Deployment):Abi {
 if(descriptor.binding!=='factory-template'||!name.test(descriptor.template.deploymentRegistryMethod))throw new Error('ERC721_FACTORY_PROVENANCE_REQUIRED');
 return parseAbi([`function ${descriptor.template.deploymentRegistryMethod}(address deployment) view returns (bool)`]);
}
export function validateReviewedErc721Deployment(descriptor:ReviewedErc721Deployment):ReviewedErc721Deployment{
 if(!descriptor||descriptor.version!=='reviewed-erc721-public-v1'||![1,8453,4663].includes(descriptor.chainId)||!(descriptor.binding==='deployment'?/^0x[a-f0-9]{40}$/i.test(descriptor.contract):descriptor.binding==='factory-template'&&!!descriptor.template&&reference.test(descriptor.template.id)&&/^0x[a-f0-9]{40}$/i.test(descriptor.template.factory)&&/^0x[a-f0-9]{64}$/i.test(descriptor.template.factoryBytecodeHash)&&name.test(descriptor.template.deploymentRegistryMethod))||descriptor.deploymentKind!=='immutable-direct'||descriptor.mintMethod!=='mint(uint256)'||!/^0x[a-f0-9]{64}$/i.test(descriptor.bytecodeHash)||!Number.isSafeInteger(descriptor.maxQuantity)||descriptor.maxQuantity<1||descriptor.maxQuantity>(descriptor.chainId===8453?4:10)||![descriptor.securityReviewReference,descriptor.protocolEvidenceReference,descriptor.ownerApprovalReference].every(value=>typeof value==='string'&&reference.test(value))||descriptor.abiHash!==reviewedErc721AbiHash(descriptor))throw new Error('ERC721_REVIEWED_DEPLOYMENT_REQUIRED');
 const {version,chainId,binding,deploymentKind,bytecodeHash,abiHash,mintMethod,maxQuantity,securityReviewReference,protocolEvidenceReference,ownerApprovalReference}=descriptor;
 const methods={price:descriptor.methods.price,totalMinted:descriptor.methods.totalMinted,maxSupply:descriptor.methods.maxSupply,startsAt:descriptor.methods.startsAt,endsAt:descriptor.methods.endsAt,maxPerWallet:descriptor.methods.maxPerWallet,walletMinted:descriptor.methods.walletMinted};
 const base={version,chainId,deploymentKind,bytecodeHash:bytecodeHash.toLowerCase() as Hex,abiHash,mintMethod,maxQuantity,methods,securityReviewReference,protocolEvidenceReference,ownerApprovalReference};
 return binding==='deployment'?{...base,binding,contract:descriptor.contract.toLowerCase() as Address}:{...base,binding,template:{id:descriptor.template.id,factory:descriptor.template.factory.toLowerCase() as Address,factoryBytecodeHash:descriptor.template.factoryBytecodeHash.toLowerCase() as Hex,deploymentRegistryMethod:descriptor.template.deploymentRegistryMethod}};
}
export function reviewedErc721DescriptorDigest(descriptor:ReviewedErc721Deployment):string {return `sha256:${createHash('sha256').update(JSON.stringify(validateReviewedErc721Deployment(descriptor))).digest('hex')}`;}
/** Default empty; each deployment requires an independently reviewed descriptor and NEW custody/baseline coverage. */
export class ReviewedProtocolRegistry{
 private readonly entries=new Map<string,ReviewedErc721Deployment>();
 public constructor(descriptors:readonly ReviewedErc721Deployment[]=[]){for(const value of descriptors){const descriptor=validateReviewedErc721Deployment(value);const key=descriptor.binding==='deployment'?`${descriptor.chainId}:${descriptor.contract.toLowerCase()}`:`${descriptor.chainId}:template:${descriptor.template.id}`;if(this.entries.has(key))throw new Error('ERC721_DUPLICATE_DEPLOYMENT');this.entries.set(key,descriptor);}}
 public lookup(chainId:number,contract:string):ReviewedErc721Deployment|undefined{const entry=this.entries.get(`${chainId}:${contract.toLowerCase()}`);return entry?structuredClone(entry):undefined;}
 public templateCandidates(chainId:number):ReviewedErc721Deployment[]{return [...this.entries.values()].filter(entry=>entry.chainId===chainId&&entry.binding==='factory-template').map(entry=>structuredClone(entry));}
}
