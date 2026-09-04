/**
 * The one-way channel from the services to whatever is watching.
 *
 * The services never import Electron, so they cannot call `webContents.send`
 * themselves. They publish here instead; the Electron layer subscribes and
 * forwards. In tests nothing subscribes, or a test does, and the services
 * behave identically either way.
 */

import type { EventMap } from '../shared/ipc-contract.js';

export type EventListener = <K extends keyof EventMap>(channel: K, payload: EventMap[K]) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
    for (const listener of this.listeners) {
      try {
        listener(channel, payload);
      } catch {
        // A dead window must never break a run in progress.
      }
    }
  }
}
