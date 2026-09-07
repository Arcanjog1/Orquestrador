/**
 * The one-way channel from the services to whatever is watching.
 *
 * The services never import Electron, so they cannot call `webContents.send`
 * themselves. They publish here instead; the Electron layer subscribes and
 * forwards. In tests nothing subscribes, or a test does, and the services
 * behave identically either way.
 */
export class EventBus {
    listeners = new Set();
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(channel, payload) {
        for (const listener of this.listeners) {
            try {
                listener(channel, payload);
            }
            catch {
                // A dead window must never break a run in progress.
            }
        }
    }
}
//# sourceMappingURL=events.js.map