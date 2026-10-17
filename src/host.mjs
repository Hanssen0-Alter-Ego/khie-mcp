import { KhieService } from '../core/src/service.mjs';
import { McpHandler } from '../core/src/mcp.mjs';
import { createOfflineFixture } from '../core/src/adapter.mjs';
import { createLiveFactory } from './live.mjs';

export async function createHost({ config, endpoint, runtimeLoader } = {}) {
  const live = config === undefined ? undefined : await createLiveFactory({ config, endpoint, ...(runtimeLoader ? { runtimeLoader } : {}) });
  const mode = live ? 'live-readonly' : 'offline-fixture';
  class ModeService extends KhieService {
    capabilities() { return { ...super.capabilities(), mode, walletConnectRequested: Boolean(config?.connectNetwork),
      transport: live ? 'allowlisted-wss-circuit-relay' : 'offline' }; }
  }
  const service = new ModeService(live ? { transportFactory: live.transportFactory, ...live.limits } : { transportFactory: createOfflineFixture });
  class ModeHandler extends McpHandler {
    async handle(message) {
      const response = await super.handle(message);
      if (response?.result?.serverInfo) {
        response.result.serverInfo = { name: 'khie-mcp-opt-in-adapter', version: '0.2.1-reconstruction' };
        response.result.instructions = live
          ? 'Explicit live read-only mode. Opening the single session initiates pairing to the trusted endpoint via its allowlisted relay. Metadata is read first. Account reads require a separately configured provider connect request and wallet approval. Signing and sending are unavailable.'
          : 'Offline fixture mode. No live connection is enabled. Signing and sending are unavailable.';
      }
      if (live && response?.result?.tools) response.result.tools = response.result.tools.map(tool => ({ ...tool,
        ...(tool.name === 'khie_session_open' ? { description: 'Open the one explicitly configured live read-only wallet session via its allowlisted relay; first read public metadata and optionally request the configured wallet connect approval.' } : {}),
        annotations: { ...tool.annotations, openWorldHint: ['khie_session_open', 'khie_request', 'khie_result'].includes(tool.name) },
      }));
      return response;
    }
  }
  return { service, handler: new ModeHandler(service) };
}
