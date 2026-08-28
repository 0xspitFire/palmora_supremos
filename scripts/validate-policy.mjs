const executionChain = process.env.EXECUTION_CHAIN ?? 'ethereum';
const flashbotsChain = process.env.FLASHBOTS_CHAIN ?? 'ethereum';
const liveSpendWei = BigInt(process.env.LIVE_SPEND_CAP_WEI ?? '0');
const robinhoodVerified = process.env.ROBINHOOD_VERIFIED === 'true';
const robinhoodLive = process.env.ROBINHOOD_LIVE === 'true';
const robinhoodMintPriceWei = BigInt(process.env.ROBINHOOD_MINT_PRICE_WEI ?? '0');
const robinhoodPriorityFeeWei = BigInt(process.env.ROBINHOOD_PRIORITY_FEE_WEI ?? '0');
const robinhoodL2FeeWei = BigInt(process.env.ROBINHOOD_L2_EXECUTION_FEE_WEI ?? '0');
const robinhoodL1FeeWei = BigInt(process.env.ROBINHOOD_L1_DATA_FEE_WEI ?? '0');

const errors = [];
if (executionChain !== 'ethereum') errors.push('Phase 1 execution chain must be ethereum');
if (flashbotsChain !== 'ethereum') errors.push('Flashbots is permitted only for ethereum');
if (robinhoodVerified) errors.push('Robinhood must remain unverified in Phase 1');
if (liveSpendWei !== 0n) errors.push('Live spend cap must remain zero until Product Owner numeric caps are approved');
if (robinhoodLive) errors.push('Robinhood live execution requires accepted characterization and reconciliation gates');
if (robinhoodMintPriceWei > 0n) errors.push('Paid Robinhood mints are blocked pending Product Owner policy');
if (robinhoodPriorityFeeWei > 0n && robinhoodL2FeeWei + robinhoodL1FeeWei > robinhoodPriorityFeeWei * 2n) {
  errors.push('Robinhood free-mint total cost exceeds 2x configured priority-fee component');
}
if (robinhoodPriorityFeeWei === 0n && (robinhoodL2FeeWei > 0n || robinhoodL1FeeWei > 0n)) {
  errors.push('Robinhood cost policy requires a configured priority-fee component');
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Phase 1 execution policy passed: Ethereum-only, Robinhood blocked, zero-spend default.');
}
