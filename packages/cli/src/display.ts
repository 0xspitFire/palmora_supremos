import { formatEther, parseEther } from 'viem';

/**
 * T-071: how a balance is shown in Telegram. It is cut, never rounded, so it can only understate what a wallet holds, never overstate it:
 * 0.000389503769533923 is shown as 0.000389 (three significant digits); 1.5328283283243 as 1.532 (three decimals from 1 up).
 * Display only: caps, reservations and top-up amounts keep their exact values.
 */
export function shortEth(wei: bigint): string {
  if (wei <= 0n) return '0';
  const [whole = '0', fraction = ''] = formatEther(wei).split('.');
  const keep = (digits: string): string => digits.replace(/0+$/, '');
  if (whole !== '0') { const decimals = keep(fraction.slice(0, 3)); return decimals ? `${whole}.${decimals}` : whole; }
  const firstSignificant = fraction.search(/[1-9]/);
  if (firstSignificant < 0) return '0';
  return `0.${keep(fraction.slice(0, firstSignificant + 3))}`;
}

/** Shortens a balance written in the text as "(0.00036851 ETH)" (a plan note); other amounts in the text are left exactly as written. */
export function shortenBalancesInParens(text: string): string {
  return text.replace(/\((\d+\.\d+) ETH\)/g, (match, value: string) => { try { return `(${shortEth(parseEther(value))} ETH)`; } catch { return match; } });
}

/** Joins groups of lines with one blank line between groups; an empty group is skipped. */
export function sections(...groups: ReadonlyArray<readonly string[]>): string {
  return groups.filter((group) => group.length > 0).map((group) => group.join('\n')).join('\n\n');
}
