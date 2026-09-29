import { Phase2ReadModelService, Phase2ReadOnlyApi, type BackendStore } from '@mint-bot/backend';
import { ReadModelClient } from '@mint-bot/web';
import { renderDocument } from '@mint-bot/web/server';

/** Read-only dashboard wiring (T-004, P2-07): GET adapter plus a script-free server-rendered page. */
export function createDashboard(store: BackendStore): { readModel: Phase2ReadOnlyApi; render(url: URL): Promise<string> } {
  const readModel = new Phase2ReadOnlyApi(new Phase2ReadModelService(), store);
  const client = new ReadModelClient({ get: async (request) => readModel.handle(request).body });
  return {
    readModel,
    async render(url: URL): Promise<string> {
      const readinessId = url.searchParams.get('readiness');
      const [home, calendar, alerts, health, readiness] = await Promise.all([client.getHome(), client.getCalendar(), client.getAlerts(), client.getHealth(), readinessId ? client.getReadiness(readinessId) : Promise.resolve(undefined)]);
      return renderDocument({ home, calendar, alerts, health, ...(readiness ? { readiness } : {}) });
    },
  };
}
