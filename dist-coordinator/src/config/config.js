/**
 * Configuration loading and validation (spec 7).
 *
 * Config never holds credentials - only command names, paths and limits. The
 * Claude Code profile entries point at *directories* that the Claude Code CLI
 * itself owns; the orchestrator never reads what is inside them.
 */
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
export const DEFAULT_CONFIG = {
    projectPath: process.cwd(),
    codexCommand: process.platform === 'win32' ? 'codex.cmd' : 'codex',
    claudeCommand: process.platform === 'win32' ? 'claude.cmd' : 'claude',
    maxIterations: 20,
    autoRunTests: true,
    maxDecisionRepairAttempts: 2,
    defaultClaudeProfile: null,
    claudeProfiles: {},
    timeouts: { codexMinutes: 30, claudeMinutes: 60, verificationMinutes: 15 },
    workspace: { strategy: 'current' },
    workers: [{ id: 'worker-01', agent: 'claude-code', profile: null }],
    codexArgsTemplate: null,
    sessionsDirectory: resolve(process.cwd(), '.sessions'),
    additionalDirectories: [],
};
export class ConfigError extends Error {
    hint;
    constructor(message, hint) {
        super(message);
        this.hint = hint;
        this.name = 'ConfigError';
    }
}
/** Default config file location, relative to the current working directory. */
export const DEFAULT_CONFIG_FILENAME = 'config.json';
export function loadConfig(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const warnings = [];
    let sourcePath = null;
    let raw = {};
    if (options.configPath) {
        sourcePath = resolve(cwd, options.configPath);
        if (!existsSync(sourcePath)) {
            throw new ConfigError(`Config file not found: ${sourcePath}`, 'Check the --config path.');
        }
        raw = parseConfigFile(sourcePath);
    }
    else {
        const candidate = resolve(cwd, DEFAULT_CONFIG_FILENAME);
        if (existsSync(candidate)) {
            sourcePath = candidate;
            raw = parseConfigFile(candidate);
        }
        else {
            warnings.push(`No ${DEFAULT_CONFIG_FILENAME} found in ${cwd}; using built-in defaults.`);
        }
    }
    const config = normalise(raw, cwd, warnings);
    return { config, sourcePath, warnings };
}
function parseConfigFile(path) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch (err) {
        throw new ConfigError(`Could not read config file: ${path}`, String(err.message));
    }
    try {
        const parsed = JSON.parse(stripBom(text));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Top-level value must be a JSON object.');
        }
        return parsed;
    }
    catch (err) {
        throw new ConfigError(`Invalid JSON in config file: ${path}`, `${err.message} - fix the file and try again.`);
    }
}
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
/** Merges raw config over defaults and validates every field. */
export function normalise(raw, cwd, warnings = []) {
    const cfg = {
        ...DEFAULT_CONFIG,
        timeouts: { ...DEFAULT_CONFIG.timeouts },
        workspace: { ...DEFAULT_CONFIG.workspace },
        workers: DEFAULT_CONFIG.workers.map((w) => ({ ...w })),
        claudeProfiles: {},
        additionalDirectories: [],
        sessionsDirectory: resolve(cwd, '.sessions'),
        projectPath: cwd,
    };
    if (raw.projectPath !== undefined) {
        cfg.projectPath = resolve(cwd, requireString(raw.projectPath, 'projectPath'));
    }
    if (raw.codexCommand !== undefined)
        cfg.codexCommand = requireString(raw.codexCommand, 'codexCommand');
    if (raw.claudeCommand !== undefined) {
        cfg.claudeCommand = requireString(raw.claudeCommand, 'claudeCommand');
    }
    if (raw.maxIterations !== undefined) {
        cfg.maxIterations = requirePositiveInt(raw.maxIterations, 'maxIterations');
    }
    if (raw.autoRunTests !== undefined)
        cfg.autoRunTests = requireBoolean(raw.autoRunTests, 'autoRunTests');
    if (raw.maxDecisionRepairAttempts !== undefined) {
        cfg.maxDecisionRepairAttempts = requireNonNegativeInt(raw.maxDecisionRepairAttempts, 'maxDecisionRepairAttempts');
    }
    if (raw.sessionsDirectory !== undefined) {
        cfg.sessionsDirectory = resolve(cwd, requireString(raw.sessionsDirectory, 'sessionsDirectory'));
    }
    if (raw.additionalDirectories !== undefined) {
        cfg.additionalDirectories = requireStringArray(raw.additionalDirectories, 'additionalDirectories').map((d) => resolve(cwd, d));
    }
    if (raw.codexArgsTemplate !== undefined && raw.codexArgsTemplate !== null) {
        const template = requireStringArray(raw.codexArgsTemplate, 'codexArgsTemplate');
        if (template.length === 0) {
            throw new ConfigError('codexArgsTemplate must not be an empty array.', 'Remove the key to fall back to automatic capability detection.');
        }
        cfg.codexArgsTemplate = template;
    }
    if (raw.timeouts !== undefined) {
        const t = requireObject(raw.timeouts, 'timeouts');
        if (t.codexMinutes !== undefined) {
            cfg.timeouts.codexMinutes = requirePositiveNumber(t.codexMinutes, 'timeouts.codexMinutes');
        }
        if (t.claudeMinutes !== undefined) {
            cfg.timeouts.claudeMinutes = requirePositiveNumber(t.claudeMinutes, 'timeouts.claudeMinutes');
        }
        if (t.verificationMinutes !== undefined) {
            cfg.timeouts.verificationMinutes = requirePositiveNumber(t.verificationMinutes, 'timeouts.verificationMinutes');
        }
    }
    if (raw.workspace !== undefined) {
        const w = requireObject(raw.workspace, 'workspace');
        if (w.strategy !== undefined) {
            const strategy = requireString(w.strategy, 'workspace.strategy');
            if (strategy !== 'current' && strategy !== 'worktree' && strategy !== 'clone') {
                throw new ConfigError(`Unknown workspace.strategy: ${strategy}`, 'Valid values: current, worktree, clone.');
            }
            cfg.workspace.strategy = strategy;
        }
    }
    if (raw.claudeProfiles !== undefined) {
        const profiles = requireObject(raw.claudeProfiles, 'claudeProfiles');
        for (const [id, value] of Object.entries(profiles)) {
            cfg.claudeProfiles[id] = normaliseProfile(id, value, cwd, cfg.claudeCommand);
        }
    }
    if (raw.defaultClaudeProfile !== undefined && raw.defaultClaudeProfile !== null) {
        const id = requireString(raw.defaultClaudeProfile, 'defaultClaudeProfile');
        if (!cfg.claudeProfiles[id]) {
            throw new ConfigError(`defaultClaudeProfile "${id}" is not defined in claudeProfiles.`, `Known profiles: ${Object.keys(cfg.claudeProfiles).join(', ') || '(none)'}`);
        }
        cfg.defaultClaudeProfile = id;
    }
    if (raw.workers !== undefined) {
        const workers = requireArray(raw.workers, 'workers');
        cfg.workers = workers.map((value, index) => normaliseWorker(value, index, cfg));
        if (cfg.workers.length === 0) {
            throw new ConfigError('workers must not be empty.', 'Remove the key to use the default worker.');
        }
        if (cfg.workers.length > 1) {
            warnings.push(`${cfg.workers.length} workers configured; the MVP runs only workers[0] (${cfg.workers[0]?.id}).`);
        }
    }
    return cfg;
}
function normaliseProfile(id, value, cwd, fallbackCommand) {
    const obj = requireObject(value, `claudeProfiles.${id}`);
    const profileDirectory = resolve(cwd, requireString(obj.profileDirectory, `claudeProfiles.${id}.profileDirectory`));
    if (!isAbsolute(profileDirectory)) {
        // `resolve` guarantees this, but the invariant matters enough to assert:
        // the Claude Code CLI rejects a relative CLAUDE_CONFIG_DIR.
        throw new ConfigError(`claudeProfiles.${id}.profileDirectory must resolve to an absolute path.`, 'The Claude Code CLI requires CLAUDE_CONFIG_DIR to be absolute.');
    }
    return {
        name: obj.name === undefined ? id : requireString(obj.name, `claudeProfiles.${id}.name`),
        command: obj.command === undefined
            ? fallbackCommand
            : requireString(obj.command, `claudeProfiles.${id}.command`),
        profileDirectory,
    };
}
function normaliseWorker(value, index, cfg) {
    const obj = requireObject(value, `workers[${index}]`);
    const agent = obj.agent === undefined ? 'claude-code' : requireString(obj.agent, `workers[${index}].agent`);
    if (agent !== 'claude-code') {
        throw new ConfigError(`workers[${index}].agent "${agent}" is not supported in the MVP.`, 'Only "claude-code" workers exist today.');
    }
    let profile = null;
    if (obj.profile !== undefined && obj.profile !== null) {
        profile = requireString(obj.profile, `workers[${index}].profile`);
        if (!cfg.claudeProfiles[profile]) {
            throw new ConfigError(`workers[${index}].profile "${profile}" is not defined in claudeProfiles.`, `Known profiles: ${Object.keys(cfg.claudeProfiles).join(', ') || '(none)'}`);
        }
    }
    return {
        id: obj.id === undefined ? `worker-${String(index + 1).padStart(2, '0')}` : requireString(obj.id, `workers[${index}].id`),
        agent: 'claude-code',
        profile,
    };
}
// ---------------------------------------------------------------------------
// Small validation helpers. They throw ConfigError with the offending path so
// the CLI can print something a user can act on.
// ---------------------------------------------------------------------------
function requireString(value, path) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ConfigError(`${path} must be a non-empty string.`);
    }
    return value;
}
function requireBoolean(value, path) {
    if (typeof value !== 'boolean')
        throw new ConfigError(`${path} must be a boolean.`);
    return value;
}
function requirePositiveNumber(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new ConfigError(`${path} must be a number greater than 0.`);
    }
    return value;
}
function requirePositiveInt(value, path) {
    const n = requirePositiveNumber(value, path);
    if (!Number.isInteger(n))
        throw new ConfigError(`${path} must be an integer.`);
    return n;
}
function requireNonNegativeInt(value, path) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new ConfigError(`${path} must be an integer >= 0.`);
    }
    return value;
}
function requireObject(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ConfigError(`${path} must be a JSON object.`);
    }
    return value;
}
function requireArray(value, path) {
    if (!Array.isArray(value))
        throw new ConfigError(`${path} must be an array.`);
    return value;
}
function requireStringArray(value, path) {
    const arr = requireArray(value, path);
    return arr.map((v, i) => requireString(v, `${path}[${i}]`));
}
/** Minutes -> milliseconds, used when building `AgentInput.timeoutMs`. */
export function minutesToMs(minutes) {
    return Math.round(minutes * 60_000);
}
//# sourceMappingURL=config.js.map