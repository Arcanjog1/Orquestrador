/**
 * The typed IPC router.
 *
 * One table, one entry per operation the renderer may request. There is no
 * `exec`, no `shell`, no `runCommand`: a channel names a *thing to do*, and
 * its arguments are validated here before any service is touched. Adding a
 * capability means adding a row to this table, which is exactly the review
 * point we want.
 *
 * This file has no Electron dependency on purpose - `dispatch` is an ordinary
 * async function, so the whole surface is testable in the normal suite.
 */

import { AccountError } from '../../../../../src/accounts/account-types.js';
import { DatabaseUnavailableError } from '../../../../../src/database/driver.js';
import { RuntimeError } from '../../../../../src/runtime/types.js';
import {
  INVOKE_CHANNELS,
  type InvokeChannel,
  type IpcFailure,
  type IpcResult,
} from '../../shared/ipc-contract.js';
import {
  ValidationError,
  expectNoPayload,
  parseAccountId,
  parseCreateAccount,
  parseRuntimeId,
} from '../../shared/validation.js';
import type { AppServices } from '../app-services.js';

type Handler = (services: AppServices, payload: unknown, channel: InvokeChannel) => Promise<unknown>;

/**
 * Every operation the renderer can reach, and nothing else.
 *
 * Each handler validates first and calls a service second. A channel missing
 * from this table cannot be invoked at all.
 */
export const HANDLERS: Record<InvokeChannel, Handler> = {
  'app:getInfo': async (services, payload, channel) => {
    expectNoPayload(payload, channel);
    return services.appInfo();
  },

  'app:getBootstrapState': async (services, payload, channel) => {
    expectNoPayload(payload, channel);
    return services.bootstrapState();
  },

  'runtime:diagnose': async (services, payload, channel) => {
    expectNoPayload(payload, channel);
    return services.runtime.diagnose();
  },

  'runtime:install': async (services, payload, channel) => {
    const { runtimeId } = parseRuntimeId(payload, channel);
    return services.runtime.install(runtimeId);
  },

  'runtime:repair': async (services, payload, channel) => {
    const { runtimeId } = parseRuntimeId(payload, channel);
    return services.runtime.repair(runtimeId);
  },

  'runtime:cancelInstall': async (services, payload, channel) => {
    const { runtimeId } = parseRuntimeId(payload, channel);
    return services.runtime.cancelInstall(runtimeId);
  },

  'accounts:list': async (services, payload, channel) => {
    expectNoPayload(payload, channel);
    return services.accounts.list();
  },

  'accounts:create': async (services, payload, channel) => {
    const { providerId, displayName } = parseCreateAccount(payload, channel);
    return services.accounts.create(providerId, displayName);
  },

  'accounts:remove': async (services, payload, channel) => {
    const { accountId } = parseAccountId(payload, channel);
    return services.accounts.remove(accountId);
  },

  'accounts:status': async (services, payload, channel) => {
    const { accountId } = parseAccountId(payload, channel);
    return services.accounts.status(accountId);
  },

  'accounts:connect': async (services, payload, channel) => {
    const { accountId } = parseAccountId(payload, channel);
    return services.accounts.connect(accountId);
  },

  'accounts:cancelConnect': async (services, payload, channel) => {
    const { accountId } = parseAccountId(payload, channel);
    return services.accounts.cancelConnect(accountId);
  },
};

/** Guard against a channel being added to the contract and never handled. */
export function missingHandlers(): InvokeChannel[] {
  return INVOKE_CHANNELS.filter((channel) => typeof HANDLERS[channel] !== 'function');
}

/**
 * Runs one request.
 *
 * Nothing throws across the bridge: a failure becomes an `IpcFailure` with a
 * sentence the interface can show and a stable code it can branch on. Stack
 * traces and internal detail stay in the main process log.
 */
export async function dispatch<T>(
  services: AppServices,
  channel: string,
  payload: unknown,
): Promise<IpcResult<T>> {
  const handler = (HANDLERS as Record<string, Handler | undefined>)[channel];
  if (!handler) {
    services.log(`ipc: rejected unknown channel ${JSON.stringify(channel)}`);
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      userMessage: 'Esta ação não existe neste aplicativo.',
    };
  }

  try {
    const data = (await handler(services, payload, channel as InvokeChannel)) as T;
    return { ok: true, data };
  } catch (err) {
    const failure = toFailure(err);
    services.log(`ipc: ${channel} failed: ${(err as Error).message}`);
    return failure;
  }
}

function toFailure(err: unknown): IpcFailure {
  if (err instanceof ValidationError) {
    return { ok: false, code: 'INVALID_REQUEST', userMessage: err.userMessage };
  }
  if (err instanceof RuntimeError) {
    return {
      ok: false,
      code: 'RUNTIME_ERROR',
      userMessage: err.userMessage,
      remedy: err.remedy,
    };
  }
  if (err instanceof AccountError) {
    return {
      ok: false,
      code: 'ACCOUNT_ERROR',
      userMessage: err.userMessage,
      remedy: err.remedy,
    };
  }
  if (err instanceof DatabaseUnavailableError) {
    return {
      ok: false,
      code: 'DATABASE_ERROR',
      userMessage: 'O aplicativo não conseguiu abrir seus dados.',
      remedy: 'Reiniciar o aplicativo',
    };
  }
  // Anything unrecognised is reported without its text: an unexpected error
  // message is the most likely place for a path or a command to leak.
  return {
    ok: false,
    code: 'INTERNAL',
    userMessage: 'Algo deu errado. Tente novamente.',
    remedy: 'Tentar novamente',
  };
}
