import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { TurnkeySigner } from './turnkey-signer.js';

describe('TurnkeySigner', () => {
  it('validates the Turnkey-signed transaction boundary', async () => {
    const privateKey = `0x${randomBytes(32).toString('hex')}` as Hex;
    const account = privateKeyToAccount(privateKey);
    const seaDrop = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' as Address;
    const nft = '0x0000000000000000000000000000000000000002' as Address;
    const feeRecipient = '0x0000000000000000000000000000000000000003' as Address;
    const minterIfNotPayer = '0x0000000000000000000000000000000000000000' as Address;
    const data = encodeFunctionData({
      abi: parseAbi(['function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable']),
      functionName: 'mintPublic',
      args: [nft, feeRecipient, minterIfNotPayer, 1n],
    });
    const intent = {
      chainId: 1 as const,
      from: account.address,
      to: seaDrop,
      value: 0n,
      data,
      nonce: 4,
      gasLimit: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      policyRef: 'policy-test',
    };
    const signedTransaction = await account.signTransaction({ type: 'eip1559', ...intent, gas: intent.gasLimit });
    const policyCondition = `eth.tx.chain_id == 1 && eth.tx.to == '${seaDrop.toLowerCase()}' && eth.tx.from in ['${account.address.toLowerCase()}'] && eth.tx.value == 0 && eth.tx.gas <= 21000 && eth.tx.max_fee_per_gas <= 1000000000 && eth.tx.max_priority_fee_per_gas <= 100000000 && eth.tx.function_signature == '0x161ac21f' && eth.tx.contract_call_args['nftContract'] == '${nft.toLowerCase()}' && eth.tx.contract_call_args['feeRecipient'] == '${feeRecipient.toLowerCase()}' && eth.tx.contract_call_args['minterIfNotPayer'] == '${minterIfNotPayer.toLowerCase()}' && eth.tx.contract_call_args['quantity'] == 1`;
    let observedSignWith = '';
    let observedType = '';
    const signer = new TurnkeySigner({
      organizationId: 'org-test',
      wallets: [{ index: 0, address: account.address, signWith: 'turnkey-account-test' }],
      policyId: 'policy-test',
      policyDigest: keccak256(toBytes(policyCondition)),
      policy: {
        chainId: 1,
        to: seaDrop,
        functionSelector: '0x161ac21f',
        nftContract: nft,
        feeRecipient,
        minterIfNotPayer,
        quantity: '1',
        maxValueWei: '0',
        maxGasLimit: '21000',
        maxFeePerGas: '1000000000',
        maxPriorityFeePerGas: '100000000',
      },
      client: {
        signTransaction: async (input) => {
          observedSignWith = input.signWith;
          observedType = input.type;
          return { signedTransaction: signedTransaction.slice(2) };
        },
        getWhoami: async () => ({ organizationId: 'org-test' }),
        getPolicies: async () => ({ policies: [{ policyId: 'policy-test', effect: 'EFFECT_ALLOW', condition: policyCondition }] }),
        getPrivateKeys: async () => ({ privateKeys: [{ privateKeyId: 'turnkey-account-test', addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address: account.address }] }] }),
      },
    });

    await expect(signer.signTransaction(0, intent)).resolves.toBe(signedTransaction);
    expect(observedSignWith).toBe('turnkey-account-test');
    expect(observedType).toBe('TRANSACTION_TYPE_ETHEREUM');
    await expect(signer.probe()).resolves.toMatchObject({ provider: 'turnkey', walletCount: 1 });
    signer.zeroize();
    await expect(signer.listWallets()).rejects.toThrow('TURNKEY_SIGNER_ZEROIZED');
  });

  it('rejects an intent from a different wallet', async () => {
    const privateKey = `0x${randomBytes(32).toString('hex')}` as Hex;
    const account = privateKeyToAccount(privateKey);
    const signer = new TurnkeySigner({
      organizationId: 'org-test',
      wallets: [{ index: 0, address: account.address, signWith: account.address }],
      policyId: 'policy-test',
      policyDigest: `0x${'0'.repeat(64)}`,
      policy: {
        chainId: 1,
        to: '0x0000000000000000000000000000000000000002',
        functionSelector: '0x161ac21f',
        nftContract: '0x0000000000000000000000000000000000000002',
        feeRecipient: '0x0000000000000000000000000000000000000003',
        minterIfNotPayer: '0x0000000000000000000000000000000000000000',
        quantity: '1',
        maxValueWei: '0',
        maxGasLimit: '21000',
        maxFeePerGas: '1',
        maxPriorityFeePerGas: '1',
      },
      client: {
        signTransaction: async () => ({ signedTransaction: '0x02' }),
        getWhoami: async () => ({ organizationId: 'org-test' }),
      },
    });
    const intent = {
      chainId: 1 as const,
      from: '0x0000000000000000000000000000000000000001' as Address,
      to: '0x0000000000000000000000000000000000000002' as Address,
      value: 0n,
      data: '0x' as Hex,
      nonce: 0,
      gasLimit: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    };
    await expect(signer.signTransaction(0, intent)).rejects.toThrow('TURNKEY_SIGNER_WALLET_MISMATCH');
    signer.zeroize();
  });

  it('does not treat an arbitrary successful response as provider-bound health', async () => {
    const signer = new TurnkeySigner({
      organizationId: 'org-test',
      wallets: [{ index: 0, address: '0x0000000000000000000000000000000000000001', signWith: 'turnkey-account-test' }],
      policyId: 'policy-test',
      policyDigest: `0x${'0'.repeat(64)}`,
      policy: {
        chainId: 1,
        to: '0x0000000000000000000000000000000000000002',
        functionSelector: '0x161ac21f',
        nftContract: '0x0000000000000000000000000000000000000002',
        feeRecipient: '0x0000000000000000000000000000000000000003',
        minterIfNotPayer: '0x0000000000000000000000000000000000000000',
        quantity: '1',
        maxValueWei: '0',
        maxGasLimit: '21000',
        maxFeePerGas: '1',
        maxPriorityFeePerGas: '1',
      },
      client: {
        signTransaction: async () => ({ signedTransaction: '0x02' }),
        getWhoami: async () => ({ organizationId: 'org-test' }),
        getPolicies: async () => ({ policies: [] }),
      },
    });
    await expect(signer.probe()).rejects.toThrow('TURNKEY_POLICY_NOT_FOUND');
    signer.zeroize();
  });
});
