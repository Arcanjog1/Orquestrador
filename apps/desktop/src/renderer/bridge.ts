/**
 * The renderer's only door to the application.
 *
 * Everything the interface can do goes through `window.orchestrator`, which
 * the preload put there. If it is missing, the page says so rather than
 * pretending: a renderer that cannot reach the main process has nothing
 * useful to show.
 */

import {
  BRIDGE_KEY,
  type IpcFailure,
  type IpcResult,
  type OrchestratorBridge,
} from '../shared/ipc-contract.js';

declare global {
  interface Window {
    [BRIDGE_KEY]?: OrchestratorBridge;
  }
}

const BRIDGE_MISSING: IpcFailure = {
  ok: false,
  code: 'INTERNAL',
  userMessage: 'O aplicativo não conseguiu iniciar corretamente.',
  remedy: 'Reiniciar o aplicativo',
};

export function bridge(): OrchestratorBridge | null {
  return window[BRIDGE_KEY] ?? null;
}

/** Runs a bridge call, turning a missing bridge into an ordinary failure. */
export async function call<T>(
  fn: (api: OrchestratorBridge) => Promise<IpcResult<T>>,
): Promise<IpcResult<T>> {
  const api = bridge();
  if (!api) return BRIDGE_MISSING;
  try {
    return await fn(api);
  } catch {
    return {
      ok: false,
      code: 'INTERNAL',
      userMessage: 'Algo deu errado. Tente novamente.',
      remedy: 'Tentar novamente',
    };
  }
}
