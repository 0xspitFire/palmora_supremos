import { READ_MODEL_CONTRACT_STATUS } from './contracts.js';
import type { ReadOnlySnapshot } from './contracts.js';
import { renderUnavailableSurface } from './format.js';
import { WEB_STYLES } from './styles.js';
import { renderAlerts, renderCalendar, renderHealth, renderHome, renderReadiness, renderRun } from './surfaces.js';

export function renderApp(snapshot: ReadOnlySnapshot): string {
  const sections: string[] = [snapshot.home ? renderHome(snapshot.home) : renderUnavailableSurface('Intelligence home')];
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
export * from './styles.js';
export * from './surfaces.js';
