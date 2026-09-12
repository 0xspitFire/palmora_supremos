const executionChain = process.env.EXECUTION_CHAIN ?? 'ethereum';
const flashbotsChain = process.env.FLASHBOTS_CHAIN ?? 'ethereum';
const liveSpendWei = BigInt(process.env.LIVE_SPEND_CAP_WEI ?? '0');
const robinhoodVerified = process.env.ROBINHOOD_VERIFIED === 'true';
const robinhoodLive = process.env.ROBINHOOD_LIVE === 'true';
const robinhoodMintPriceWei = BigInt(process.env.ROBINHOOD_MINT_PRICE_WEI ?? '0');
const robinhoodPriorityFeeWei = BigInt(process.env.ROBINHOOD_PRIORITY_FEE_WEI ?? '0');
const robinhoodL2FeeWei = BigInt(process.env.ROBINHOOD_L2_EXECUTION_FEE_WEI ?? '0');
const robinhoodL1FeeWei = BigInt(process.env.ROBINHOOD_L1_DATA_FEE_WEI ?? '0');
const robinhoodFreeValueWei = BigInt(process.env.ROBINHOOD_FREE_MINT_VALUE_WEI ?? '0');
const robinhoodL2ReserveWei = BigInt(process.env.ROBINHOOD_L2_GAS_RESERVE_WEI ?? '0');
const robinhoodL1ReserveWei = BigInt(process.env.ROBINHOOD_L1_DATA_GAS_RESERVE_WEI ?? '0');
const robinhoodWalletCapWei = BigInt(process.env.ROBINHOOD_FREE_WALLET_CAP_WEI ?? '200000000000000');
const robinhoodPeriodCapWei = BigInt(process.env.ROBINHOOD_FREE_PERIOD_CAP_WEI ?? '2000000000000000');
const freeMint = process.env.ROBINHOOD_MINT_TYPE === 'FREE';

const errors = [];
if (executionChain !== 'ethereum') errors.push('Phase 1 execution chain must be ethereum');
if (flashbotsChain !== 'ethereum') errors.push('Flashbots is permitted only for ethereum');
if (robinhoodVerified) errors.push('Robinhood must remain unverified in Phase 1');
if (liveSpendWei !== 0n) errors.push('Live spend cap must remain zero until Product Owner numeric caps are approved');
if (robinhoodLive) errors.push('Robinhood live execution requires accepted characterization and reconciliation gates');
if (robinhoodMintPriceWei > 0n) errors.push('Paid Robinhood mints are blocked pending Product Owner policy');
if (freeMint && robinhoodFreeValueWei > robinhoodPriorityFeeWei * 2n) {
  errors.push('FREE mint value exposure exceeds 2x configured priority-fee component');
}
if (freeMint && robinhoodL2FeeWei > robinhoodL2ReserveWei) {
  errors.push('FREE mint L2 execution gas exceeds its independent worst-case reserve');
}
if (freeMint && robinhoodL1FeeWei > robinhoodL1ReserveWei) {
  errors.push('FREE mint L1 data gas exceeds its independent worst-case reserve');
}
const freeReservedExposureWei = robinhoodFreeValueWei + robinhoodL2ReserveWei + robinhoodL1ReserveWei;
if (freeMint && freeReservedExposureWei > robinhoodWalletCapWei) {
  errors.push('FREE mint reserved exposure exceeds the per-wallet cap');
}
if (freeMint && freeReservedExposureWei > robinhoodPeriodCapWei) {
  errors.push('FREE mint reserved exposure exceeds the active mint-period cap');
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Phase 1 execution policy passed: Ethereum-only, Robinhood blocked, zero-spend default.');
}
