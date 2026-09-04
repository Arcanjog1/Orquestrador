/**
 * Small helpers over the bridge.
 *
 * Everything the interface knows comes through `window.api`. There is no other
 * data source in the renderer: no fetch, no Node, no second copy of any fact
 * the main process already holds.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { messageOf } from './api';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  /** A message ready to show. Never a stack trace. */
  error: string | null;
}

/** Reads once, and again whenever `reload` is called or a dependency changes. */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
  enabled = true,
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: enabled,
    error: null,
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const key = JSON.stringify(deps);
  const run = useCallback(() => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true }));
    load()
      .then((data) => {
        if (alive.current) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (alive.current) setState({ data: null, loading: false, error: messageOf(error) });
      });
    // `load` is recreated every render by design; `key` is what decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  useEffect(run, [run]);
  return { ...state, reload: run };
}
