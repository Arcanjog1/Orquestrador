/**
 * The renderer's view of the bridge.
 *
 * `window.api` is whatever the preload exposed — nothing more is reachable from
 * here. Typing it against `DesktopApi` means a call the contract does not
 * describe fails to compile, and (because the preload builds its surface from
 * the same list) would fail at run time too.
 */

import type { DesktopApi } from '../preload/bridge.js';

declare global {
  interface Window {
    api: DesktopApi;
  }
}

export const api: DesktopApi = window.api;

/** Turns any bridge rejection into a sentence worth showing. */
export function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'Algo deu errado.';
}
