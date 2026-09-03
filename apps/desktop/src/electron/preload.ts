/**
 * The bridge, and the whole of it.
 *
 * This is the only code that both the privileged side and the page can see,
 * so it is deliberately dull: it forwards named operations and nothing else.
 *
 * What is *not* here is the point. There is no `exec`, no `shell`, no
 * `runCommand`, no `require`, no `ipcRenderer` passed through, no path, no
 * environment variable. A renderer holding this object can ask the
 * application to diagnose its runtimes or connect an account; it cannot ask
 * the main process to run a string.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  BRIDGE_KEY,
  EVENT_CHANNELS,
  type EventChannel,
  type InstallProgressEvent,
  type InvokeChannel,
  type IpcResult,
  type LoginProgressEvent,
  type OrchestratorBridge,
} from '../shared/ipc-contract.js';

function invoke<T>(channel: InvokeChannel, payload?: unknown): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<T>>;
}

/**
 * Subscribes to one event channel and hands back an unsubscribe function.
 *
 * The Electron event object is not passed to the listener: the page receives
 * the payload only, so it can never reach `sender` and from there back into
 * the privileged side.
 */
function subscribe<T>(channel: EventChannel, listener: (payload: T) => void): () => void {
  if (!(EVENT_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`unknown event channel ${channel}`);
  }
  const wrapped = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge: OrchestratorBridge = {
  app: {
    getInfo: () => invoke('app:getInfo'),
    getBootstrapState: () => invoke('app:getBootstrapState'),
  },
  runtime: {
    diagnose: () => invoke('runtime:diagnose'),
    install: (runtimeId) => invoke('runtime:install', { runtimeId }),
    repair: (runtimeId) => invoke('runtime:repair', { runtimeId }),
    cancelInstall: (runtimeId) => invoke('runtime:cancelInstall', { runtimeId }),
    onProgress: (listener) => subscribe<InstallProgressEvent>('runtime:progress', listener),
  },
  accounts: {
    list: () => invoke('accounts:list'),
    create: (providerId, displayName) => invoke('accounts:create', { providerId, displayName }),
    remove: (accountId) => invoke('accounts:remove', { accountId }),
    status: (accountId) => invoke('accounts:status', { accountId }),
    connect: (accountId) => invoke('accounts:connect', { accountId }),
    cancelConnect: (accountId) => invoke('accounts:cancelConnect', { accountId }),
    onLoginProgress: (listener) =>
      subscribe<LoginProgressEvent>('accounts:loginProgress', listener),
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
