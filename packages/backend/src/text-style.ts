/**
 * T-071: one style for the word(s) before a colon in the bot's messages: every word capitalised ("Live Requests Waiting:").
 * Letters after the first of a word are left as written, so an acronym such as RPC or an id stays as it is.
 */
export function titleCaseLabel(label: string): string {
  return label.trim().split(/\s+/).map((word) => (word.length === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`)).join(' ');
}
