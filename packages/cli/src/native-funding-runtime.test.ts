import { describe, expect, it } from 'vitest';
import { turnkeyFundingWalletSetDigest } from '@mint-bot/engine';
import { assertCurrentFundingFleet } from './native-funding-runtime.js';
const first=`0x${'a'.repeat(40)}`,second=`0x${'b'.repeat(40)}`,other=`0x${'c'.repeat(40)}`;
const recipients=[first,second];
const record={mintOrganizationId:'mint-org',chainId:1 as const,recipients,walletSetDigest:turnkeyFundingWalletSetDigest(1,recipients)};
describe('funding custody fleet drift boundary',()=>{
 it('compares the whole currently installed fleet with canonical case and ordering',()=>{
 expect(()=>assertCurrentFundingFleet(record,{organizationId:'mint-org',wallets:[second.toUpperCase(),first]})).not.toThrow();
 });
 it('refuses retired, added, missing and duplicate keys even for a healthy funded subset',()=>{
 for(const wallets of [[first],[first,other],[first,second,other],[first,first]])expect(()=>assertCurrentFundingFleet(record,{organizationId:'mint-org',wallets})).toThrow('CURRENT_FLEET_CHANGED');
 });
 it('refuses mint organization and chain binding drift',()=>{
 expect(()=>assertCurrentFundingFleet(record,{organizationId:'another-org',wallets:recipients})).toThrow('CURRENT_FLEET_CHANGED');
 expect(()=>assertCurrentFundingFleet({...record,chainId:8453},{organizationId:'mint-org',wallets:recipients})).toThrow('CURRENT_FLEET_CHANGED');
 });
});
