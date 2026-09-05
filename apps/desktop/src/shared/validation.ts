/**
 * Runtime validation for everything that crosses the IPC boundary.
 *
 * TypeScript types are erased at build time: they describe what the renderer
 * *should* send, and prove nothing about what actually arrives. A compromised
 * or buggy renderer can invoke any registered channel with any value, so the
 * main process re-validates every payload here, at runtime, before a service
 * sees it.
 *
 * The validators are deliberately strict:
 *
 *  - unknown properties are **rejected**, not stripped, so a payload cannot
 *    smuggle a field past a handler that later learns to read it;
 *  - `__proto__`, `constructor` and `prototype` keys are refused outright;
 *  - every string has a maximum length, so a renderer cannot exhaust memory
 *    by sending a gigabyte of text.
 */

import type { IpcMap, RequestChannel } from './ipc-contract.js';

export class IpcValidationError extends Error {
  readonly code = 'INVALID_ARGUMENT';
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

export type Validator<T> = (value: unknown, path: string) => T;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function fail(path: string, expectation: string): never {
  throw new IpcValidationError(`${path} ${expectation}`);
}

/** Accepts nothing: the channel takes no argument. */
export const noArgs: Validator<void> = (value, path) => {
  if (value !== undefined && value !== null) fail(path, 'takes no argument');
};

export interface StringRules {
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
  /** Human-readable name used in the error message. */
  readonly what?: string;
}

export function str(rules: StringRules = {}): Validator<string> {
  const min = rules.min ?? 1;
  const max = rules.max ?? 512;
  return (value, path) => {
    if (typeof value !== 'string') fail(path, 'must be a string');
    if (value.includes('\0')) fail(path, 'must not contain a NUL byte');
    if (value.length < min) fail(path, `must be at least ${min} character(s)`);
    if (value.length > max) fail(path, `must be at most ${max} character(s)`);
    if (rules.pattern && !rules.pattern.test(value)) {
      fail(path, `must look like ${rules.what ?? String(rules.pattern)}`);
    }
    return value;
  };
}

/** Free-form user text: long, but still bounded. */
export const messageText = str({ min: 1, max: 20_000 });

/** Identifiers we generate ourselves; never a path, never a command. */
export const id = str({
  min: 1,
  max: 64,
  pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  what: 'an identifier',
});

export function oneOf<const T extends readonly string[]>(values: T): Validator<T[number]> {
  return (value, path) => {
    if (typeof value !== 'string' || !values.includes(value)) {
      fail(path, `must be one of: ${values.join(', ')}`);
    }
    return value as T[number];
  };
}

/**
 * An absolute filesystem path.
 *
 * This does not grant the renderer filesystem access: paths only ever name a
 * workspace root, and the value still has to survive whatever the service
 * does with it. It exists to reject the obvious nonsense early — relative
 * paths, NUL bytes, `file://` URLs — before a path reaches disk.
 */
export function absolutePath(max = 4096): Validator<string> {
  return (value, path) => {
    const s = str({ min: 1, max })(value, path);
    const isPosixAbsolute = s.startsWith('/');
    const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\');
    if (!isPosixAbsolute && !isWindowsAbsolute) fail(path, 'must be an absolute path');
    return s;
  };
}

/** A git remote we are willing to hand to `git clone`. */
export const repositoryUrl: Validator<string> = (value, path) => {
  const s = str({ min: 1, max: 2048 })(value, path);
  if (/\s/.test(s)) fail(path, 'must not contain whitespace');
  if (s.startsWith('-')) fail(path, 'must not start with "-"');
  const ok =
    /^https:\/\/[^\s]+$/.test(s) ||
    /^git@[^\s:]+:[^\s]+$/.test(s) ||
    /^ssh:\/\/[^\s]+$/.test(s) ||
    /^file:\/\/\/[^\s]+$/.test(s);
  if (!ok) fail(path, 'must be an https, ssh or file repository URL');
  return s;
};

/** True/false that really is a boolean, not "true" or 1. */
export const bool: Validator<boolean> = (value, path) => {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
};

/**
 * A verification command line, as a *shape*.
 *
 * This is the cheap half of the check: one line, bounded, no NUL, no control
 * characters that would not survive a round trip. The real rule is
 * `screenCommand` in the core - the same screen the Verifier applies before
 * running anything - which the service calls before saving. Neither is a
 * licence to run arbitrary text at run time: a stored command is configuration
 * a person wrote, and an agent can only name it by id.
 */
export const verificationCommand: Validator<string> = (value, path) => {
  const s = str({ min: 1, max: 1000 })(value, path);
  if (/[\r\n]/.test(s)) fail(path, 'must be a single line');
  if (/[\u0000-\u001f\u007f]/.test(s)) fail(path, 'must not contain control characters');
  if (s.trim().length === 0) fail(path, 'must not be blank');
  return s;
};

export interface Shape {
  readonly [key: string]: Validator<unknown>;
}

export interface ObjectRules {
  /** Keys that may be absent. */
  readonly optional?: readonly string[];
}

export function obj<T>(shape: Shape, rules: ObjectRules = {}): Validator<T> {
  const optional = new Set(rules.optional ?? []);
  return (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(path, 'must be an object');
    }
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (FORBIDDEN_KEYS.has(key)) fail(`${path}.${key}`, 'is not an allowed property name');
      if (!(key in shape)) fail(`${path}.${key}`, 'is not a known property');
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, validate] of Object.entries(shape)) {
      const raw = source[key];
      if (raw === undefined || raw === null) {
        if (optional.has(key)) continue;
        fail(`${path}.${key}`, 'is required');
      }
      out[key] = validate(raw, `${path}.${key}`);
    }
    return { ...out } as T;
  };
}

