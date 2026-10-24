/**
 * T-069: replies are sent in Telegram's HTML mode so the values the owner copies are one tap away. Everything is escaped first, so text from
 * outside (a collection name, a provider note, an owner broadcast) can never add markup. Only these are wrapped in <code>:
 *  - a whole line that starts with a command (`/prepare …`, `/confirm …`, `/fire …`), unless it is a help line (`/cmd — what it does`);
 *  - ids (campaign, run, request, schedule, approval) and 0x addresses or hashes.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TOKEN = /(0x[0-9a-fA-F]{40,64}|\b(?:cmp|run|live_request|fire_schedule|approval|intent)_[0-9A-Za-z-]{6,})/g;
const COMMAND_LINE = /^\/[a-z][a-z0-9_]{1,31}(?: .*)?$/;

export function toCopyableHtml(text: string): string {
  return text.split('\n').map((line) => {
    const trimmed = line.trimEnd();
    if (COMMAND_LINE.test(trimmed) && !trimmed.includes(' — ')) return `<code>${escapeHtml(trimmed)}</code>`;
    return escapeHtml(line).replace(TOKEN, '<code>$1</code>');
  }).join('\n');
}
