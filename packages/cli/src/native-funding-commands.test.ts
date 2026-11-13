import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import yargs from 'yargs/yargs';
import { registerNativeFundingCommands } from './native-funding-commands.js';
function record(){const now=new Date();return {version:1,kind:'native-fleet-topup-v1',organizationId:'funding-org',mintOrganizationId:'mint-org',userId:'fund-only',keyId:'hub-only',policyId:'owner-created-policy',chainId:1,hub:`0x${'a'.repeat(40)}`,recipients:[`0x${'b'.repeat(40)}`],issuedAt:now.toISOString(),expiresAt:new Date(+now+86400000).toISOString(),maxTransferWei:'4100000000000000',rollingPrincipalCapWei:'8500000000000000',rollingFeeCapWei:'200000000000000',maxTransferFeeWei:'20000000000000',hubMaxBalanceWei:'8700000000000000',recipientMaxBalanceWei:'4100000000000000',fleetMaxBalanceWei:'8500000000000000',gasLimitMax:'21000',maxFeePerGas:'200000000',maxPriorityFeePerGas:'100000000'};}
describe('offline funding policy workflow',()=>{
 it('previews, explicitly signs and verifies an immutable separate funding record without a provider',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'funding-offline-test-'));const input=join(directory,'public-record.json'),pub=join(directory,'approval.pub'),key=join(directory,'synthetic-approval.pem'),output=join(directory,'signed-public.json');
 const pair=generateKeyPairSync('ed25519');let printed='';const stdout=vi.spyOn(process.stdout,'write').mockImplementation((text:unknown)=>{printed+=String(text);return true;});
 try{
 await writeFile(input,JSON.stringify(record()),{mode:0o600});await writeFile(pub,pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});await writeFile(key,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const run=async(action:string,extra:string[]=[])=>{printed='';await registerNativeFundingCommands(yargs(['funding-policy',action,'--input',input,'--approver-public-key',pub,...extra]).strict().exitProcess(false)).parseAsync();return JSON.parse(printed);};
 const preview=await run('preview');expect(preview).toMatchObject({preview:true,activation:false,record:{chainId:1,recipients:[`0x${'b'.repeat(40)}`]}});expect(preview.providerPolicy).not.toHaveProperty('time');
 const blocked=await run('sign',['--approval-key',key,'--output',output,'--write','--confirm','wrong']);expect(blocked.preview).toBe(true);await expect(stat(output)).rejects.toMatchObject({code:'ENOENT'});
 expect(await run('sign',['--approval-key',key,'--output',output,'--write','--confirm',preview.confirmation])).toMatchObject({ok:true,activation:false});expect((await stat(output)).mode&0o777).toBe(0o600);
 printed='';await registerNativeFundingCommands(yargs(['funding-policy','verify','--input',output,'--approver-public-key',pub]).strict().exitProcess(false)).parseAsync();expect(JSON.parse(printed)).toMatchObject({ok:true,chainId:1,walletCount:1});
 const bytes=await readFile(output,'utf8');expect(await run('sign',['--approval-key',key,'--output',output,'--write','--confirm',preview.confirmation])).toMatchObject({state:'blocked'});expect(await readFile(output,'utf8')).toBe(bytes);
 }finally{stdout.mockRestore();await rm(directory,{recursive:true,force:true});}
 });
});
