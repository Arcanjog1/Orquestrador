/**
 * The renderer's only door to the application.
 *
 * Everything the interface knows comes through `window.orchestrator`, which the
 * preload bridge installed. There is no other data source in the renderer: no
 * fetch, no Node, no second copy of any fact the main process already holds.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EventChannels,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  OrchestratorBridge,
} from "@shared/ipc-contract";

declare global {
  interface Window {
    orchestrator?: OrchestratorBridge;
  }
}

export class BridgeUnavailableError extends Error {
  constructor() {
    super("A ponte com o aplicativo não está disponível.");
    this.name = "BridgeUnavailableError";
  }
}

export function bridgeAvailable(): boolean {
  return typeof window !== "undefined" && window.orchestrator !== undefined;
}

export function invoke<C extends InvokeChannel>(
  channel: C,
  request: InvokeRequest<C>,
): Promise<InvokeResponse<C>> {
  const bridge = window.orchestrator;
  if (!bridge) return Promise.reject(new BridgeUnavailableError());
  return bridge.invoke(channel, request);
}

export function subscribe<C extends keyof EventChannels>(
  channel: C,
  listener: (payload: EventChannels[C]) => void,
): () => void {
  const bridge = window.orchestrator;
  if (!bridge) return () => {};
  return bridge.on(channel, listener);
}

export type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  /** A message ready to show. Never a stack trace. */
  error: string | null;
};

/**
 * Reads one channel and keeps it fresh.
 *
 * `deps` re-runs the query when the argument changes; `refreshOn` re-runs it
 * when main pushes one of those events, so the interface follows the real state
 * instead of polling it.
 */
export function useChannel<C extends InvokeChannel>(
  channel: C,
  request: InvokeRequest<C>,
  options: { enabled?: boolean; refreshOn?: (keyof EventChannels)[] } = {},
): AsyncState<InvokeResponse<C>> & { reload: () => void } {
  const { enabled = true, refreshOn = [] } = options;
  const [state, setState] = useState<AsyncState<InvokeResponse<C>>>({
    data: null,
    loading: enabled,
    error: null,
  });

  // Serialised so a fresh object literal on every render does not re-fire.
  const key = JSON.stringify(request ?? null);
  const events = refreshOn.join(",");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(() => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true }));
    invoke(channel, JSON.parse(key) as InvokeRequest<C>)
      .then((data) => {
        if (alive.current) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!alive.current) return;
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error.message : "Não foi possível carregar.",
        });
      });
  }, [channel, key, enabled]);

  useEffect(run, [run]);

  useEffect(() => {
    if (!enabled || events.length === 0) return;
    const offs = events.split(",").map((name) => subscribe(name as keyof EventChannels, () => run()));
    return () => offs.forEach((off) => off());
  }, [events, enabled, run]);

  return { ...state, reload: run };
}
