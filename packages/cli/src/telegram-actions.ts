import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createPublicClient, formatEther, formatGwei, http as httpTransport, type Address } from 'viem';
import { DEFAULT_IDLE_BALANCE_CEILINGS, Phase2ReadModelService, formatEth, validBaseEnablement, validRobinhoodEnablement, type BackendApplication, type BackendStore, type CanonicalStoreBridge, type ExecutionCoordinator } from '@mint-bot/backend';
import { failoverTransport, resolveChainConfigFromSecrets } from '@mint-bot/engine';
import type { IntelligenceRepository } from '@mint-bot/database';
import type { TelegramActions, TelegramRole } from './telegram-commands.js';
import { EngineIntelligencePort } from './intelligence-adapter.js';
import { checkDrop } from './drop-check.js';
import { dryRunDrop } from './robinhood-readonly.js';
import { asKillStore, killReleaseAction, livePlanAction, livePrepareAction, recordSimulationAction, watchAcceptAction, type PrepareStore } from './owner-actions.js';
import { previewLiveRequest, runLiveRequest } from './live-request.js';
import { ROBINHOOD_DEFAULT_TIP_GWEI, buildRobinhoodPlan, recordRobinhoodSimulationsAction, robinhoodConfirmationPhrase, robinhoodPrepareAction } from './robinhood-live.js';
import { describeLiveRunResult } from './live-run.js';
import { planCampaignFunding, renderFundingPlan } from './fleet-funding-cli.js';
import { runRobinhoodEnable, type EnableStore } from './robinhood-enable.js';
import { runBaseEnable, type BaseEnableStore } from './base-enable.js';
import { engageKillSwitchFile } from './compensating-controls-cli.js';
import { backupFacts, codeVersion } from './host-facts.js';

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
    if (id === 4663) throw new Error('CHAIN_PATH_INVALID: Robinhood is handled by its own planning path');
    return id;
  };
  const walletsFor = async (text: string): Promise<string[]> => text.toLowerCase() === 'all' ? deps.walletList() : text.split(',').map((item) => item.trim()).filter(Boolean);

  return {
    async status(role: TelegramRole) {
      const state = deps.store.snapshot();
      const uptimeHours = ((now().getTime() - deps.startedAt.getTime()) / 3_600_000).toFixed(1);
      const version = await codeVersion(deps.projectRoot).catch(() => 'unknown');
      if (role === 'viewer') return `MintBot is running (version ${version.slice(0, 12)}, up ${uptimeHours} h).`;
      const killed = existsSync(deps.killSwitchPath) || state.killed;
      const pending = bridge.recentLiveRunRequests ? bridge.recentLiveRunRequests(20).filter((item) => !item.outcome).length : 0;
      return [
        `Mode: ${deps.mode === 'host' ? 'LIVE (host)' : 'practice (dry-run)'}`,
        `Kill switch: ${killed ? 'ON (nothing can be spent)' : 'off'}`,
        `Service: ${state.runtime.startupState}${state.runtime.blockingReasons.length > 0 ? ` — ${state.runtime.blockingReasons.join(', ')}` : ''}`,
        `Live requests waiting: ${pending}`,
        `Version ${version.slice(0, 12)}, up ${uptimeHours} h`,
      ].join('\n');
    },
    async health() {
      const response = await deps.application.command<{ state?: string; ready?: boolean; reasons?: string[] }>('health');
      const data = response.data ?? {};
      return `Health: ${data.ready ? 'ready' : 'not ready'} (${data.state ?? response.state})${data.reasons && data.reasons.length > 0 ? `\nBlocking: ${data.reasons.join(', ')}` : ''}`;
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
      const lines: string[] = [];
      const healthy = deps.watcherHealthy();
      lines.push(`Watcher: ${healthy === undefined ? 'not running' : healthy ? 'healthy' : 'NOT healthy'}`);
      for (const chain of CHAINS) {
        const addresses = deps.watchedWallets(chain.id);
        if (addresses.length === 0) continue;
        const reader = await client(chain.id).catch(() => undefined);
        lines.push(`${chain.name}:`);
        for (const address of addresses) {
          const balance = reader ? await reader.getBalance({ address: address as Address }).then((wei) => `${formatEther(wei)} ETH`).catch(() => 'unavailable') : 'unavailable';
          lines.push(`  ${short(address)}  ${balance}`);
        }
      }
      return lines.length > 1 ? lines.join('\n') : `${lines[0]}\nNo wallets are listed for the watcher.`;
    },
    async funding(campaignId) {
      if (!campaignId) {
        const live = deps.store.snapshot().campaigns.filter((item) => !item.dryRun).slice(-5);
        return live.length === 0 ? 'No live campaign is recorded. Prepare one with /plan and /prepare.' : ['Add a campaign id: /funding <id>', ...live.map((item) => `• ${item.id} (${chainName(item.chainId)} ${short(item.contract)})`)].join('\n');
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
      return [
        'Ethereum: on (no record needed)',
        `Base: ${base ? `ON since ${minutes(base.approvedAt)} UTC, ${base.paidAllowed ? 'free and paid' : 'free only'}, until revoked` : 'off'}`,
        `Robinhood: ${robinhood ? `ON since ${minutes(robinhood.approvedAt)} UTC, ${robinhood.paidAllowed ? 'free and paid' : 'free only'}, until revoked` : 'off'}`,
        'Recording an enablement is done on the host; /revoke switches one off.',
      ].join('\n');
    },
    async drops() {
      const items = new Phase2ReadModelService(now).opportunities(deps.store.snapshot()).data ?? [];
      const top = [...items].sort((left, right) => (right.score.value ?? -1) - (left.score.value ?? -1)).slice(0, 8);
      if (top.length === 0) return 'No opportunities found yet.';
      return ['Top opportunities:', ...top.map((item) => `• ${item.project.name ?? 'Unnamed'} ${item.project.contract ? short(item.project.contract) : ''} — ${item.chain.name}, score ${item.score.value ?? '?'}${item.price?.amount ? `, ${formatEth(BigInt(item.price.amount.value))} ETH` : ''}${item.openingAt ? `, opens ${minutes(item.openingAt)} UTC` : ''}${item.project.contract ? `\n  ${item.project.contract}` : ''}`)].join('\n');
    },
    async calendar() {
      const entries = new Phase2ReadModelService(now).calendar(deps.store.snapshot()).data ?? [];
      const upcoming = [...entries].filter((entry) => entry.openingAt).sort((left, right) => (left.openingAt ?? '').localeCompare(right.openingAt ?? '')).slice(0, 10);
      if (upcoming.length === 0) return 'Nothing on the calendar yet.';
      return ['Mint calendar (UTC):', ...upcoming.map((entry) => `• ${minutes(entry.openingAt!)} — ${entry.project.name ?? 'Unnamed'} on ${entry.chain.name}, ${entry.price.amount ? `${formatEth(BigInt(entry.price.amount.value))} ETH` : 'price unknown'}, ${entry.publicStatus}${entry.project.contract ? `\n  ${entry.project.contract}` : ''}`)].join('\n');
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
    async plan(chainText, contract, quantityLimit) {
      if (!ADDRESS.test(contract)) throw new Error('CONTRACT_ADDRESS_INVALID');
      if (chainFrom(chainText) === 4663) {
        // T-063: Robinhood has no fee planner; the quantity is the one the Turnkey policy pins (default 1).
        const candidates = await deps.walletList();
        const quantity = quantityLimit ?? 1;
        const robinhoodPlan = buildRobinhoodPlan(await dryRunDrop((await client(4663)) as never, contract, candidates, { quantity, now: now() }), { candidates, killSwitchPresent: existsSync(deps.killSwitchPath), quantity });
        return [
          robinhoodPlan.summary,
          ...(robinhoodPlan.opensAt ? [`Opens ${minutes(robinhoodPlan.opensAt)} UTC${robinhoodPlan.closesAt ? `, closes ${minutes(robinhoodPlan.closesAt)} UTC` : ''}.`] : []),
          ...robinhoodPlan.blockers.map((blocker) => `✗ ${blocker}`),
          ...robinhoodPlan.walletsNotReady.map((item) => `✗ ${short(item.wallet)}: ${item.why}`),
          ...robinhoodPlan.warnings.map((warning) => `• ${warning}`),
          ...(robinhoodPlan.verdict === 'ready' ? ['', 'To record the campaign (spends nothing):', `/prepare robinhood ${contract} ${quantity} ${robinhoodConfirmationPhrase(contract, quantity, robinhoodPlan.walletsReady.length, robinhoodPlan.totalMaxExposureEth)}`] : []),
        ].join('\n');
      }
      const chainId = evmChain(chainText);
      const planned = await livePlanAction({ chainId, contract, wallets: await deps.walletList(), ...(quantityLimit === undefined ? {} : { quantityLimit }), port: await port(chainId), killFile: deps.killSwitchPath, custody: deps.custody });
      const { plan } = planned;
      return [
        plan.summary,
        ...plan.blockers.map((blocker) => `✗ ${blocker}`),
        ...plan.warnings.map((warning) => `• ${warning}`),
        ...(planned.phrase ? ['', `Planning fee: ${planned.planningMaxFeeGwei ?? '?'} gwei. To record the campaign (spends nothing):`, `/prepare ${chainText.toLowerCase()} ${contract} ${quantityLimit ?? plan.quantity} ${planned.phrase}`] : []),
      ].join('\n');
    },
    async requestPreview(campaignId, walletsText, maxFeeGwei) {
      const preview = previewLiveRequest(deps.store.snapshot(), campaignId, await walletsFor(walletsText), maxFeeGwei, now());
      return { wallets: preview.wallets, text: `The service will arm and run ${chainName(preview.chainId)} ${short(preview.contract)}: ${preview.quantityPerWallet} NFT(s) per wallet at ${preview.priceEth} ETH, from ${preview.wallets.length} wallet(s). The most that can be spent is ${preview.maxExposureEth} ETH, signing at no more than ${preview.maxFeeGwei} gwei. Every guard still applies.`, phrase: preview.phrase };
    },
    async requestCreate(campaignId, walletsText, maxFeeGwei, phrase) {
      if (deps.mode !== 'host') throw new Error('LIVE_MODE_REQUIRED: the service is in practice mode, so nothing would run this request');
      const result = await runLiveRequest({ action: 'create', campaignId, wallets: await walletsFor(walletsText), maxFeeGwei, confirm: phrase, now: now(), store: deps.store as never, approve: (validated) => deps.application.command('approve', { validated }) });
      return `Request ${String(result.requestId)} sent. The service starts it within a few seconds; follow it with /requests and /runs. /kill stops everything.`;
    },
    async requests() {
      const rows = bridge.recentLiveRunRequests ? bridge.recentLiveRunRequests(10) : [];
      if (rows.length === 0) return 'No live requests yet.';
      return ['Live requests (newest first):', ...rows.map((row) => `• ${row.id} — ${row.outcome ?? (Date.parse(row.expiresAt) <= now().getTime() ? 'expired (not claimed)' : 'waiting')} — ${row.wallets.length} wallet(s), ≤${row.maxFeeGwei} gwei, ${minutes(row.requestedAt)} UTC`)].join('\n');
    },
    async runs() {
      const runs = [...deps.store.snapshot().runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 10);
      if (runs.length === 0) return 'No runs yet.';
      return ['Recent runs (newest first):', ...runs.map((run) => `• ${run.id} — ${run.mode}, ${run.state}, ${minutes(run.createdAt)} UTC`), '', 'Details: /run <id>'].join('\n');
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
      if (!ADDRESS.test(contract)) throw new Error('CONTRACT_ADDRESS_INVALID');
      if (chainFrom(chainText) === 4663) {
        const candidates = await deps.walletList();
        const robinhoodPlan = buildRobinhoodPlan(await dryRunDrop((await client(4663)) as never, contract, candidates, { quantity: quantityLimit, now: now() }), { candidates, killSwitchPresent: existsSync(deps.killSwitchPath), quantity: quantityLimit });
        const prepared = await robinhoodPrepareAction({ contract, priorityFeeGwei: ROBINHOOD_DEFAULT_TIP_GWEI, confirm: phrase, plan: robinhoodPlan, killFile: deps.killSwitchPath, store: deps.store as never, createCampaign: (input) => deps.application.createCampaign(input), now: now() });
        return [`Campaign recorded: ${prepared.campaign.id}`, `Sized for ${prepared.walletsSized} wallet(s), ${prepared.quantity} NFT(s) each, the most it can spend is ${prepared.maxExposureEth} ETH. Nothing was sent.`, '', 'When the mint is open:', `/simulate ${prepared.campaign.id}`, 'Then it prints the exact /request line to use (keep the fee ceiling at or below your Turnkey policy limit).'].join('\n');
      }
      const chainId = evmChain(chainText);
      const wallets = await deps.walletList();
      const planned = await livePlanAction({ chainId, contract, wallets, quantityLimit, port: await port(chainId), killFile: deps.killSwitchPath, custody: deps.custody });
      // The tip is the one the stored Ethereum fee policy uses (live-prepare refuses any other); Base uses the host default.
      const policy = chainId === 1 ? (deps.store as unknown as PrepareStore).ethereumFeePolicyStatus?.() : undefined;
      const tipWei = policy?.stored?.tipWei ?? policy?.approved?.tipWei;
      const priorityFeeGwei = tipWei === undefined ? 0.1 : Number(formatGwei(BigInt(tipWei)));
      const prepared = await livePrepareAction({ chainId, contract, priorityFeeGwei, confirm: phrase, planned, killFile: deps.killSwitchPath, walletFileAddresses: wallets, store: deps.store as unknown as PrepareStore, createCampaign: (input) => deps.application.createCampaign(input), newId: () => `evt_${randomBytes(8).toString('hex')}`, now: now() });
      return [`Campaign recorded: ${prepared.campaign.id}`, `${prepared.wallets.length} wallet(s), ${prepared.quantity} NFT(s) each, most it can spend ${prepared.maxExposureEth} ETH. Nothing was sent.`, '', 'Next, close to the mint:', `/simulate ${prepared.campaign.id}`, `/request ${prepared.campaign.id} all ${prepared.planningMaxFeeGwei ?? '<max gwei>'}`].join('\n');
    },
    async simulate(campaignId) {
      const target = campaign(campaignId);
      if (target.chainId === 4663) {
        const robinhood = await client(4663);
        const report = await dryRunDrop(robinhood as never, target.contract, await deps.walletList(), { quantity: target.quantity, now: now() });
        const recorded = await recordRobinhoodSimulationsAction({ store: deps.store, campaign: target, report, latestBlock: async () => { const block = await robinhood.getBlock({ blockTag: 'latest' }); return { number: block.number, hash: block.hash }; } });
        return [
          `${recorded.recorded.length} wallet(s) passed the test mint. The records are good for 30 minutes.`,
          ...recorded.skipped.map((item) => `✗ ${short(item.wallet)}: ${item.why}`),
          '',
          'Send the request with (fee ceiling at or below your Turnkey policy limit, for example 0.2):',
          `/request ${target.id} ${recorded.recorded.join(',')} 0.2`,
        ].join('\n');
      }
      const reader = await client(target.chainId);
      const ids = await recordSimulationAction({ store: deps.store, campaign: target, wallets: await deps.walletList(), port: await port(target.chainId), latestBlock: async () => { const block = await reader.getBlock({ blockTag: 'latest' }); return { number: block.number, hash: block.hash }; } });
      return `${ids.length} wallet(s) passed the test mint. The records are good for 30 minutes: send /request soon.`;
    },
    async cancel(requestId) {
      if (!bridge.claimLiveRunRequest) throw new Error('CANONICAL_STORE_REQUIRED');
      return bridge.claimLiveRunRequest(requestId, 'cancelled') ? `Request ${requestId} cancelled; the service will not start it.` : 'Not cancelled: that request is unknown, or the service already started, expired or cancelled it. See /requests.';
    },
    async kill() {
      // Both are attempted on their own, as the watcher does: the kill file and the coordinator. One is enough to stop new work.
      const outcomes = await Promise.allSettled([engageKillSwitchFile(deps.killSwitchPath, 'owner Telegram /kill'), deps.coordinator.kill('owner Telegram /kill')]);
      if (outcomes.every((outcome) => outcome.status === 'rejected')) throw new Error('KILL_SWITCH_NOT_ENGAGED');
      return 'The kill switch is ON. Nothing new can be spent. Release it with /unlock then /release when you are ready.';
    },
    async revoke(chainText, phrase) {
      const chainId = chainFrom(chainText);
      if (chainId === 1) throw new Error('NOTHING_TO_REVOKE: Ethereum has no enablement record');
      const newId = () => `${chainId === 4663 ? 'rh' : 'base'}_revoke_${randomBytes(8).toString('hex')}`;
      const result = chainId === 4663
        ? runRobinhoodEnable({ action: 'revoke', confirm: phrase, now: now(), store: deps.store as unknown as EnableStore, newId })
        : runBaseEnable({ action: 'revoke', ...(phrase !== undefined ? { confirm: phrase } : {}), now: now(), store: deps.store as unknown as BaseEnableStore, newId });
      if (result.state === 'ConfirmToRevoke') {
        const copy = /--confirm "(.+)"$/.exec(String(result.copyThisToRevoke ?? ''))?.[1];
        return `${String(result.message)}\n\nTo switch ${chainName(chainId)} off, send:\n/revoke ${chainId === 4663 ? 'robinhood' : 'base'} ${copy ?? ''}`;
      }
      return String(result.message);
    },
    async release(phrase) {
      const outcome = await killReleaseAction({ store: asKillStore(deps.store), killFile: deps.killSwitchPath, confirm: phrase, actor: 'owner-telegram' });
      if (outcome.state === 'On') return `${outcome.message}${outcome.phrase ? `\n\nTo release it, send:\n/release ${outcome.phrase}` : ''}`;
      return outcome.state === 'Released' ? `${outcome.message} The service accepts live work again within a few seconds if nothing else blocks it. /kill stops everything at any time.` : outcome.message;
    },
    async watchAccept(chainText, address, phrase) {
      const chainId = chainFrom(chainText);
      const outcome = await watchAcceptAction({ chainId, address, confirm: phrase, client: await client(chainId) as never, store: deps.store, newId: () => `evt_${randomBytes(8).toString('hex')}`, now: now() });
      return outcome.state === 'Preview' ? `${outcome.message}\n\nTo accept, send:\n/watchaccept ${chainText.toLowerCase()} ${address} ${outcome.phrase}` : outcome.message;
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
  };
}
