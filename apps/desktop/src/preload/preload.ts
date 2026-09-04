/**
 * Preload: the only code that runs with a foot in both worlds.
 *
 * It exposes a fixed, named API and nothing else. In particular it never
 * exposes `ipcRenderer` itself, never a function that takes a channel name,
 * and never anything from `node:*`. The renderer therefore cannot reach
 * child_process, the filesystem, SQLite, the RuntimeManager, the
 * ProcessManager, Codex, Claude or Git except through the operations named in
 * the contract.
 *
 * Bundled to CommonJS on purpose: a sandboxed preload (`sandbox: true`) is not
 * loaded as an ES module.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { buildApi, type BridgeTransport } from './bridge.js';

const transport: BridgeTransport = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('api', buildApi(transport));
