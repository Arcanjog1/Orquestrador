/**
 * Runtime validation of everything the renderer sends.
 *
 * TypeScript describes the contract; it does not enforce it. A renderer
 * process can be compromised, and `ipcRenderer.invoke` accepts any structured
 * clone, so every payload is re-checked here before a handler sees it. These
 * functions are pure and have no Electron dependency, which is why they are
 * covered by the ordinary test suite.
 */

import type { RuntimeId } from '../../../../src/runtime/types.js';
import type { ProviderId } from '../../../../src/accounts/account-types.js';
import { INVOKE_CHANNELS, type InvokeChannel } from './ipc-contract.js';

export class ValidationError extends Error {
  constructor(
    readonly userMessage: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ValidationError';
  }
}

const RUNTIME_IDS: readonly RuntimeId[] = ['codex', 'claude-code', 'git'];
const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'google'];

/**
 * Account ids name a directory under `profiles/`, so the character set is
 * closed rather than merely sanitised: no separators, no dots, no traversal,
 * nothing a filesystem could reinterpret.
 */
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

const MAX_DISPLAY_NAME = 64;

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && (INVOKE_CHANNELS as readonly string[]).includes(value);
}

function record(payload: unknown, channel: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ValidationError(
      'Não foi possível concluir esta ação.',
      `${channel}: expected an object payload, got ${payload === null ? 'null' : typeof payload}`,
    );
  }
  return payload as Record<string, unknown>;
}

/** Channels that take no argument must be called with none. */
export function expectNoPayload(payload: unknown, channel: string): void {
  if (payload !== undefined && payload !== null) {
    throw new ValidationError(
      'Não foi possível concluir esta ação.',
      `${channel}: expected no payload`,
    );
  }
}

export function parseRuntimeId(payload: unknown, channel: string): { runtimeId: RuntimeId } {
  const value = record(payload, channel).runtimeId;
  if (typeof value !== 'string' || !(RUNTIME_IDS as readonly string[]).includes(value)) {
    throw new ValidationError(
      'Este componente não é reconhecido pelo aplicativo.',
      `${channel}: runtimeId must be one of ${RUNTIME_IDS.join(', ')}`,
    );
  }
  return { runtimeId: value as RuntimeId };
}

export function parseAccountId(payload: unknown, channel: string): { accountId: string } {
  const value = record(payload, channel).accountId;
  if (typeof value !== 'string' || !ACCOUNT_ID.test(value)) {
    throw new ValidationError(
      'Esta conta não é reconhecida pelo aplicativo.',
      `${channel}: accountId must match ${ACCOUNT_ID.source}`,
    );
  }
  return { accountId: value };
}

export function parseCreateAccount(
  payload: unknown,
  channel: string,
): { providerId: ProviderId; displayName: string } {
  const body = record(payload, channel);
  const providerId = body.providerId;
  if (typeof providerId !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(providerId)) {
    throw new ValidationError(
      'Este provedor não é reconhecido pelo aplicativo.',
      `${channel}: providerId must be one of ${PROVIDER_IDS.join(', ')}`,
    );
  }

  const raw = body.displayName;
  if (typeof raw !== 'string') {
    throw new ValidationError(
      'Dê um nome para esta conta.',
      `${channel}: displayName must be a string`,
    );
  }
  const displayName = raw.trim();
  if (displayName.length === 0) {
    throw new ValidationError('Dê um nome para esta conta.', `${channel}: displayName is empty`);
  }
  if (displayName.length > MAX_DISPLAY_NAME) {
    throw new ValidationError(
      `Use no máximo ${MAX_DISPLAY_NAME} caracteres.`,
      `${channel}: displayName exceeds ${MAX_DISPLAY_NAME} characters`,
    );
  }
  // Control characters would corrupt the log files and the interface alike.
  if (CONTROL_CHARACTERS.test(displayName)) {
    throw new ValidationError(
      'Use apenas texto no nome da conta.',
      `${channel}: displayName contains control characters`,
    );
  }

  return { providerId: providerId as ProviderId, displayName };
}

/**
 * Derives the directory-safe id for a new account from what the user typed.
 *
 * The user types "Claude Trabalho"; the application owns everything after
 * that. A name that produces nothing usable falls back to a generated id
 * rather than to anything the user supplied, so the id can never be steered
 * into a path the profiles folder does not own.
 */
export function deriveAccountId(displayName: string, existing: readonly string[] = []): string {
  const base =
    displayName
      .normalize('NFD')
      .replace(COMBINING_MARKS, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'conta';

  let candidate = base;
  let suffix = 2;
  const taken = new Set(existing);
  while (taken.has(candidate)) {
    const room = 48 - String(suffix).length - 1;
    candidate = `${base.slice(0, room)}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}
