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

import {
  ACCOUNT_CAPABILITY_TIERS,
  ACCOUNT_REASONING_TIERS,
  REASONING_LEVELS,
  WORKER_SELECTIONS,
  type IpcMap,
  type RequestChannel,
} from './ipc-contract.js';

export class IpcValidationError extends Error {
  readonly code = 'INVALID_ARGUMENT';
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

export type Validator<T> = (value: unknown, path: string) => T;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The kinds of shared-context entry a project can hold. Mirrors `ProjectContextKind`. */
const PROJECT_CONTEXT_KINDS = [
  'objective',
  'decision',
  'architecture',
  'rule',
  'state',
  'evidence',
] as const;

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
      // `null` is a value only for a validator that says it takes one (see
      // `nullable`); everywhere else it is "not given", as before.
      const takesNull = (validate as Validator<unknown> & { nullable?: boolean }).nullable === true;
      if (raw === undefined || (raw === null && !takesNull)) {
        if (optional.has(key)) continue;
        fail(`${path}.${key}`, 'is required');
      }
      out[key] = validate(raw, `${path}.${key}`);
    }
    return { ...out } as T;
  };
}

/** Accepts `null` or a value the inner validator takes. */
function nullable<T>(inner: Validator<T>): Validator<T | null> {
  const validate: Validator<T | null> & { nullable?: boolean } = (value, path) =>
    value === null ? null : inner(value, path);
  validate.nullable = true;
  return validate;
}

export const runtimeId = oneOf(['codex', 'claude-code', 'git'] as const);

/**
 * `owner/name`, as GitHub names a repository.
 *
 * Kept narrow on purpose: this string reaches a clone URL and a container
 * label, so no slashes beyond the one, no `..`, no whitespace, nothing that
 * could be read as a path or another argument.
 */
export const repositoryFullName: Validator<string> = (value, path) => {
  const text = str({ min: 3, max: 200 })(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    fail(path, 'must look like dono/nome');
  }
  if (text.includes('..')) fail(path, 'must not contain ".."');
  return text;
};

/**
 * A coordinator's base URL.
 *
 * https only, except on loopback: a device token travelling in clear over a
 * network is the credential gone. There is no option to turn this off.
 */
export const cloudEndpoint: Validator<string> = (value, path) => {
  const text = str({ min: 8, max: 2048 })(value, path);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail(path, 'must be a URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail(path, 'must use https (http is allowed only for 127.0.0.1)');
  }
  if (url.username || url.password) fail(path, 'must not carry a credential in the URL');
  return text;
};

/**
 * A model name as the CLIs take it (`gpt-5.1-codex`, `claude-opus-5`,
 * `provider/model`). Never whitespace, never a leading dash: this becomes one
 * argv entry after `--model`, and must not be readable as another flag.
 */
export const modelName = str({
  min: 1,
  max: 120,
  pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
  what: 'a model name',
});

/** A conversation title as a person types it: one line, not blank. */
export const sessionTitle: Validator<string> = (value, path) => {
  const s = str({ min: 1, max: 200 })(value, path);
  if (/[\r\n]/.test(s)) fail(path, 'must be a single line');
  if (s.trim().length === 0) fail(path, 'must not be blank');
  return s.trim();
};

/**
 * A git branch name as one argv entry after `git switch`: never a leading
 * dash (would be read as an option), no whitespace, no control characters,
 * and none of the characters git itself refuses in a ref name.
 */
export const branchName: Validator<string> = (value, path) => {
  const s = str({ min: 1, max: 250 })(value, path);
  if (s.startsWith('-')) fail(path, 'must not start with "-"');
  if (/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(s)) fail(path, 'must be a valid branch name');
  if (s.includes('..') || s.endsWith('/') || s.endsWith('.lock') || s.includes('@{')) {
    fail(path, 'must be a valid branch name');
  }
  return s;
};

