import type { ReadOnlySnapshot } from './contracts.js';
import { renderApp } from './main.js';
import { WEB_STYLES } from './styles.js';

/**
 * Server-rendered dashboard document (T-004, P2-07). Read-only: the page has no
 * scripts and no forms, so it cannot trigger any mutation. It refreshes itself
 * every 60 seconds; the Backend projection remains the only source of truth.
 */
export function renderDocument(snapshot: ReadOnlySnapshot, title = 'MintBot dashboard'): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60"><title>${title.replace(/[<>&"]/g, '')}</title><style>${WEB_STYLES}</style></head><body><main id="main-content">${renderApp(snapshot)}</main></body></html>`;
}
