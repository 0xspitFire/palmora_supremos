import type { DiscoveryHealthSnapshot } from './discovery-liveness.js';
import { Phase2ReadModelService, Phase2ReadOnlyApi, type BackendStore } from '@mint-bot/backend';
import { ReadModelClient } from '@mint-bot/web';
import { renderDocument } from '@mint-bot/web/server';

/** Read-only dashboard wiring (T-004, P2-07): GET adapter plus a script-free server-rendered page. */
export function createDashboard(store: BackendStore,options:{discovery?:()=>DiscoveryHealthSnapshot}={}): { readModel: Phase2ReadOnlyApi; render(url: URL): Promise<string> } {
  const readModel = new Phase2ReadOnlyApi(new Phase2ReadModelService(), store,options);
  const client = new ReadModelClient({ get: async (request) => readModel.handle(request).body });
  return {
    readModel,
    async render(url: URL): Promise<string> {
      const readinessId = url.searchParams.get('readiness');
      const page = url.searchParams.has('page') ? Number(url.searchParams.get('page')) : 1;
      return renderDocument(await client.getDashboard(readinessId ?? undefined, page));
    },
  };
}
