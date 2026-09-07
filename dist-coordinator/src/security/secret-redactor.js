/**
 * Secret redaction (spec 25).
 *
 * Everything that leaves the orchestrator - console logs and every file written
 * under `.sessions/` - passes through `redact()` first. The goal is not perfect
 * detection (impossible) but making it hard for a credential to land on disk by
 * accident.
 */
export const REDACTED = '[REDACTED]';
/** Keeps the surrounding key visible so logs stay debuggable. */
const keepKey = (groupIndex) => (...args) => `${args[groupIndex] ?? ''}${REDACTED}`;
const RULES = [
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
        pattern: /("|')?\b((?:access|refresh|id|session|auth|api|bearer|oauth|client)[_-]?(?:token|key|secret)|session[_-]?id)\1?\s*(:|=)\s*("|')?[^\s,"'}\r\n]{6,}\4?/gi,
        replace: (...args) => {
            const quote = args[1] ?? '';
            const key = args[2] ?? '';
            const sep = args[3] ?? ':';
            return `${quote}${key}${quote}${sep} ${REDACTED}`;
        },
    },
    {
        name: 'password-field',
        pattern: /("|')?\b(password|passwd|pwd|credential|credentials)\1?\s*(:|=)\s*("|')?[^\s,"'}\r\n]+\4?/gi,
        replace: (...args) => `${args[1] ?? ''}${args[2] ?? ''}${args[1] ?? ''}${args[3] ?? ':'} ${REDACTED}`,
    },
    // Anything that looks like the contents of a credentials file.
    {
        name: 'oauth-blob',
        pattern: /"(accessToken|refreshToken|idToken)"\s*:\s*"[^"]*"/gi,
        replace: (...args) => `"${args[1] ?? ''}": "${REDACTED}"`,
    },
];
/**
 * Masks likely credentials in an arbitrary string.
 *
 * Safe to call on very large strings; each rule is a single linear pass.
 */
export function redact(input) {
    if (!input)
        return input;
    let out = input;
    for (const rule of RULES) {
        // `replace` needs a fresh lastIndex because the patterns are global.
        rule.pattern.lastIndex = 0;
        out = out.replace(rule.pattern, (...args) => {
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
export function redactDeep(value) {
    if (typeof value === 'string')
        return redact(value);
    if (Array.isArray(value))
        return value.map((v) => redactDeep(v));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = redactDeep(v);
        }
        return out;
    }
    return value;
}
/**
 * Environment variable names whose values must never be logged, and which are
 * stripped from child environments so a profile cannot silently fall back to
 * API-key auth (spec 17).
 */
export const SENSITIVE_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_TOKEN',
    // `codex login --with-access-token` reads this one; left in the environment
    // it would satisfy every profile at once and collapse account isolation.
    'CODEX_ACCESS_TOKEN',
];
/** Produces a log-safe view of an environment overlay: keys only, no values. */
export function describeEnvOverlay(env) {
    if (!env)
        return '(none)';
    const keys = Object.keys(env).sort();
    return keys.length ? keys.join(', ') : '(none)';
}
//# sourceMappingURL=secret-redactor.js.map