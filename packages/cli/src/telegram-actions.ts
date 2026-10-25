import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createPublicClient, formatGwei, parseEther, http as httpTransport, parseAbi, type Address } from 'viem';
import { DEFAULT_IDLE_BALANCE_CEILINGS, Phase2ReadModelService, formatEth, validBaseEnablement, validRobinhoodEnablement, type BackendApplication, type BackendStore, type CanonicalStoreBridge, type ExecutionCoordinator } from '@mint-bot/backend';
import { failoverTransport, resolveChainConfigFromSecrets } from '@mint-bot/engine';
import type { FireScheduleRepository, GasAlertRepository, IntelligenceRepository } from '@mint-bot/database';
import { cleanName, describeActivity, describeHistory, describeLimits } from './owner-reports.js';
import { gasAlertSentence } from './gas-alert-service.js';
import type { TelegramActions, TelegramRole } from './telegram-commands.js';
import type { LivePlanResult } from './owner-actions.js';
import { EngineIntelligencePort } from './intelligence-adapter.js';
import { checkDrop } from './drop-check.js';
import { dryRunDrop, type DryRunReport } from './robinhood-readonly.js';
import { asKillStore, killReleaseAction, livePlanAction, livePrepareAction, recordPassingSimulationsAction, recordSimulationAction, watchAcceptAction, type PrepareStore } from './owner-actions.js';
import { previewLiveRequest, runLiveRequest, sizedWalletCount } from './live-request.js';
import { ROBINHOOD_DEFAULT_TIP_GWEI, buildRobinhoodPlan, type RobinhoodPlan, recordRobinhoodSimulationsAction, robinhoodConfirmationPhrase, robinhoodPrepareAction } from './robinhood-live.js';
import { describeLiveRunResult } from './live-run.js';
import { planCampaignFunding, renderFundingPlan } from './fleet-funding-cli.js';
import { runRobinhoodEnable, type EnableStore } from './robinhood-enable.js';
import { runBaseEnable, type BaseEnableStore } from './base-enable.js';
import { engageKillSwitchFile } from './compensating-controls-cli.js';
import { backupFacts, codeVersion } from './host-facts.js';
import { PORTFOLIO_CHAINS, type PortfolioProvider } from './portfolio-provider.js';
import { sections, shortEth, shortenBalancesInParens } from './display.js';
import { usdText, type EthPriceProvider } from './price-provider.js';
import type { OpenSeaFloors } from './opensea-client.js';
import { scheduleConfirmationDigest, type FireWiring } from './fire-wiring.js';

/**
 * T-061 (D-063 item 9): the work behind each Telegram command, built on the same functions as the host commands. Replies are
 * plain text; provider addresses never appear (providers are numbered), and errors are cleaned by the router.
 */

type ChainId = 1 | 8453 | 4663;
const CHAINS: ReadonlyArray<{ id: ChainId; name: string }> = [{ id: 1, name: 'Ethereum' }, { id: 8453, name: 'Base' }, { id: 4663, name: 'Robinhood' }];

export function chainFrom(text: string | undefined): ChainId {
  const value = (text ?? '').toLowerCase();
  if (value === 'ethereum' || value === 'eth' || value === '1') return 1;
  if (value === 'base' || value === '8453') return 8453;
  if (value === 'robinhood' || value === 'rh' || value === '4663') return 4663;
  throw new Error('CHAIN_INVALID: use ethereum, base or robinhood');
}
const chainName = (id: number): string => CHAINS.find((chain) => chain.id === id)?.name ?? `chain ${id}`;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ERC721_BALANCE_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
const ERC721_NAME_ABI = parseAbi(['function name() view returns (string)']);
const PROBE_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
const minutes = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

export interface TelegramActionDeps {
  mode: 'dry-run' | 'host';
  /** Who signs: from the service's custody setting, exactly as the host commands read it. */
  custody: 'local' | 'turnkey';
  store: BackendStore;
  /** The service's own application (not the read-only one), for health, approval and campaign records. */
  application: BackendApplication;
  coordinator: Pick<ExecutionCoordinator, 'kill'>;
  projectRoot: string;
  secretRoot: string;
  killSwitchPath: string;
  backupStatusPath: string;
  startedAt: Date;
  /** The owner's fleet: the wallets the bot signs with (Turnkey), public addresses only. */
  walletList(): Promise<string[]>;
  /** Public addresses the watcher watches, per chain. */
  watchedWallets(chainId: number): string[];
  watcherHealthy(): boolean | undefined;
  intelligence(): IntelligenceRepository;
  /** T-066: the owner's fee alerts. */
  gasAlerts(): GasAlertRepository;
  /** T-067: `/fire` and `/schedule`. Absent in practice mode, where nothing would run them. */
  /** T-068: the outside NFT data service (Blockscout). Absent when no key is stored. */
  portfolio?: PortfolioProvider;
  /** T-072: the ETH price in dollars (Chainlink, Coinbase as a fallback), display only. */
  prices?: EthPriceProvider;
  /** T-072: OpenSea collection floor prices, for the value shown by `/portfolio`. Absent when no key is stored. */
  floors?: OpenSeaFloors;
  fire?: FireWiring;
  /** T-073: the Turnkey policy's fee limit for Robinhood, in gwei (default 0.2, the standard policy). Used to check a custom fee ceiling. */
  policyFeeLimitGwei?: number;
  /** The reader `/watchaccept` uses for a wallet's transaction count and balance (default: the chain's own RPC). Tests supply their own. */
  walletReader?: (chainId: number) => Promise<unknown>;
  fireSchedulesRepository?: () => FireScheduleRepository;
  /** T-066: how many NFTs of a contract a wallet holds, and the contract's name. Default: read the chain. Tests supply their own. */
  nftBalance?: (chainId: number, contract: string, wallet: string) => Promise<bigint>;
  nftName?: (chainId: number, contract: string) => Promise<string | undefined>;
  /** T-066: how `/eligible` checks one drop (default: the same check as `/check`). Tests supply their own. */
  dropCheck?: (chain: string, contract: string) => Promise<string>;
  /** Robinhood dry run (default: read the chain). Tests supply their own. */
  robinhoodDryRun?: (contract: string, wallets: readonly string[], quantity: number | undefined, at: Date) => Promise<DryRunReport>;
  robinhoodLatestBlock?: () => Promise<{ number: bigint; hash: string }>;
  now?: () => Date;
}

