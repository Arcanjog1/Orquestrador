/**
 * The preload bridge.
 *
 * Compiled to CommonJS (`.cts` -> `.cjs`) because a sandboxed preload has no
 * ESM loader. It imports nothing but `electron`, so no application code -
 * and therefore no Node capability - can leak into the renderer through it.
 *
 * The renderer gets two functions and a fixed channel list. It cannot name a
 * channel that is not in the contract, and it never touches `ipcRenderer`.
 */

import { contextBridge, ipcRenderer } from 'electron';

// Duplicated deliberately: a sandboxed preload cannot import the shared
// contract at runtime. The typecheck below pins these to the contract, so
// the two lists cannot drift apart without the build failing.
const INVOKE_CHANNELS = [
  'app:state',
  'app:openExternal',
  'runtime:diagnose',
  'runtime:install',
  'runtime:repair',
  'accounts:list',
  'accounts:create',
  'accounts:connect',
  'accounts:cancelConnect',
  'accounts:disconnect',
  'accounts:remove',
  'accounts:setDefault',
  'accounts:rename',
  'workspaces:list',
  'workspaces:choose',
  'workspaces:open',
  'git:context',
  'git:branches',
  'sessions:list',
  'sessions:create',
  'sessions:messages',
  'runs:list',
  'runs:detail',
  'runs:active',
  'runs:start',
  'runs:pause',
  'runs:resume',
  'runs:cancel',
  'runs:resolveHumanReview',
  'settings:all',
  'settings:set',
] as const;

const EVENT_CHANNELS = [
  'runtime:progress',
  'accounts:loginProgress',
  'app:stateChanged',
  'runs:changed',
] as const;

type InvokeName = (typeof INVOKE_CHANNELS)[number];
type EventName = (typeof EVENT_CHANNELS)[number];

const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

contextBridge.exposeInMainWorld('orchestrator', {
  invoke(channel: InvokeName, request: unknown): Promise<unknown> {
    if (!invokeAllowed.has(channel)) {
      return Promise.reject(new Error(`Canal não permitido: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, request);
  },

  on(channel: EventName, listener: (payload: unknown) => void): () => void {
    if (!eventAllowed.has(channel)) {
      throw new Error(`Canal não permitido: ${String(channel)}`);
    }
    // The IpcRendererEvent is dropped on purpose: the renderer has no use for
    // the sender, and handing it over would widen the surface for nothing.
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
});

// -- Contract check ---------------------------------------------------------
// Type-only: erased at emit. If the contract gains or loses a channel and this
// file is not updated, `npm run typecheck` fails here rather than at runtime.
import type { EventChannel, InvokeChannel } from '../shared/ipc-contract.js';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _invokeChannelsMatchContract: Exact<InvokeName, InvokeChannel> = true;
const _eventChannelsMatchContract: Exact<EventName, EventChannel> = true;
void _invokeChannelsMatchContract;
void _eventChannelsMatchContract;