/** One role of a workspace team: the account, and how it should run. */
export const teamMember = obj<{
  accountId: string;
  model?: string;
  reasoning?: string;
  selection?: string;
  label?: string;
}>(
  {
    accountId: id,
    model: modelName,
    reasoning: oneOf(REASONING_LEVELS),
    selection: oneOf(WORKER_SELECTIONS),
    label: str({ min: 1, max: 120 }),
  },
  { optional: ['model', 'reasoning', 'selection', 'label'] },
);

/**
 * A bounded list of validated entries.
 *
 * The bound is the point: a team is a handful of people's accounts, and a
 * request carrying ten thousand members is not a team, it is a way to make the
 * main process do arbitrary work.
 */
/**
 * A finite number in a range.
 *
 * Bounded on both ends deliberately: a spending limit typed as 1e400 is not a
 * generous limit, it is no limit, and the boundary is where that gets caught.
 */
export function num(options: { min: number; max: number }): Validator<number> {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a number');
    const n = value as number;
    if (n < options.min || n > options.max) {
      fail(path, `must be between ${options.min} and ${options.max}`);
    }
    return n;
  };
}

/** A whole number in a range. */
export function int(options: { min: number; max: number }): Validator<number> {
  const inner = num(options);
  return (value, path) => {
    const n = inner(value, path);
    if (!Number.isInteger(n)) fail(path, 'must be a whole number');
    return n;
  };
}