export function createTelegramActions(deps: TelegramActionDeps): TelegramActions {
  const now = deps.now ?? (() => new Date());
  const bridge = deps.store as CanonicalStoreBridge;
  const endpoints = async (chainId: ChainId): Promise<string[]> => [...(await resolveChainConfigFromSecrets(chainId, 'mainnet', deps.secretRoot)).rpcEndpoints];
  const client = async (chainId: ChainId) => {
    const urls = await endpoints(chainId);
    if (urls.length === 0) throw new Error(`${chainName(chainId).toUpperCase()}_RPC_UNAVAILABLE`);
    return createPublicClient({ transport: failoverTransport(urls) });
  };
  const port = async (chainId: 1 | 8453): Promise<EngineIntelligencePort> => {
    const urls = await endpoints(chainId);
    if (urls.length === 0) throw new Error(`${chainName(chainId).toUpperCase()}_RPC_UNAVAILABLE`);
    return EngineIntelligencePort.fromRpcUrls(urls);
  };
  const walletReaderFor = async (chainId: number): Promise<unknown> => (deps.walletReader ? deps.walletReader(chainId) : client(chainId as ChainId));
  const fleet = async (chainId: number): Promise<string[]> => {
    const watched = deps.watchedWallets(chainId);
    return watched.length > 0 ? watched : (await deps.walletList()).map((wallet) => wallet.toLowerCase());
  };
  const campaign = (campaignId: string) => {
    const found = deps.store.snapshot().campaigns.find((item) => item.id === campaignId);
    if (!found) throw new Error('CAMPAIGN_NOT_FOUND: check the id (shown by /prepare)');
    return found;
  };
  const evmChain = (text: string): 1 | 8453 => {
    const id = chainFrom(text);
    if (id === 4663) throw new Error('INTERNAL_PATH_ERROR: Robinhood is handled before this point');
    return id;
  };
  const robinhoodDryRun = async (contract: string, wallets: readonly string[], quantity: number | undefined, at: Date): Promise<DryRunReport> => deps.robinhoodDryRun ? deps.robinhoodDryRun(contract, wallets, quantity, at) : dryRunDrop((await client(4663)) as never, contract, wallets, { ...(quantity === undefined ? {} : { quantity }), now: at });
  const robinhoodBlock = async (): Promise<{ number: bigint; hash: string }> => deps.robinhoodLatestBlock ? deps.robinhoodLatestBlock() : (async () => { const block = await (await client(4663)).getBlock({ blockTag: 'latest' }); return { number: block.number, hash: block.hash }; })();
  const walletsFor = async (text: string): Promise<string[]> => text.toLowerCase() === 'all' ? deps.walletList() : text.split(',').map((item) => item.trim()).filter(Boolean);

  const fireWiring = (): FireWiring => {
    if (deps.mode !== 'host' || !deps.fire || !deps.fireSchedulesRepository) throw new Error('LIVE_MODE_REQUIRED: the service is in practice mode, so nothing would run this');
    return deps.fire;
  };
  const fireCampaign = (campaignId: string, maxFeeGwei: number) => {
    if (!Number.isFinite(maxFeeGwei) || maxFeeGwei <= 0 || maxFeeGwei > 500 || !/^\d+(\.\d+)?$/.test(String(maxFeeGwei))) throw new Error('MAX_FEE_GWEI_REQUIRED: use more than 0 and at most 500, as a plain number such as 0.2');
    const target = campaign(campaignId);
    if (target.dryRun) throw new Error('LIVE_REQUIRES_NON_DRY_CAMPAIGN');
    if (existsSync(deps.killSwitchPath) || deps.store.snapshot().killed) throw new Error('KILL_SWITCH_ON: release it first (/unlock, then /release)');
    return target;
  };


  // T-073: the plan and the prepare, shared by the typed commands and the guided flows. `only` narrows the wallets (a campaign sized for
  // fewer wallets); it can only narrow: the wallets must still be ready, and a fire can never use more wallets than the campaign was sized for.
  type PlanFacts =
    | { kind: 'robinhood'; plan: RobinhoodPlan; quantity: number; maxQuantity: number }
    | { kind: 'evm'; planned: LivePlanResult; quantity: number; maxQuantity: number };
  const planFor = async (chainText: string, contract: string, quantityLimit: number | undefined, only?: readonly string[]): Promise<PlanFacts> => {
    if (!ADDRESS.test(contract)) throw new Error('CONTRACT_ADDRESS_INVALID');
    if (chainFrom(chainText) === 4663) {
      // T-063: Robinhood has no fee planner; the quantity is the one the Turnkey policy pins (default 1).
      const candidates = only ? [...only] : await deps.walletList();
      const quantity = quantityLimit ?? 1;
      const report = await robinhoodDryRun(contract, candidates, quantity, now());
      return { kind: 'robinhood', plan: buildRobinhoodPlan(report, { candidates, killSwitchPresent: existsSync(deps.killSwitchPath), quantity }), quantity, maxQuantity: report.drop?.maxPerWallet ?? 1 };
    }
    const chainId = evmChain(chainText);
    const planned = await livePlanAction({ chainId, contract, wallets: only ? [...only] : await deps.walletList(), ...(quantityLimit === undefined ? {} : { quantityLimit }), port: await port(chainId), killFile: deps.killSwitchPath, custody: deps.custody });
    return { kind: 'evm', planned, quantity: planned.plan.quantity, maxQuantity: planned.report.drop?.maxPerWallet ?? planned.plan.quantity };
  };
  const readyOf = (facts: PlanFacts): string[] => (facts.kind === 'robinhood' ? facts.plan.walletsReady : facts.planned.plan.walletsReady);
  const phraseOf = (facts: PlanFacts, contract: string): string | undefined => (facts.kind === 'robinhood' ? (facts.plan.verdict === 'ready' ? robinhoodConfirmationPhrase(contract, facts.quantity, facts.plan.walletsReady.length, facts.plan.totalMaxExposureEth) : undefined) : facts.planned.phrase);
  const isReady = (facts: PlanFacts): boolean => (facts.kind === 'robinhood' ? facts.plan.verdict === 'ready' : facts.planned.plan.verdict === 'ready');
  const renderPlan = (facts: PlanFacts): string => {
    if (facts.kind === 'robinhood') {
      const plan = facts.plan;
      return sections(
        [plan.summary],
        plan.opensAt ? [`Opens ${minutes(plan.opensAt)} UTC${plan.closesAt ? `, closes ${minutes(plan.closesAt)} UTC` : ''}.`] : [],
        [...plan.blockers.map((blocker) => `✗ ${shortenBalancesInParens(blocker)}`), ...plan.walletsNotReady.map((item) => `✗ ${short(item.wallet)}: ${shortenBalancesInParens(item.why)}`)],
        plan.warnings.map((warning) => `• ${warning}`),
      );
    }
    const { plan } = facts.planned;
    return sections(
      [plan.summary],
      plan.blockers.map((blocker) => `✗ ${shortenBalancesInParens(blocker)}`),
      plan.warnings.map((warning) => `• ${warning}`),
      facts.planned.phrase ? [`Planning fee: ${facts.planned.planningMaxFeeGwei ?? '?'} gwei.`] : [],
    );
  };
  const prepareFor = async (chainText: string, contract: string, quantityLimit: number | undefined, phrase: string, only?: readonly string[]): Promise<string> => {
    if (!ADDRESS.test(contract)) throw new Error('CONTRACT_ADDRESS_INVALID');
    if (chainFrom(chainText) === 4663) {
      const candidates = only ? [...only] : await deps.walletList();
      const robinhoodPlan = buildRobinhoodPlan(await robinhoodDryRun(contract, candidates, quantityLimit, now()), { candidates, killSwitchPresent: existsSync(deps.killSwitchPath), quantity: quantityLimit ?? 1 });
      const prepared = await robinhoodPrepareAction({ contract, priorityFeeGwei: ROBINHOOD_DEFAULT_TIP_GWEI, confirm: phrase, plan: robinhoodPlan, killFile: deps.killSwitchPath, store: deps.store as never, createCampaign: (input) => deps.application.createCampaign(input), now: now() });
      return sections([`Campaign recorded: ${prepared.campaign.id}`], [`Sized for ${prepared.walletsSized} wallet(s), ${prepared.quantity} NFT(s) each, the most it can spend is ${prepared.maxExposureEth} ETH. Nothing was sent.`]);
    }
    const chainId = evmChain(chainText);
    const wallets = only ? [...only] : await deps.walletList();
    const planned = await livePlanAction({ chainId, contract, wallets, quantityLimit, port: await port(chainId), killFile: deps.killSwitchPath, custody: deps.custody });
    // The tip is the one the stored Ethereum fee policy uses (live-prepare refuses any other); Base uses the host default.
    const policy = chainId === 1 ? (deps.store as unknown as PrepareStore).ethereumFeePolicyStatus?.() : undefined;
    const tipWei = policy?.stored?.tipWei ?? policy?.approved?.tipWei;
    const priorityFeeGwei = tipWei === undefined ? 0.1 : Number(formatGwei(BigInt(tipWei)));
    const prepared = await livePrepareAction({ chainId, contract, priorityFeeGwei, confirm: phrase, planned, killFile: deps.killSwitchPath, walletFileAddresses: wallets, store: deps.store as unknown as PrepareStore, createCampaign: (input) => deps.application.createCampaign(input), newId: () => `evt_${randomBytes(8).toString('hex')}`, now: now() });
    return sections([`Campaign recorded: ${prepared.campaign.id}`], [`${prepared.wallets.length} wallet(s), ${prepared.quantity} NFT(s) each, most it can spend ${prepared.maxExposureEth} ETH. Nothing was sent.`]);
  };
  const revokeRun = (chainId: ChainId, phrase: string | undefined): Record<string, unknown> => {
    if (chainId === 1) throw new Error('NOTHING_TO_REVOKE: Ethereum has no enablement record');
    const newId = () => `${chainId === 4663 ? 'rh' : 'base'}_revoke_${randomBytes(8).toString('hex')}`;
    return chainId === 4663
      ? runRobinhoodEnable({ action: 'revoke', confirm: phrase, now: now(), store: deps.store as unknown as EnableStore, newId })
      : runBaseEnable({ action: 'revoke', ...(phrase !== undefined ? { confirm: phrase } : {}), now: now(), store: deps.store as unknown as BaseEnableStore, newId });
  };
  const revokePhraseOf = (result: Record<string, unknown>): string | undefined => (result['state'] === 'ConfirmToRevoke' ? /--confirm "(.+)"$/.exec(String(result['copyThisToRevoke'] ?? ''))?.[1] : undefined);
  const releaseResult = (outcome: { state: string; message: string; phrase?: string }): string =>
    outcome.state === 'Released' ? `${outcome.message} The service accepts live work again within a few seconds if nothing else blocks it. /kill stops everything at any time.` : outcome.message;

  const actions: TelegramActions = {
    async status(role: TelegramRole) {
      const state = deps.store.snapshot();
      const uptimeHours = ((now().getTime() - deps.startedAt.getTime()) / 3_600_000).toFixed(1);
      const version = await codeVersion(deps.projectRoot).catch(() => 'unknown');
      if (role === 'viewer') return `MintBot is running (version ${version.slice(0, 12)}, up ${uptimeHours} h).`;
      const killed = existsSync(deps.killSwitchPath) || state.killed;
      const pending = bridge.recentLiveRunRequests ? bridge.recentLiveRunRequests(20).filter((item) => !item.outcome).length : 0;
      return sections([
        `Mode: ${deps.mode === 'host' ? 'LIVE (host)' : 'practice (dry-run)'}`,
        `Kill switch: ${killed ? 'ON (nothing can be spent)' : 'off'}`,
        `Service: ${state.runtime.startupState}${state.runtime.blockingReasons.length > 0 ? ` — ${state.runtime.blockingReasons.join(', ')}` : ''}`,
        `Live requests waiting: ${pending}`,
      ], [`Version: ${version.slice(0, 12)}`, `Uptime: ${uptimeHours} h`]);
    },
    async health() {
      const response = await deps.application.command<{ state?: string; ready?: boolean; reasons?: string[] }>('health');
      const data = response.data ?? {};
      return sections([`Health: ${data.ready ? 'ready' : 'not ready'} (${data.state ?? response.state})`], data.reasons && data.reasons.length > 0 ? [`Blocking: ${data.reasons.join(', ')}`] : []);
    },
    async rpc() {
      const lines: string[] = [];
      for (const chain of CHAINS) {
        const urls = await endpoints(chain.id).catch(() => [] as string[]);
        if (urls.length === 0) { lines.push(`${chain.name}: no provider configured`); continue; }
        const results = await Promise.all(urls.map(async (url, index) => {
          const started = Date.now();
          try {
            const block = await createPublicClient({ transport: httpTransport(url, { timeout: 5_000, retryCount: 0 }) }).getBlockNumber();
            return `provider ${index + 1} ok ${Date.now() - started} ms (block ${block})`;
          } catch { return `provider ${index + 1} FAILED`; }
        }));
        lines.push(`${chain.name}: ${results.join('; ')}`);
      }
      return lines.join('\n');
    },
    async gas(text) {
      const chains = text ? [CHAINS.find((chain) => chain.id === chainFrom(text))!] : CHAINS;
      const lines: string[] = [];
      for (const chain of chains) {
        try {
          const fees = await (await client(chain.id)).estimateFeesPerGas();
          lines.push(`${chain.name}: max fee ${Number(formatGwei(fees.maxFeePerGas ?? 0n)).toFixed(4)} gwei, tip ${Number(formatGwei(fees.maxPriorityFeePerGas ?? 0n)).toFixed(4)} gwei`);
        } catch { lines.push(`${chain.name}: unavailable`); }
      }
      return lines.join('\n');
    },
    async backup() {
      const facts = await backupFacts(deps.backupStatusPath);
      if (!facts) return 'No backup result has been recorded yet.';
      const hours = ((now().getTime() - facts.recordedAt.getTime()) / 3_600_000).toFixed(1);
      return `Last backup: ${facts.status === 'ok' ? 'OK' : 'FAILED'} at ${minutes(facts.recordedAt.toISOString())} UTC (${hours} h ago).`;
    },
    async wallets() {
      const healthy = deps.watcherHealthy();
      const head = [`Watcher: ${healthy === undefined ? 'not running' : healthy ? 'healthy' : 'NOT healthy'}`];
      const price = await deps.prices?.price().catch(() => undefined);
      const groups: string[][] = [];
      for (const chain of CHAINS) {
        const addresses = deps.watchedWallets(chain.id);
        if (addresses.length === 0) continue;
        const reader = await client(chain.id).catch(() => undefined);
        const lines = [`${chain.name}:`];
        for (const address of addresses) {
          // Cut to three significant digits for reading (T-071); `/funding` keeps exact amounts.
          const balance = reader ? await reader.getBalance({ address: address as Address }).then((wei) => `${shortEth(wei)} ETH${price ? ` ≈ ${usdText(Number(wei) / 1e18, price)}` : ''}`).catch(() => 'unavailable') : 'unavailable';
          lines.push(`  ${short(address)}  ${balance}`);
        }
        groups.push(lines);
      }
      const priceNote = price ? [`Dollar values use the ${price.source === 'chainlink' ? 'Chainlink' : 'Coinbase'} ETH price of $${price.usd.toFixed(2)}${price.source === 'chainlink' ? ` (updated ${minutes(price.asOf.toISOString())} UTC)` : ''}.`] : [];
      return groups.length > 0 ? sections(head, ...groups, priceNote) : sections(head, ['No wallets are listed for the watcher.']);
    },
    async funding(campaignId) {
      if (!campaignId) {
        const live = deps.store.snapshot().campaigns.filter((item) => !item.dryRun).slice(-5);
        return live.length === 0 ? 'No live campaign is recorded. Prepare one with /prepare.' : ['Live campaigns (send /funding and tap one):', ...live.map((item) => `• ${item.id} (${chainName(item.chainId)} ${short(item.contract)})`)].join('\n');
      }
      const treasury = process.env.MINT_BOT_TREASURY_ADDRESS ?? '';
      if (!ADDRESS.test(treasury)) throw new Error('FLEET_WATCH_TREASURY_INVALID');
      const target = campaign(campaignId);
      const reader = await client(target.chainId as ChainId);
      const balances = [];
      for (const address of await deps.walletList()) balances.push({ address, balanceWei: await reader.getBalance({ address: address as Address }) });
      return renderFundingPlan(planCampaignFunding({ campaign: target, balances, ceilings: DEFAULT_IDLE_BALANCE_CEILINGS }), treasury);
    },
    async enablement() {
      const at = now();
      const robinhood = validRobinhoodEnablement((deps.store as { robinhoodEnablement?: () => unknown }).robinhoodEnablement?.(), at);
      const base = validBaseEnablement((deps.store as { baseEnablement?: () => unknown }).baseEnablement?.(), at);
      return sections([
        'Ethereum: on (no record needed)',
        `Base: ${base ? `ON since ${minutes(base.approvedAt)} UTC, ${base.paidAllowed ? 'free and paid' : 'free only'}, until revoked` : 'off (needs its own evidence and record; nothing has been recorded for Base)'}`,
        `Robinhood: ${robinhood ? `ON since ${minutes(robinhood.approvedAt)} UTC, ${robinhood.paidAllowed ? 'free and paid' : 'free only'}, until revoked` : 'off'}`,
      ], ['Recording an enablement is done on the host; /revoke switches one off.']);
    },
    async drops() {
      const items = new Phase2ReadModelService(now).opportunities(deps.store.snapshot()).data ?? [];
      const top = [...items].sort((left, right) => (right.score.value ?? -1) - (left.score.value ?? -1)).slice(0, 8);
      if (top.length === 0) return 'No opportunities found yet.';
      return ['Top opportunities:', ...top.map((item) => `• ${cleanName(item.project.name) || 'Unnamed'} ${item.project.contract ? short(item.project.contract) : ''} — ${chainName(Number(item.chain.id))}, score ${item.score.value ?? '?'}${item.price?.amount ? `, ${formatEth(BigInt(item.price.amount.value))} ETH` : ''}${item.openingAt ? `, opens ${minutes(item.openingAt)} UTC` : ''}${item.project.contract ? `\n  ${item.project.contract}` : ''}`)].join('\n');
    },
    async calendar() {
      const entries = new Phase2ReadModelService(now).calendar(deps.store.snapshot()).data ?? [];
      const upcoming = [...entries].filter((entry) => entry.openingAt).sort((left, right) => (left.openingAt ?? '').localeCompare(right.openingAt ?? '')).slice(0, 10);
      if (upcoming.length === 0) return 'Nothing on the calendar yet.';
      return ['Mint calendar (UTC):', ...upcoming.map((entry) => `• ${minutes(entry.openingAt!)} — ${cleanName(entry.project.name) || 'Unnamed'} on ${chainName(Number(entry.chain.id))}, ${entry.price.amount ? `${formatEth(BigInt(entry.price.amount.value))} ETH` : 'price unknown'}, ${entry.publicStatus}${entry.project.contract ? `\n  ${entry.project.contract}` : ''}`)].join('\n');
    },
    async check(chainText, contract, includeFleet) {
      if (!ADDRESS.test(contract)) throw new Error('CONTRACT_ADDRESS_INVALID');
      const chainId = chainFrom(chainText);
      const wallets = includeFleet ? await fleet(chainId).catch(() => [] as string[]) : [];
      if (chainId === 4663) {
        // The Robinhood check needs a wallet to test from; without the owner's fleet a fixed public address that holds no key is used,
        // and its test-mint result is not shown.
        const showWallets = includeFleet && wallets.length > 0;
        const report = await dryRunDrop((await client(4663)) as never, contract, showWallets ? wallets : [PROBE_ADDRESS], { now: now() });
        const drop = report.drop;
        return [
          `Robinhood ${short(contract)}: ${showWallets ? report.summary : drop ? 'drop found' : report.summary}`,
          ...(drop ? [`Price ${drop.priceEth} ETH, up to ${drop.maxPerWallet} per wallet, ${drop.status}${drop.opensAt ? `, opens ${minutes(drop.opensAt)} UTC` : ''}`] : []),
          ...(showWallets ? report.wallets.map((row) => `  ${short(row.wallet)} test mint ${row.simulation}${row.reason ? ` (${row.reason})` : ''}`) : []),
        ].join('\n');
      }
      const report = await checkDrop(await port(chainId), contract, wallets, { simulate: false });
      const drop = report.drop;
      return [
        `${chainName(chainId)} ${short(contract)}: ${report.summary}`,
        ...(drop ? [`Price ${drop.priceEth} ETH, up to ${drop.maxPerWallet} per wallet, ${drop.status}${drop.opensAt ? `, opens ${minutes(drop.opensAt)} UTC` : ''}`] : []),
        ...(includeFleet ? report.wallets.map((row) => `  ${short(row.wallet)} ${row.verdict}${row.topUpEth ? ` (needs ${row.topUpEth} ETH)` : ''}`) : []),
      ].join('\n');
    },
    async requestPreview(campaignId, walletsText, maxFeeGwei) {
      const preview = previewLiveRequest(deps.store.snapshot(), campaignId, await walletsFor(walletsText), maxFeeGwei, now());
      return { wallets: preview.wallets, text: `The service will arm and run ${chainName(preview.chainId)} ${short(preview.contract)}: ${preview.quantityPerWallet} NFT(s) per wallet at ${preview.priceEth} ETH, from ${preview.wallets.length} wallet(s). The most that can be spent is ${preview.maxExposureEth} ETH, signing at no more than ${preview.maxFeeGwei} gwei. Every guard still applies.`, phrase: preview.phrase };
    },
    async requestCreate(campaignId, walletsText, maxFeeGwei, phrase) {
      if (deps.mode !== 'host') throw new Error('LIVE_MODE_REQUIRED: the service is in practice mode, so nothing would run this request');
      if (deps.fireSchedulesRepository?.().open(campaignId).length) throw new Error('FIRE_CONFLICT: a scheduled mint is open for this campaign; cancel it first with /schedules and /cancel');
      const result = await runLiveRequest({ action: 'create', campaignId, wallets: await walletsFor(walletsText), maxFeeGwei, confirm: phrase, now: now(), store: deps.store as never, approve: (validated) => deps.application.command('approve', { validated }) });
      return sections([`Campaign: ${campaignId}`], [`Request ${String(result.requestId)} sent. The service starts it within a few seconds; follow it with /requests and /runs. /kill stops everything.`]);
    },
    async requests() {
      const rows = bridge.recentLiveRunRequests ? bridge.recentLiveRunRequests(10) : [];
      if (rows.length === 0) return 'No live requests yet.';
      return ['Live requests (newest first):', ...rows.map((row) => `• ${row.id} — ${row.outcome ?? (Date.parse(row.expiresAt) <= now().getTime() ? 'expired (not claimed)' : 'waiting')} — ${row.wallets.length} wallet(s), ≤${row.maxFeeGwei} gwei, ${minutes(row.requestedAt)} UTC`)].join('\n');
    },
    async runs() {
      const runs = [...deps.store.snapshot().runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 10);
      if (runs.length === 0) return 'No runs yet.';
      return ['Recent runs (newest first):', ...runs.map((run) => `• ${run.id} — ${run.mode}, ${run.state}, ${minutes(run.createdAt)} UTC`), '', 'To look at one, send /run and tap it.'].join('\n');
    },
    async run(runId) { return describeLiveRunResult(deps.store.snapshot(), runId).summary; },
    async watchlist() {
      const rows = deps.intelligence().observedAddresses(1);
      return rows.length === 0 ? 'No wallets are tracked. Add one with /track <address> [label].' : ['Tracked wallets (Ethereum):', ...rows.map((row) => `• ${row.address}${row.label ? ` — ${row.label}` : ''}`)].join('\n');
    },
    async track(address, label) {
      if (!ADDRESS.test(address)) throw new Error('ADDRESS_INVALID');
      const row = deps.intelligence().addObservedAddress(1, address.toLowerCase(), label);
      return `Tracking ${row.address}${row.label ? ` (${row.label})` : ''}.`;
    },
    async untrack(address) {
      if (!ADDRESS.test(address)) throw new Error('ADDRESS_INVALID');
      return deps.intelligence().disableObservedAddress(1, address.toLowerCase()) ? `Stopped tracking ${address.toLowerCase()}.` : 'That wallet was not tracked.';
    },
    async prepare(chainText, contract, quantityLimit, phrase) {
      return prepareFor(chainText, contract, quantityLimit, phrase);
    },
    async simulate(campaignId) {
      const target = campaign(campaignId);
      if (target.chainId === 4663) {
        const report = await robinhoodDryRun(target.contract, await deps.walletList(), target.quantity, now());
        const recorded = await recordRobinhoodSimulationsAction({ store: deps.store, campaign: target, report, latestBlock: robinhoodBlock });
        return sections(
          [`${recorded.recorded.length} wallet(s) passed the test mint. The records are good for 30 minutes.`],
          recorded.skipped.map((item) => `✗ ${short(item.wallet)}: ${item.why}`),
          recorded.recorded.length > sizedWalletCount(target) ? [`This campaign was sized for ${sizedWalletCount(target)} wallet(s), so a request uses at most ${sizedWalletCount(target)} of them.`] : [],
        );
      }
      const reader = await client(target.chainId);
      const ids = await recordSimulationAction({ store: deps.store, campaign: target, wallets: await deps.walletList(), port: await port(target.chainId), latestBlock: async () => { const block = await reader.getBlock({ blockTag: 'latest' }); return { number: block.number, hash: block.hash }; } });
      return `${ids.length} wallet(s) passed the test mint. The records are good for 30 minutes.`;
    },
    async firePreview(campaignId, walletsText, maxFeeGwei) {
      const wiring = fireWiring();
      const target = fireCampaign(campaignId, maxFeeGwei);
      const state = await wiring.mintState(target);
      if (state !== 'open') throw new Error(`MINT_NOT_OPEN: the mint is ${state === 'unknown' ? 'not readable right now' : state}. Test mints only pass once it is open; use /schedule to fire it when it opens`);
      const wallets = await wiring.wallets(walletsText);
      // A campaign sized for N wallets covers at most N: it uses the first N that pass their test mint, and the owner is told.
      const sized = sizedWalletCount(target);
      if (sized < 1) throw new Error('CAMPAIGN_SIZED_FOR_NONE: this campaign was sized for no wallet (its run limit is below what one wallet can spend). Prepare a new one.');
      const conflict = wiring.conflict(campaignId);
      if (conflict) throw new Error(`FIRE_CONFLICT: ${conflict}`);
      return { wallets, digest: wiring.campaignDigest(target), text: sections([`The mint is OPEN. Fire now: test mint each wallet, approve the ones that pass, and run.`], [wiring.describe(target, wallets, maxFeeGwei)], wallets.length > sized ? [`This campaign was sized for ${sized} wallet(s), so it uses the first ${sized} that pass their test mint.`] : []) };
    },
    async fireNow(campaignId, walletsText, maxFeeGwei, digest) {
      if (digest !== undefined && fireWiring().campaignDigest(campaign(campaignId)) !== digest) throw new Error('CAMPAIGN_CHANGED: the campaign changed since the preview; send /fire again');
      const result = await fireWiring().fireNow(campaignId, await fireWiring().wallets(walletsText), maxFeeGwei);
      return sections([`Campaign: ${campaignId}`], [`Request ${result.requestId} sent for ${result.wallets.length} wallet(s); the service arms and runs it within seconds. Follow it with /requests and /runs. /kill stops everything.`], result.skipped.map((item) => `✗ ${short(item.wallet)} skipped: ${item.why}`));
    },
    async schedulePreview(campaignId, walletsText, maxFeeGwei, fromText, untilText) {
      const wiring = fireWiring();
      const target = fireCampaign(campaignId, maxFeeGwei);
      const { from, until } = wiring.parseWindow(fromText, untilText);
      const wallets = await wiring.wallets(walletsText);
      const sized = sizedWalletCount(target);
      if (sized < 1) throw new Error('CAMPAIGN_SIZED_FOR_NONE: this campaign was sized for no wallet (its run limit is below what one wallet can spend). Prepare a new one.');
      const conflict = wiring.conflict(campaignId);
      if (conflict) throw new Error(`FIRE_CONFLICT: ${conflict}`);
      return { wallets, from: from.toISOString(), until: until.toISOString(), digest: wiring.campaignDigest(target), phrase: wiring.schedulePhrase(target, wallets, maxFeeGwei, from, until), text: `Scheduled mint. When the mint opens between ${from.toISOString().slice(0, 16).replace('T', ' ')} and ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC, the service tests each wallet, approves the ones that pass, and runs, without asking you again.\n${wiring.describe(target, wallets, maxFeeGwei)}${wallets.length > sized ? `\nThis campaign was sized for ${sized} wallet(s), so it uses the first ${sized} that pass their test mint.` : ''}\nIt is cancelled by /cancel, by /kill, or if the campaign changes. If the kill switch is on it waits and tells you.` };
    },
    async scheduleCreate(campaignId, walletsText, maxFeeGwei, fromText, untilText, phrase, digest) {
      const wiring = fireWiring();
      const target = fireCampaign(campaignId, maxFeeGwei);
      if (digest !== undefined && wiring.campaignDigest(target) !== digest) throw new Error('CAMPAIGN_CHANGED: the campaign changed since the preview; start the schedule again');
      const { from, until } = wiring.parseWindow(fromText, untilText);
      const wallets = await wiring.wallets(walletsText);
      if (phrase !== wiring.schedulePhrase(target, wallets, maxFeeGwei, from, until)) throw new Error('CONFIRMATION_PHRASE_MISMATCH: the schedule changed since the preview. Send /schedule to start again');
      const conflict = wiring.conflict(campaignId);
      if (conflict) throw new Error(`FIRE_CONFLICT: ${conflict}`);
      const record = deps.fireSchedulesRepository!().create({ campaignId, campaignDigest: wiring.campaignDigest(target), wallets, maxFeeGwei: String(maxFeeGwei), windowFrom: from.toISOString(), windowUntil: until.toISOString(), confirmationDigest: scheduleConfirmationDigest(phrase, campaignId, wallets, from, until) });
      return `Campaign: ${campaignId}\n\nScheduled mint ${record.id.slice(-6)} stored. It fires once, when the mint opens between ${minutes(record.windowFrom)} and ${minutes(record.windowUntil)} UTC. Cancel it any time with /cancel (it lists what can be cancelled as buttons). Keep the kill switch off until then.`;
    },
    async schedules() {
      const rows = deps.fireSchedulesRepository ? deps.fireSchedulesRepository().recent(10) : [];
      if (rows.length === 0) return 'No scheduled mints yet.';
      const nowMs = now().getTime();
      return ['Scheduled mints (newest first):', ...rows.map((row) => `• ${row.id.slice(-6)} — ${row.outcome ?? (Date.parse(row.windowUntil) <= nowMs ? 'expired (not claimed)' : Date.parse(row.windowFrom) > nowMs ? 'waiting for its window' : 'watching for the mint to open')} — ${row.wallets.length} wallet(s), ≤${row.maxFeeGwei} gwei, ${minutes(row.windowFrom)} to ${minutes(row.windowUntil)} UTC`)].join('\n');
    },
    async cancel(requestId) {
      if (/^fire_schedule_|^[0-9a-f]{4,12}$/i.test(requestId) && deps.fireSchedulesRepository?.().cancel(requestId)) return `Scheduled mint ${requestId.slice(-6)} cancelled; the service will not fire it.`;
      if (!bridge.claimLiveRunRequest) throw new Error('CANONICAL_STORE_REQUIRED');
      return bridge.claimLiveRunRequest(requestId, 'cancelled') ? `Request ${requestId} cancelled; the service will not start it.` : 'Not cancelled: that request is unknown, or the service already started, expired or cancelled it. See /requests.';
    },
    async kill() {
      // Both are attempted on their own, as the watcher does: the kill file and the coordinator. One is enough to stop new work.
      const outcomes = await Promise.allSettled([engageKillSwitchFile(deps.killSwitchPath, 'owner Telegram /kill'), deps.coordinator.kill('owner Telegram /kill')]);
      if (outcomes.every((outcome) => outcome.status === 'rejected')) throw new Error('KILL_SWITCH_NOT_ENGAGED');
      // A kill ends every scheduled mint too (D-067); a failure here never hides that the kill switch is on.
      let cancelled = 0;
      let scheduleFailed = false;
      try { cancelled = deps.fireSchedulesRepository?.().cancelAllOpen() ?? 0; } catch { scheduleFailed = true; /* the kill switch itself is what stops a fire */ }
      const scheduleNote = scheduleFailed ? ' Scheduled mints could not be cancelled; check /schedules (the kill switch still stops them).' : cancelled > 0 ? ` ${cancelled} scheduled mint(s) cancelled.` : '';
      return `The kill switch is ON.${scheduleNote} Nothing new can be spent. Release it with /unlock then /release when you are ready.`;
    },
    async revoke(chainText, phrase) {
      const chainId = chainFrom(chainText);
      const result = revokeRun(chainId, phrase);
      if (result.state === 'ConfirmToRevoke') return `${String(result.message)}\n\nSend /revoke to switch ${chainName(chainId)} off with a button.`;
      return String(result.message);
    },
    async revokeChoices() {
      const at = now();
      const robinhood = validRobinhoodEnablement((deps.store as { robinhoodEnablement?: () => unknown }).robinhoodEnablement?.(), at);
      const base = validBaseEnablement((deps.store as { baseEnablement?: () => unknown }).baseEnablement?.(), at);
      return [...(base ? [{ key: 'base' as const, name: 'Base' }] : []), ...(robinhood ? [{ key: 'robinhood' as const, name: 'Robinhood' }] : [])];
    },
    async revokeStatus(chainText) {
      const chainId = chainFrom(chainText);
      const result = revokeRun(chainId, undefined);
      const phrase = result.state === 'ConfirmToRevoke' ? revokePhraseOf(result) : undefined;
      return { text: String(result.message), ...(phrase ? { phrase } : {}) };
    },
    async revokeNow(chainText, expectedPhrase) {
      const chainId = chainFrom(chainText);
      // The phrase names the enablement record that was shown; if a different record is current now, the old button does not switch it off.
      const current = revokePhraseOf(revokeRun(chainId, undefined));
      if (!current) throw new Error('NOTHING_TO_REVOKE: that chain is not switched on');
      if (!expectedPhrase || current !== expectedPhrase) throw new Error('ENABLEMENT_CHANGED: the enablement record is a different one now. Send /revoke to see the current state.');
      return String(revokeRun(chainId, current).message);
    },
    async watchChains() {
      return CHAINS.filter((chain) => deps.watchedWallets(chain.id).length > 0).map((chain) => ({ key: (chain.id === 1 ? 'ethereum' : chain.id === 8453 ? 'base' : 'robinhood') as 'ethereum' | 'base' | 'robinhood', name: chain.name }));
    },
    async watchWallets(chainText) { return deps.watchedWallets(chainFrom(chainText)).map((wallet) => wallet.toLowerCase()); },
    async watchStatus(chainText, address) {
      const chainId = chainFrom(chainText);
      const outcome = await watchAcceptAction({ chainId, address, confirm: undefined, client: await walletReaderFor(chainId) as never, store: deps.store, newId: () => `evt_${randomBytes(8).toString('hex')}`, now: now() });
      if (outcome.state !== 'Preview') throw new Error('WALLET_NOT_PREVIEWABLE: the wallet could not be read');
      return { text: outcome.message, phrase: outcome.phrase };
    },
    async watchAcceptNow(chainText, address, expectedPhrase) {
      const chainId = chainFrom(chainText);
      const reader = await walletReaderFor(chainId) as never;
      const newId = () => `evt_${randomBytes(8).toString('hex')}`;
      const fresh = await watchAcceptAction({ chainId, address, confirm: undefined, client: reader, store: deps.store, newId, now: now() });
      // The phrase names the wallet's sent-transaction count and balance: if either changed since it was shown, the owner must look again.
      if (fresh.state !== 'Preview' || fresh.phrase !== expectedPhrase) throw new Error('WALLET_CHANGED_AGAIN: the wallet changed since you looked (new transactions or a new balance). Send /watchaccept to look again.');
      const outcome = await watchAcceptAction({ chainId, address, confirm: expectedPhrase, client: reader, store: deps.store, newId, now: now() });
      // Only a real acceptance counts: if the wallet moved between the two reads nothing was accepted, and that is said and recorded as refused.
      if (outcome.state !== 'Accepted') throw new Error('WALLET_CHANGED_AGAIN: the wallet changed while accepting, so nothing was accepted. Send /watchaccept to look again.');
      return outcome.message;
    },
    async release(phrase) {
      const outcome = await killReleaseAction({ store: asKillStore(deps.store), killFile: deps.killSwitchPath, confirm: phrase, actor: 'owner-telegram' });
      if (outcome.state === 'On') return `${outcome.message}${outcome.phrase ? '\n\nSend /release to release it with a button.' : ''}`;
      return outcome.state === 'Released' ? `${outcome.message} The service accepts live work again within a few seconds if nothing else blocks it. /kill stops everything at any time.` : outcome.message;
    },
    async watchAccept(chainText, address, phrase) {
      const chainId = chainFrom(chainText);
      const outcome = await watchAcceptAction({ chainId, address, confirm: phrase, client: await walletReaderFor(chainId) as never, store: deps.store, newId: () => `evt_${randomBytes(8).toString('hex')}`, now: now() });
      return outcome.state === 'Preview' ? `${outcome.message}\n\nThat phrase does not match the wallet as it is now. Send /watchaccept to look again and accept it with a button.` : outcome.message;
    },
    async guidedChains() {
      const at = now();
      const robinhood = validRobinhoodEnablement((deps.store as { robinhoodEnablement?: () => unknown }).robinhoodEnablement?.(), at);
      const base = validBaseEnablement((deps.store as { baseEnablement?: () => unknown }).baseEnablement?.(), at);
      return [{ key: 'ethereum' as const, name: 'Ethereum' }, ...(base ? [{ key: 'base' as const, name: 'Base' }] : []), ...(robinhood ? [{ key: 'robinhood' as const, name: 'Robinhood' }] : [])];
    },
    async guidedPlan(chainText, contract, quantity, walletCount) {
      let facts = await planFor(chainText, contract, quantity);
      const all = readyOf(facts);
      if (walletCount !== undefined && isReady(facts) && walletCount < all.length) facts = await planFor(chainText, contract, quantity, all.slice(0, walletCount));
      return { text: renderPlan(facts), ok: isReady(facts), ready: readyOf(facts), quantity: facts.quantity, maxQuantity: facts.maxQuantity, ...(isReady(facts) && phraseOf(facts, contract) ? { phrase: phraseOf(facts, contract)! } : {}) };
    },
    async guidedPrepare(chainText, contract, quantity, wallets, expectedPhrase) {
      const facts = await planFor(chainText, contract, quantity, wallets);
      const ready = readyOf(facts);
      if (!isReady(facts) || ready.length !== wallets.length) throw new Error('WALLETS_CHANGED: the plan changed since you looked at it (a wallet is no longer ready). Start the guide again.');
      const phrase = phraseOf(facts, contract);
      if (!phrase) throw new Error('LIVE_PLAN_NOT_READY: the plan is not ready');
      // The phrase names the contract, quantity, number of wallets and the most that can be spent: it must be the one that was reviewed.
      if (expectedPhrase !== undefined && phrase !== expectedPhrase) throw new Error('PLAN_CHANGED: the plan changed since you reviewed it (the amount that can be spent or the wallets differ). Start the guide again.');
      const text = await prepareFor(chainText, contract, quantity, phrase, wallets);
      return { text, campaignId: /cmp_[0-9a-f-]{36}/.exec(text)?.[0] };
    },
    async releaseStatus() {
      const outcome = await killReleaseAction({ store: asKillStore(deps.store), killFile: deps.killSwitchPath, confirm: undefined, actor: 'owner-telegram' });
      const phrase = outcome.state === 'On' ? outcome.phrase : undefined;
      return { text: outcome.message, canRelease: Boolean(phrase), ...(phrase ? { phrase } : {}) };
    },
    async releaseNow(expectedPhrase) {
      // The phrase is built here from the current state (never taken from the button), then the same release action runs as for the typed phrase.
      const first = await killReleaseAction({ store: asKillStore(deps.store), killFile: deps.killSwitchPath, confirm: undefined, actor: 'owner-telegram' });
      if (first.state !== 'On' || !first.phrase) return releaseResult(first);
      // The phrase names this engagement of the kill switch; if it was engaged again since the owner looked, the old button does not release the new one.
      if (expectedPhrase !== undefined && first.phrase !== expectedPhrase) throw new Error('KILL_STATE_CHANGED: the kill switch was engaged again since you looked. Send /release to see the current state.');
      return releaseResult(await killReleaseAction({ store: asKillStore(deps.store), killFile: deps.killSwitchPath, confirm: first.phrase, actor: 'owner-telegram' }));
    },
    async guidedCampaigns() {
      const live = deps.store.snapshot().campaigns.filter((item) => !item.dryRun).slice(-6).reverse();
      const wiring = deps.fire;
      return Promise.all(live.map(async (item) => {
        const state = wiring ? await Promise.race([wiring.mintState(item), new Promise<'unknown'>((resolve) => { const timer = setTimeout(() => resolve('unknown'), 5_000); timer.unref?.(); })]).catch(() => 'unknown' as const) : 'unknown';
        const conflict = wiring?.conflict(item.id);
        const mint = state === 'open' ? 'mint is open' : state === 'upcoming' ? 'mint not open yet' : state === 'ended' ? 'mint ended' : 'mint state unknown';
        return { id: item.id, label: `${chainName(item.chainId)} ${short(item.contract)} · ${item.quantity} NFT`, note: `${mint}${conflict ? `; busy: ${conflict}` : ''}` };
      }));
    },
    async signingWallets() { return (await deps.walletList()).map((wallet) => wallet.toLowerCase()); },
    async feeOptions(campaignId) {
      // Robinhood's Turnkey policy pins the fee limit (the standard policy: 0.2 gwei). Other chains have no fixed limit here; the spend caps bound them.
      return campaign(campaignId).chainId === 4663 ? { presets: [0.1, 0.2], limit: deps.policyFeeLimitGwei ?? 0.2, unit: 'gwei' } : { presets: [5, 10, 25], limit: undefined, unit: 'gwei' };
    },
    async recentRuns() {
      return [...deps.store.snapshot().runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 8).map((run) => ({ id: run.id, label: `${run.mode} · ${run.state} · ${minutes(run.createdAt).slice(5)} UTC` }));
    },
    async simulateCampaign(campaignId) {
      const target = campaign(campaignId);
      let recorded: string[];
      let skipped: Array<{ wallet: string; why: string }>;
      if (target.chainId === 4663) {
        const report = await robinhoodDryRun(target.contract, await deps.walletList(), target.quantity, now());
        const result = await recordRobinhoodSimulationsAction({ store: deps.store, campaign: target, report, latestBlock: robinhoodBlock });
        recorded = result.recorded; skipped = result.skipped;
      } else {
        const reader = await client(target.chainId);
        const result = await recordPassingSimulationsAction({ store: deps.store, campaign: target, wallets: await deps.walletList(), port: await port(target.chainId), latestBlock: async () => { const block = await reader.getBlock({ blockTag: 'latest' }); return { number: block.number, hash: block.hash }; } });
        recorded = result.recorded; skipped = result.skipped;
      }
      const sized = sizedWalletCount(target);
      return { recorded, sized, text: sections([`Campaign: ${campaignId}`], [`${recorded.length} wallet(s) passed the test mint. The records are good for 30 minutes.`], skipped.map((item) => `✗ ${short(item.wallet)}: ${shortenBalancesInParens(item.why)}`), recorded.length > sized ? [`This campaign was sized for ${sized} wallet(s), so a request uses at most ${sized} of them.`] : []) };
    },
    async requestCandidates() {
      const at = now().toISOString();
      const state = deps.store.snapshot();
      const byCampaign = new Map<string, { wallets: Set<string>; until: string }>();
      for (const sim of state.simulations) {
        if (!sim.success || sim.expiresAt <= at) continue;
        const entry = byCampaign.get(sim.campaignId) ?? { wallets: new Set<string>(), until: sim.expiresAt };
        entry.wallets.add(sim.wallet.toLowerCase());
        if (sim.expiresAt > entry.until) entry.until = sim.expiresAt;
        byCampaign.set(sim.campaignId, entry);
      }
      return state.campaigns.filter((item) => !item.dryRun && byCampaign.has(item.id)).slice(-6).reverse().map((item) => {
        const entry = byCampaign.get(item.id)!;
        const left = Math.max(0, Math.round((Date.parse(entry.until) - now().getTime()) / 60_000));
        return { id: item.id, label: `${chainName(item.chainId)} ${short(item.contract)} · ${item.quantity} NFT`, note: `${entry.wallets.size} wallet(s) tested, about ${left} min left` };
      });
    },
    async requestWallets(campaignId) {
      const target = campaign(campaignId);
      const at = now().toISOString();
      const latest = new Map<string, string>();
      for (const sim of deps.store.snapshot().simulations) {
        if (sim.campaignId !== campaignId || !sim.success || sim.expiresAt <= at) continue;
        const wallet = sim.wallet.toLowerCase();
        if (!latest.has(wallet) || sim.checkedAt > latest.get(wallet)!) latest.set(wallet, sim.checkedAt);
      }
      return { wallets: [...latest.keys()], sized: Math.max(1, sizedWalletCount(target)) };
    },
    async requestSend(campaignId, walletsText, maxFeeGwei, expectedPhrase) {
      const preview = await actions.requestPreview(campaignId, walletsText, maxFeeGwei);
      // The phrase names the campaign, the number of wallets, the most that can be spent and the fee ceiling: it must be the reviewed one.
      if (preview.phrase !== expectedPhrase) throw new Error('PLAN_CHANGED: the request changed since you reviewed it (the test mints expired or the amounts differ). Start again.');
      return actions.requestCreate(campaignId, walletsText, maxFeeGwei, preview.phrase);
    },
    async cancellables() {
      const nowMs = now().getTime();
      const requests = (bridge.unclaimedLiveRunRequests ? bridge.unclaimedLiveRunRequests() : []).filter((row) => Date.parse(row.expiresAt) > nowMs).map((row) => ({ id: row.id, label: `Request ${row.id.slice(-6)} · ${row.wallets.length} wallet(s), ≤${row.maxFeeGwei} gwei` }));
      const schedules = deps.fireSchedulesRepository ? deps.fireSchedulesRepository().open().map((row) => ({ id: row.id, label: `Schedule ${row.id.slice(-6)} · ${minutes(row.windowFrom)}–${minutes(row.windowUntil).slice(11)} UTC` })) : [];
      return [...requests, ...schedules];
    },
    killEngagedSince(openedAt) {
      const since = Date.parse(openedAt);
      const state = deps.store.snapshot();
      if (state.events.some((event) => event.type === 'kill' && Date.parse(event.at) > since)) return true;
      const status = (deps.store as { killSwitchStatus?: () => { engaged: boolean; changedAt: string } }).killSwitchStatus?.();
      if (status?.engaged && Date.parse(status.changedAt) > since) return true;
      // A kill file created after the session opened (by the watcher, a provider check or the owner on the host) ends it too.
      try { if (statSync(deps.killSwitchPath).mtimeMs > since) return true; } catch { /* no file */ }
      return false;
    },
    async limits() {
      return describeLimits(deps.store.snapshot(), now(), existsSync(deps.killSwitchPath));
    },
    async history() { return describeHistory(deps.store.snapshot()); },
    async activity() {
      const labels = new Map(deps.intelligence().observedAddresses(1).map((row) => [row.address.toLowerCase(), row.label] as const));
      return describeActivity(deps.store.snapshot().events, labels);
    },
    async eligible() {
      const entries = new Phase2ReadModelService(now).calendar(deps.store.snapshot()).data ?? [];
      const upcoming = [...entries].filter((entry) => entry.project.contract && (!entry.closingAt || entry.closingAt > now().toISOString())).sort((left, right) => (left.openingAt ?? '').localeCompare(right.openingAt ?? '')).slice(0, 4);
      if (upcoming.length === 0) return 'No upcoming or open drops are on the calendar. /drops shows what discovery found.';
      const blocks: string[] = [];
      for (const entry of upcoming) {
        // By id only: the calendar's own chain name calls every chain but Robinhood "Ethereum".
        const chain = CHAINS.find((item) => String(item.id) === entry.chain.id);
        if (!chain) continue;
        const text = await (deps.dropCheck ? deps.dropCheck(chain.name.toLowerCase(), entry.project.contract!) : actions.check(chain.name.toLowerCase(), entry.project.contract!, true)).catch((error: unknown) => `could not be checked (${error instanceof Error ? error.message.split(':')[0] : 'error'})`);
        blocks.push(`${entry.openingAt ? `${minutes(entry.openingAt)} UTC — ` : ''}${cleanName(entry.project.name) || 'Unnamed'}\n${text}`);
      }
      return blocks.length === 0 ? 'No drop on the calendar is on a chain MintBot can check.' : ['Upcoming drops against your wallets:', ...blocks].join('\n\n');
    },
    async portfolio() {
      if (!deps.portfolio) throw new Error('PORTFOLIO_NOT_SET_UP: no Blockscout key is stored on the host, so /portfolio is off. /holdings still shows MintBot\'s own mints');
      const provider = deps.portfolio;
      const wallets = (await deps.walletList()).slice(0, 10);
      if (wallets.length === 0) return 'No wallets are set up, so there is nothing to show.';
      const price = await deps.prices?.price().catch(() => undefined);
      const money = (eth: number): string => `${shortEth(parseEther(eth.toFixed(18)))} ETH${price ? ` (${usdText(eth, price)})` : ''}`;
      const groups: string[][] = [[`Everything your ${wallets.length} signing wallet(s) hold (the wallets in your Turnkey wallet map; /wallets also lists watched wallets), from Blockscout. It can lag the chain by a minute or two; /holdings reads MintBot's own mints straight from the chain.`]];
      let asOf: Date | undefined;
      let anyFloor = false;
      for (const chainId of PORTFOLIO_CHAINS) {
        const rows = await Promise.all(wallets.map(async (wallet) => { try { return { wallet, ...(await provider.list(chainId, wallet)) }; } catch (error) { return { wallet, failed: (error instanceof Error ? error.message : '').split(':')[0] ?? 'PORTFOLIO_UNAVAILABLE' }; } }));
        const total = rows.reduce((sum, row) => sum + ('items' in row ? row.items.reduce((count, item) => count + item.amount, 0n) : 0n), 0n);
        const lines = [`${chainName(chainId)}: ${total} NFT(s)`];
        const grouped = new Map<string, { name: string; count: bigint; contract: string | undefined }>();
        for (const row of rows) {
          if ('failed' in row) { lines.push(`• ${short(row.wallet)} could not be read (${row.failed})`); continue; }
          asOf = asOf && asOf > row.asOf ? asOf : row.asOf;
          if (row.truncated) lines.push(`• ${short(row.wallet)}: only the first pages were read, so its list is partial`);
          for (const item of row.items) {
            const key = item.contract ?? 'unknown';
            const entry = grouped.get(key) ?? { name: cleanName(item.name) ?? (item.contract ? short(item.contract) : 'unknown collection'), count: 0n, contract: item.contract };
            entry.count += item.amount;
            grouped.set(key, entry);
          }
        }
        const top = [...grouped.values()].sort((left, right) => (right.count > left.count ? 1 : right.count < left.count ? -1 : 0)).slice(0, 12);
        // T-072: floor prices from OpenSea for the largest holdings (an estimate of listing prices; a collection with no known floor is not counted).
        const floors = await Promise.all(top.map(async (entry) => { if (!deps.floors || !entry.contract) return undefined; try { return (await deps.floors.floor(chainId, entry.contract)).floorEth; } catch { return undefined; } }));
        let floorTotal = 0;
        top.forEach((entry, index) => {
          const floor = floors[index];
          if (floor !== undefined) { floorTotal += Number(entry.count) * floor; anyFloor = true; }
          lines.push(`  ${entry.name} × ${entry.count}${floor !== undefined ? ` · floor ${shortEth(parseEther(floor.toFixed(18)))} ETH` : ''}`);
        });
        if (grouped.size > top.length) lines.push(`  …and ${grouped.size - top.length} more collection(s)`);
        if (floorTotal > 0) lines.push(`Estimated Floor Value: ${money(floorTotal)}`);
        groups.push(lines);
      }
      const notes = ['Base is not covered by the free Blockscout plan; /holdings shows MintBot\'s Base mints from the chain.'];
      if (anyFloor) notes.push('Floor values are OpenSea listing prices, an estimate and not what a sale would fetch; collections without a known floor are not counted.');
      if (price) notes.push(`Dollar values use the ${price.source === 'chainlink' ? 'Chainlink' : 'Coinbase'} ETH price of $${price.usd.toFixed(2)}${price.source === 'chainlink' ? ` (updated ${minutes(price.asOf.toISOString())} UTC)` : ''}.`);
      if (asOf) notes.push(`As of ${minutes(asOf.toISOString())} UTC (results are kept 5 minutes).`);
      return sections(...groups, notes);
    },
    async holdings() {
      const state = deps.store.snapshot();
      const confirmedRuns = new Set(state.receipts.filter((receipt) => receipt.state === 'Confirmed').map((receipt) => receipt.runId));
      const campaignsMinted = new Map<string, { chainId: number; contract: string }>();
      for (const run of state.runs) {
        if (run.mode !== 'live' || !confirmedRuns.has(run.id)) continue;
        const campaign = state.campaigns.find((item) => item.id === run.campaignId);
        if (campaign) campaignsMinted.set(`${campaign.chainId}:${campaign.contract.toLowerCase()}`, { chainId: campaign.chainId, contract: campaign.contract.toLowerCase() });
      }
      if (campaignsMinted.size === 0) return 'MintBot has not minted anything yet, so there is nothing to show. (This lists NFTs from MintBot\'s own mints; a full portfolio needs an outside data service, which is not set up.)';
      const wallets = (await deps.walletList()).slice(0, 12);
      const lines = ['NFTs your wallets hold from MintBot mints:'];
      if (campaignsMinted.size > 6) lines.push(`(showing the first 6 of ${campaignsMinted.size} contracts)`);
      if (wallets.length > 10) lines.push(`(showing the first 10 of ${wallets.length} wallets)`);
      const balance = deps.nftBalance ?? (async (chainId: number, contract: string, wallet: string) => (await client(chainId as ChainId)).readContract({ address: contract as Address, abi: ERC721_BALANCE_ABI, functionName: 'balanceOf', args: [wallet as Address] }));
      const nameOf = deps.nftName ?? (async (chainId: number, contract: string) => (await client(chainId as ChainId)).readContract({ address: contract as Address, abi: ERC721_NAME_ABI, functionName: 'name' }).catch(() => undefined));
      // Each read has its own short time limit and the wallets of one contract are read together, so a slow provider cannot hold the reply.
      const within = <T,>(work: Promise<T>): Promise<T> => Promise.race([work, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('TIMED_OUT')), 8_000); timer.unref?.(); })]);
      for (const item of [...campaignsMinted.values()].slice(0, 6)) {
        const reads = await Promise.all(wallets.slice(0, 10).map(async (wallet) => { try { return { wallet, count: await within(balance(item.chainId, item.contract, wallet)) }; } catch { return { wallet, count: undefined }; } }));
        const held = reads.flatMap((read) => read.count === undefined ? [`${short(read.wallet)} unreadable`] : read.count > 0n ? [`${short(read.wallet)} ${read.count}`] : []);
        const total = reads.reduce((sum, read) => sum + (read.count ?? 0n), 0n);
        const name = cleanName(await within(nameOf(item.chainId, item.contract)).catch(() => undefined));
        lines.push(`• ${chainName(item.chainId)} ${name ? `${name} ` : ''}${short(item.contract)}: ${total} NFT(s)${held.length > 0 ? ` — ${held.join(', ')}` : ''}`);
      }
      return lines.join('\n');
    },
    async gasAlerts() {
      const alerts = deps.gasAlerts().active();
      return alerts.length === 0 ? 'No fee alerts. Add one: /gasalert <chain> <below|above> <gwei>' : ['Your fee alerts:', ...alerts.map((alert) => `• ${gasAlertSentence(alert)} — id ${alert.id.slice(-6)}`), '', 'Remove one: /gasalert remove <id>'].join('\n');
    },
    async gasAlertSet(chainText, direction, gwei) {
      const chainId = chainFrom(chainText);
      const way = direction.toLowerCase();
      if (way !== 'below' && way !== 'above') throw new Error('DIRECTION_INVALID: use below or above');
      if (!Number.isFinite(gwei) || gwei < 0.0001 || gwei > 100_000) throw new Error('GWEI_OUT_OF_RANGE: use a number from 0.0001 to 100000');
      // A plain decimal with at most 4 places (never 1e-7 or a long tail), which the database accepts.
      const threshold = String(Number(gwei.toFixed(4)));
      if (deps.gasAlerts().active().length >= 20) throw new Error('TOO_MANY_ALERTS: you have 20 fee alerts; remove one with /gasalert remove <id> first');
      const row = deps.gasAlerts().add(chainId, way, threshold);
      return `Fee alert set: ${gasAlertSentence(row)} (id ${row.id.slice(-6)}). I will message you when it crosses.`;
    },
    async gasAlertRemove(id) {
      return deps.gasAlerts().remove(id.trim()) ? 'Fee alert removed.' : 'No single alert matches that id. See /gasalerts.';
    },
  };
  return actions;
}
