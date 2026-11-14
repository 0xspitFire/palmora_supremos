import { READ_MODEL_CONTRACT_STATUS } from './contracts.js';
import type { ReadOnlySnapshot } from './contracts.js';
import { renderUnavailableSurface, safeText } from './format.js';
import { WEB_STYLES } from './styles.js';
import { renderAlerts, renderAnalytics, renderCalendar, renderHealth, renderHome, renderReadiness, renderRun } from './surfaces.js';

export function renderApp(snapshot: ReadOnlySnapshot): string {
  const sections: string[] = [snapshot.home ? renderHome(snapshot.home) : renderUnavailableSurface('Intelligence home')];
  const page = snapshot.pagination?.availability !== 'unavailable' ? snapshot.pagination?.data : undefined;
  if (page) {
    const link = (target: number): string => {
      const query = new URLSearchParams({ page: target.toString() });
      if (page.readinessId) query.set('readiness', page.readinessId);
      return safeText(`/?${query}`);
    };
    sections.unshift(`<section class="card" aria-label="Dashboard pages"><p>Page ${page.page} of ${page.pages}. Showing up to ${page.pageSize} items per list, newest observations first. Totals: ${page.totals.opportunities} opportunities, ${page.totals.calendar} calendar entries, ${page.totals.alerts} reminders. Each page refreshes the current data.</p><nav aria-label="Dashboard pagination">${page.page > 1 ? `<a href="${link(page.page - 1)}" rel="prev">Previous page</a> ` : ''}${page.page < page.pages ? `<a href="${link(page.page + 1)}" rel="next">Next page</a>` : ''}</nav></section>`);
  }
  const navigation: Array<[string, string]> = [['home', 'Home']];

  if (snapshot.readiness) {
    sections.push(renderReadiness(snapshot.readiness));
    navigation.push(['readiness', 'Readiness']);
  }
  if (snapshot.calendar) {
    sections.push(renderCalendar(snapshot.calendar));
    navigation.push(['calendar', 'Calendar']);
  }
  if (snapshot.alerts) {
    sections.push(renderAlerts(snapshot.alerts));
    navigation.push(['alerts', 'Reminders']);
  }
  if (snapshot.health) {
    sections.push(renderHealth(snapshot.health));
    navigation.push(['health', 'System status']);
  }
  if (snapshot.analytics) {
    sections.push(renderAnalytics(snapshot.analytics));
    navigation.push(['analytics', 'Accounting']);
  }
  if (snapshot.run) {
    sections.push(renderRun(snapshot.run));
    navigation.push(['run', 'Run status']);
  }

  return `<div class="app-shell" data-read-only="true" data-contract="mintbot.read-model/v1" data-contract-status="${READ_MODEL_CONTRACT_STATUS}"><a class="skip-link" href="#main-content">Skip to content</a><header class="app-header"><p class="brand">MintBot</p><span class="read-only-mark">Intelligence projection; read-only</span><nav class="app-nav" aria-label="Primary navigation">${navigation.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</nav></header><main id="main-content" class="app-main">${sections.join('')}</main></div>`;
}

export function mountReadOnlyApp(root: HTMLElement, snapshot: ReadOnlySnapshot): void {
  root.replaceChildren();
  const style = document.createElement('style');
  style.textContent = WEB_STYLES;
  root.append(style);
  const app = document.createElement('div');
  app.innerHTML = renderApp(snapshot);
  root.append(...Array.from(app.childNodes));
}

export { READ_MODEL_CONTRACT, READ_MODEL_CONTRACT_STATUS, READ_MODEL_VERSION } from './contracts.js';
export * from './contracts.js';
export * from './format.js';
export * from './read-model-client.js';
export * from './styles.js';
export * from './surfaces.js';