export function listOf<T>(inner: Validator<T>, max: number): Validator<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path, 'must be an array');
    const array = value as unknown[];
    if (array.length > max) fail(path, `must have at most ${max} entries`);
    return array.map((entry, index) => inner(entry, `${path}[${index}]`));
  };
}

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
  'app.setStartWithSystem': obj({ enabled: bool }),
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
  // Tiers by name, nullable for "no ceiling". A value that is not a tier is
  // refused here rather than stored and quietly ignored later.
  'accounts.setRoutingPolicy': obj({
    accountId: id,
    maxCapability: nullable(oneOf(ACCOUNT_CAPABILITY_TIERS)),
    maxReasoning: nullable(oneOf(ACCOUNT_REASONING_TIERS)),
    allowPremiumModels: bool,
  }),

  'github.status': noArgs,
  // Shape only: the service says, case by case, what is wrong with a value
  // (an App ID, the help example, a token), which a pattern here cannot.
  'github.configure': obj({ clientId: str({ min: 0, max: 200 }) }),
  'github.connect': noArgs,
  'github.cancelConnect': noArgs,
  'github.disconnect': noArgs,
  'github.repositories': noArgs,
  'github.branches': obj({ repository: repositoryFullName }),
  'github.pullRequestStatus': obj({ workspaceId: id }),
  'github.createPullRequest': obj(
    {
      workspaceId: id,
      title: str({ min: 1, max: 256 }),
      body: str({ min: 0, max: 20_000 }),
      base: branchName,
    },
    { optional: ['body', 'base'] },
  ),

  'workspace.fetch': obj({ workspaceId: id }),
  'workspace.createBranch': obj({ workspaceId: id, name: branchName }),
  'workspace.commit': obj({ workspaceId: id, message: str({ min: 1, max: 5000 }) }),
  'workspace.push': obj({ workspaceId: id }),

  'agents.list': noArgs,
  'agents.status': noArgs,

  // A URL, not a path: bounded, and the reader refuses anything that is not a
  // GitHub repository before a single request is made.
  'repository.analyse': obj({ url: str({ min: 1, max: 500 }) }),
  'run.exportDiagnostics': obj({ runId: id }),

  'workspace.list': noArgs,
  'workspace.selectFolder': noArgs,
  'workspace.openProject': obj({ localPath: absolutePath() }),
  'workspace.create': obj(
    {
      name: str({ min: 1, max: 120 }),
      localPath: absolutePath(),
      repositoryUrl,
      defaultBranch: str({ min: 1, max: 200 }),
    },
    { optional: ['repositoryUrl', 'defaultBranch'] },
  ),
  'workspace.createCloud': obj(
    {
      repository: repositoryFullName,
      branch: branchName,
      name: str({ min: 1, max: 120 }),
      repositoryPrivate: bool,
      endpoint: nullable(cloudEndpoint),
    },
    { optional: ['name', 'repositoryPrivate', 'endpoint'] },
  ),
  'workspace.createConversation': obj({ name: str({ min: 1, max: 120 }) }),
  'workspace.setBudget': obj({
    workspaceId: id,
    maxInvocations: nullable(int({ min: 1, max: 1000 })),
    maxTokens: nullable(int({ min: 1000, max: 100_000_000 })),
    // Dollars, as a number. Bounded so a typo cannot become a limit that is
    // effectively no limit at all.
    maxCostUsd: nullable(num({ min: 0.01, max: 10_000 })),
  }),
  'workspace.setPublish': obj({ workspaceId: id, enabled: bool, pullRequest: bool }),

  // Connections. The key is bounded but deliberately not pattern-matched: a
  // vendor is free to change its key format, and refusing a valid key because
  // this file has an old regexp would be a worse failure than letting the
  // provider reject it with its own message.
  'connections.list': noArgs,
  'connections.addApi': obj(
    {
      providerId: oneOf(['anthropic', 'openai'] as const),
      displayName: str({ min: 1, max: 120 }),
      apiKey: str({ min: 8, max: 500 }),
      // A compatible gateway, when someone runs one. Same rule as the cloud
      // endpoint: an https URL, never a path or an argument in disguise.
      baseUrl: nullable(externalUrl),
    },
    { optional: ['baseUrl'] },
  ),
  'connections.replaceKey': obj({ connectionId: id, apiKey: str({ min: 8, max: 500 }) }),
  'connections.rename': obj({ connectionId: id, displayName: str({ min: 1, max: 120 }) }),
  'connections.setEnabled': obj({ connectionId: id, enabled: bool }),
  'connections.setPreferences': obj({
    connectionId: id,
    model: nullable(modelName),
    reasoning: nullable(str({ min: 1, max: 40 })),
  }),
  'connections.disconnect': obj({ connectionId: id }),
  'connections.test': obj({ connectionId: id }),
  'connections.models': obj({ connectionId: id }),
  'cloud.status': noArgs,
  'cloud.connect': obj({
    endpoint: cloudEndpoint,
    // The device token, pasted from the coordinator. Long, opaque, and never
    // echoed back to the renderer once it is stored.
    token: str({ min: 16, max: 4096, pattern: /^[A-Za-z0-9._~+/=-]+$/, what: 'um token' }),
  }),
  'cloud.disconnect': noArgs,
  'cloud.sync': noArgs,
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
  'workspace.setTeam': obj(
    {
      workspaceId: id,
      orchestrator: teamMember,
      worker: teamMember,
      // Eight is well past any real team and far short of a denial of service.
      workers: listOf(teamMember, 8),
    },
    { optional: ['workers'] },
  ),
  'workspace.changes': obj({ workspaceId: id }),
  'workspace.rename': obj({ workspaceId: id, name: str({ min: 1, max: 120 }) }),
  'workspace.remove': obj({ workspaceId: id }),
  'workspace.branches': obj({ workspaceId: id }),
  'workspace.checkout': obj(
    { workspaceId: id, branch: branchName, allowDirty: bool },
    { optional: ['allowDirty'] },
  ),
  'workspace.openFolder': obj({ workspaceId: id }),

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

  'chat.listSessions': obj(
    { workspaceId: id, includeArchived: bool, query: str({ min: 0, max: 200 }) },
    { optional: ['includeArchived', 'query'] },
  ),
  'chat.listAllSessions': obj(
    { includeArchived: bool, query: str({ min: 0, max: 200 }) },
    { optional: ['includeArchived', 'query'] },
  ),
  'chat.moveSession': obj({ sessionId: id, projectId: nullable(id) }),
  'chat.createSession': obj(
    { workspaceId: id, title: str({ min: 1, max: 200 }), projectId: nullable(id) },
    { optional: ['projectId'] },
  ),
  'project.list': noArgs,
  'project.create': obj(
    {
      name: str({ min: 1, max: 200 }),
      workspaceId: nullable(id),
      repositoryUrl: nullable(str({ min: 1, max: 400 })),
    },
    { optional: ['workspaceId', 'repositoryUrl'] },
  ),
  'project.rename': obj({ projectId: id, name: str({ min: 1, max: 200 }) }),
  'project.setWorkspace': obj({ projectId: id, workspaceId: nullable(id) }),
  'project.remove': obj({ projectId: id }),
  // The URL is validated for shape here and for meaning in the service: this
  // is a length and character bound, and `repositoryKey` decides whether it
  // actually names a repository.
  'project.connectRepository': obj(
    { url: str({ min: 1, max: 400 }), name: str({ min: 1, max: 200 }) },
    { optional: ['name'] },
  ),
  'project.setRepository': obj({ projectId: id, url: nullable(str({ min: 1, max: 400 })) }),
  'project.setArchived': obj({ projectId: id, archived: bool }),
  'project.removalPlan': obj({ projectId: id }),
  'project.open': obj({ projectId: id }),
  'project.preflight': obj({ projectId: id }),
  // Two shapes, one channel. Each is closed: `associate` cannot smuggle a
  // parent path and `clone` cannot smuggle a folder to point at.
  'project.prepare': ((value: unknown, path: string) => {
    const mode = (value as { mode?: unknown } | null)?.mode;
    return mode === 'clone'
      ? obj(
          {
            projectId: id,
            mode: oneOf(['clone'] as const),
            parentPath: absolutePath(),
            folderName: str({ min: 1, max: 120 }),
          },
          { optional: ['folderName'] },
        )(value, path)
      : obj({ projectId: id, mode: oneOf(['associate'] as const), localPath: absolutePath() })(
          value,
          path,
        );
  }) as Validator<IpcMap['project.prepare']['request']>,
  'permission.pending': noArgs,
  'permission.forRun': obj({ runId: id }),
  // The rule is bounded here and *validated* in the service against the
  // request's own published options: a length check cannot tell a safe rule
  // from a wide one, and only the request knows what it offered.
  'permission.approve': obj({ requestId: id, rule: str({ min: 1, max: 400 }) }),
  'permission.deny': obj({ requestId: id }),
  'permission.grants': obj({ workspaceId: id }),
  'permission.revoke': obj({ grantId: id }),
  'project.listContext': obj({ projectId: id }),
  'project.addContext': obj(
    {
      projectId: id,
      kind: oneOf(PROJECT_CONTEXT_KINDS),
      title: str({ min: 1, max: 200 }),
      body: str({ min: 1, max: 8000 }),
      pinned: bool,
    },
    { optional: ['pinned'] },
  ),
  'project.updateContext': obj(
    {
      entryId: id,
      title: str({ min: 1, max: 200 }),
      body: str({ min: 1, max: 8000 }),
      pinned: bool,
    },
    { optional: ['title', 'body', 'pinned'] },
  ),
  'project.removeContext': obj({ entryId: id }),
  'chat.renameSession': obj({ sessionId: id, title: sessionTitle }),
  'chat.archiveSession': obj({ sessionId: id, archived: bool }),
  'chat.deleteSession': obj({ sessionId: id }),
  'chat.listMessages': obj({ sessionId: id }),
  'chat.sendMessage': obj({ sessionId: id, text: messageText }),

  'run.get': obj({ runId: id }),
  'run.list': obj({ workspaceId: id }),
  'run.detail': obj({ runId: id }),
  'run.cancel': obj({ runId: id }),
};
