import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { sections, shortEth, shortenBalancesInParens } from './display.js';

/** T-071: balances are cut (never rounded) for reading; other amounts keep their exact values. */
describe('balance display', () => {
  it('cuts to three significant digits below 1 ETH and three decimals from 1 ETH, never rounding up', () => {
    expect(shortEth(parseEther('0.000389503769533923'))).toBe('0.000389');
    expect(shortEth(parseEther('1.5328283283243'))).toBe('1.532');
    expect(shortEth(parseEther('0.000151165366767872'))).toBe('0.000151');
    expect(shortEth(parseEther('0.000999999999999999'))).toBe('0.000999');
    expect(shortEth(parseEther('0.0004'))).toBe('0.0004');
    expect(shortEth(parseEther('0.5'))).toBe('0.5');
    expect(shortEth(parseEther('2'))).toBe('2');
    expect(shortEth(parseEther('2.5'))).toBe('2.5');
    expect(shortEth(parseEther('12.3456'))).toBe('12.345');
    expect(shortEth(0n)).toBe('0');
    expect(shortEth(1n)).toBe('0.000000000000000001');
  });

  it('shortens only a balance in parentheses, leaving every other amount exactly as written', () => {
    expect(shortenBalancesInParens('it holds too little ETH on Robinhood (0.00036851 ETH)')).toBe('it holds too little ETH on Robinhood (0.000368 ETH)');
    expect(shortenBalancesInParens('most it can spend 0.00039999 ETH in total')).toBe('most it can spend 0.00039999 ETH in total');
  });

  it('joins groups with one blank line and skips empty groups', () => {
    expect(sections(['a', 'b'], [], ['c'])).toBe('a\nb\n\nc');
    expect(sections([])).toBe('');
  });
});
