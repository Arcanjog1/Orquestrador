/**
 * Secret redaction (spec 25).
 *
 * Everything that leaves the orchestrator - console logs and every file written
 * under `.sessions/` - passes through `redact()` first. The goal is not perfect
 * detection (impossible) but making it hard for a credential to land on disk by
 * accident.
 */

export const REDACTED = '[REDACTED]';

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Replacement receives the full match and any capture groups. */
  readonly replace: (...args: string[]) => string;
}

/** Keeps the surrounding key visible so logs stay debuggable. */
const keepKey =
  (groupIndex: number) =>
  (...args: string[]): string =>
    `${args[groupIndex] ?? ''}${REDACTED}`;

const RULES: readonly Rule[] = [
  // Anthropic + OpenAI style API keys, wherever they appear.
  {
    name: 'anthropic-api-key',
    pattern: /sk-ant-[A-Za-z0-9_\-]{8,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'openai-api-key',
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_\-]{16,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
    replace: () => REDACTED,
  },
  // JWTs (three base64url segments).
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g,
    replace: () => REDACTED,
  },
  // `Authorization: Bearer xxx` and bare `Bearer xxx`.
  {
    name: 'bearer',
    pattern: /\b(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi,
    replace: keepKey(1),
  },
  {
    name: 'authorization-header',
    pattern: /\b(Authorization\s*[:=]\s*)(?!Bearer\b)\S+/gi,
    replace: keepKey(1),
  },
  {
    name: 'cookie-header',
    pattern: /\b((?:Set-)?Cookie\s*[:=]\s*)[^\r\n]+/gi,
    replace: keepKey(1),
  },
  // JSON/env style token fields: "access_token": "...", REFRESH_TOKEN=...
  {
    name: 'token-field',
    pattern:
      /("|')?\b((?:access|refresh|id|session|auth|api|bearer|oauth|client)[_-]?(?:token|key|secret)|session[_-]?id)\1?\s*(:|=)\s*("|')?[^\s,"'}\r\n]{6,}\4?/gi,
    replace: (...args: string[]): string => {
      const quote = args[1] ?? '';
      const key = args[2] ?? '';
      const sep = args[3] ?? ':';
      return `${quote}${key}${quote}${sep} ${REDACTED}`;
    },
  },
  {
    name: 'password-field',
    pattern: /("|')?\b(password|passwd|pwd|credential|credentials)\1?\s*(:|=)\s*("|')?[^\s,"'}\r\n]+\4?/gi,
    replace: (...args: string[]): string =>
      `${args[1] ?? ''}${args[2] ?? ''}${args[1] ?? ''}${args[3] ?? ':'} ${REDACTED}`,
  },
  // Anything that looks like the contents of a credentials file.
  {
    name: 'oauth-blob',
    pattern: /"(accessToken|refreshToken|idToken)"\s*:\s*"[^"]*"/gi,
    replace: (...args: string[]): string => `"${args[1] ?? ''}": "${REDACTED}"`,
  },
];

/**
 * Masks likely credentials in an arbitrary string.
 *
 * Safe to call on very large strings; each rule is a single linear pass.
 */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const rule of RULES) {
    // `replace` needs a fresh lastIndex because the patterns are global.
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      // Node passes (match, ...groups, offset, string); trailing args are not
      // strings, so coerce only the leading portion the rules care about.
      const strArgs = args.slice(0, -2).map((a) => (typeof a === 'string' ? a : ''));
      return rule.replace(...strArgs);
    });
  }
  return out;
}

/**
 * Recursively redacts every string inside a JSON-serialisable value. Used
 * before writing any session artifact.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Environment variable names whose values must never be logged, and which are
 * stripped from child environments so a profile cannot silently fall back to
 * API-key auth (spec 17).
 */
export const SENSITIVE_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_TOKEN',
];

/** Produces a log-safe view of an environment overlay: keys only, no values. */
export function describeEnvOverlay(env: Record<string, string | undefined> | undefined): string {
  if (!env) return '(none)';
  const keys = Object.keys(env).sort();
  return keys.length ? keys.join(', ') : '(none)';
}