export const runtimeId = oneOf(['codex', 'claude-code', 'git'] as const);

/**
 * A URL that may be handed to the system browser.
 *
 * Only http and https. `file:`, `javascript:` and custom schemes are refused
 * here and again in the shell, so neither side alone decides what may launch.
 */
export const externalUrl: Validator<string> = (value, path) => {
  const raw = str({ min: 1, max: 4096 })(value, path);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail(path, 'must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail(path, 'must be an http(s) URL');
  }
  return parsed.toString();
};

/**
 * One validator per request channel. The router iterates this map to register
 * handlers, so a channel without a validator is a channel that does not exist.
 */
export const REQUEST_VALIDATORS: {
  [K in RequestChannel]: Validator<IpcMap[K]['request']>;
} = {
  'app.info': noArgs,
  'app.openExternal': obj({ url: externalUrl }),

  'settings.all': noArgs,
  // An empty value is legitimate here (clearing a setting), so the minimum is 0.
  'settings.set': obj({ key: str({ min: 1, max: 200 }), value: str({ min: 0, max: 10_000 }) }),

  'runtime.diagnose': noArgs,
  'runtime.install': obj({ runtimeId }),
  'runtime.cancelInstall': obj({ runtimeId }),

  'accounts.list': noArgs,
  'accounts.create': obj({
    name: str({ min: 1, max: 80 }),
    provider: oneOf(['anthropic', 'openai'] as const),
  }),
  'accounts.connect': obj({ accountId: id }),
  'accounts.cancelConnect': obj({ accountId: id }),
  'accounts.status': obj({ accountId: id }),
  'accounts.remove': obj({ accountId: id }),

  'agents.list': noArgs,

  'workspace.list': noArgs,
  'workspace.selectFolder': noArgs,
  'workspace.create': obj(
    {
      name: str({ min: 1, max: 120 }),
      localPath: absolutePath(),
      repositoryUrl,
      defaultBranch: str({ min: 1, max: 200 }),
    },
    { optional: ['repositoryUrl', 'defaultBranch'] },
  ),
  'workspace.clone': obj({
    repositoryUrl,
    parentPath: absolutePath(),
    name: str({ min: 1, max: 120 }),
  }),
  'workspace.setAgents': obj({
    workspaceId: id,
    orchestratorAgentId: id,
    workerAgentId: id,
  }),

  'verifications.list': obj({ workspaceId: id }),
  'verifications.create': obj({
    workspaceId: id,
    // The same identifier rule as everywhere else: never a path, never a
    // command. This is the name an orchestrator will ask for.
    id,
    label: str({ min: 1, max: 200 }),
    command: verificationCommand,
  }),
  'verifications.update': obj(
    {
      workspaceId: id,
      id,
      label: str({ min: 1, max: 200 }),
      command: verificationCommand,
      enabled: bool,
    },
    { optional: ['label', 'command', 'enabled'] },
  ),
  'verifications.remove': obj({ workspaceId: id, id }),

  'chat.listSessions': obj({ workspaceId: id }),
  'chat.createSession': obj({ workspaceId: id, title: str({ min: 1, max: 200 }) }),
  'chat.listMessages': obj({ sessionId: id }),
  'chat.sendMessage': obj({ sessionId: id, text: messageText }),

  'run.get': obj({ runId: id }),
  'run.cancel': obj({ runId: id }),
};
