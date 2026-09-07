/**
 * Preflight checks (spec 8).
 *
 * Nothing real runs until the CLIs the orchestrator depends on have been found
 * and answered `--version`. When something is missing the user gets a specific,
 * actionable message and the run does not start.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { ProcessManager } from '../process/process-manager.js';
import type { ProcessRunner } from '../execution/process-runner.js';

export interface ToolCheck {
  /** Label shown to the user, e.g. "Claude Code CLI". */
  label: string;
  /** Command as configured, e.g. `claude.cmd`. */
  command: string;
  found: boolean;
  /** Absolute path, when resolution succeeded. */
  path?: string;
  version?: string;
  ok: boolean;
  problem?: string;
  hint?: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: ToolCheck[];
  /** One combined, printable explanation of everything that failed. */
  summary: string;
}

export interface PreflightOptions {
  /** Include the Codex CLI in the checks. Skipped when running with mocks. */
  checkCodex: boolean;
  /** Include the Claude Code CLI in the checks. Skipped when running with mocks. */
  checkClaude: boolean;
  codexCommand: string;
  claudeCommand: string;
  cwd: string;
  processManager?: ProcessManager;
  /** Per-tool `--version` timeout. */
  timeoutMs?: number;
}

const VERSION_TIMEOUT_MS = 30_000;

export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const pm = options.processManager ?? new ProcessManager();
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  const checks: ToolCheck[] = [];

  checks.push(
    await checkTool(pm, {
      label: 'Node.js',
      command: process.execPath,
      args: ['--version'],
      cwd: options.cwd,
      timeoutMs,
      hint: 'Node.js 20.11 or newer is required.',
    }),
  );
  checks.push(
    await checkTool(pm, {
      label: 'Git',
      command: process.platform === 'win32' ? 'git.exe' : 'git',
      args: ['--version'],
      cwd: options.cwd,
      timeoutMs,
      hint: 'Install Git and make sure `git --version` works in a new terminal.',
    }),
  );

  if (options.checkCodex) {
    checks.push(
      await checkTool(pm, {
        label: 'Codex CLI (orchestrator)',
        command: options.codexCommand,
        args: ['--version'],
        cwd: options.cwd,
        timeoutMs,
        hint:
          'Install the Codex CLI and authenticate it, or point `codexCommand` in config.json ' +
          'at the right launcher (on Windows npm installs usually create codex.cmd).',
      }),
    );
  }

  if (options.checkClaude) {
    checks.push(
      await checkTool(pm, {
        label: 'Claude Code CLI (worker)',
        command: options.claudeCommand,
        args: ['--version'],
        cwd: options.cwd,
        timeoutMs,
        hint:
          'Install the Claude Code CLI and authenticate it, or point `claudeCommand` in ' +
          'config.json at the right launcher (on Windows npm installs usually create claude.cmd).',
      }),
    );
  }

  const failed = checks.filter((c) => !c.ok);
  const summary = failed.length
    ? [
        'Preflight failed. The run was not started.',
        '',
        ...failed.flatMap((c) => [
          `  ${c.label}: ${c.problem ?? 'unavailable'}`,
          c.hint ? `    ${c.hint}` : '',
        ]),
      ]
        .filter((line) => line !== '')
        .join('\n')
    : 'All required tools are available.';

  return { ok: failed.length === 0, checks, summary };
}

interface CheckToolOptions {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  hint: string;
}

async function checkTool(pm: ProcessManager, opts: CheckToolOptions): Promise<ToolCheck> {
  const resolved = await resolveExecutable(opts.command, pm);
  if (!resolved) {
    return {
      label: opts.label,
      command: opts.command,
      found: false,
      ok: false,
      problem: `not found on PATH (looked for "${opts.command}")`,
      hint: opts.hint,
    };
  }

  const result = await pm.run({
    command: resolved,
    args: opts.args,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });

  if (result.outcome === 'timeout') {
    return {
      label: opts.label,
      command: opts.command,
      found: true,
      path: resolved,
      ok: false,
      problem: `did not answer ${opts.args.join(' ')} within the timeout`,
      hint: opts.hint,
    };
  }
  if (result.outcome !== 'completed' || result.exitCode !== 0) {
    return {
      label: opts.label,
      command: opts.command,
      found: true,
      path: resolved,
      ok: false,
      problem:
        result.error ??
        `exited with code ${result.exitCode} when asked for its version: ${firstLine(result.stderr || result.stdout)}`,
      hint: opts.hint,
    };
  }

  return {
    label: opts.label,
    command: opts.command,
    found: true,
    path: resolved,
    version: firstLine(result.stdout) || firstLine(result.stderr),
    ok: true,
  };
}

/**
 * Locates an executable without assuming `which` exists (spec 39).
 *
 * On Windows this asks `where.exe` first, as the spec calls for, and falls back
 * to a PATH + PATHEXT scan. On other platforms it scans PATH directly.
 */
export async function resolveExecutable(
  command: string,
  pm: ProcessRunner = new ProcessManager(),
): Promise<string | null> {
  // An explicit path is used as-is.
  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    const abs = resolve(command);
    return isExecutableFile(abs) ? abs : null;
  }

  if (process.platform === 'win32') {
    const result = await pm.run({
      command: 'where.exe',
      args: [command],
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    if (result.outcome === 'completed' && result.exitCode === 0) {
      const first = result.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      if (first && isExecutableFile(first)) return first;
    }
    // where.exe can miss entries; fall through to the manual scan.
  }

  return scanPath(command);
}

/** Pure PATH scan. Honours PATHEXT on Windows. */
export function scanPath(
  command: string,
  pathValue: string | undefined = process.env.PATH ?? process.env.Path,
  platform: NodeJS.Platform = process.platform,
  pathExt: string | undefined = process.env.PATHEXT,
): string | null {
  if (!pathValue) return null;
  // Derived from `platform`, not the host, so the Windows rules are testable.
  const separator = platform === 'win32' ? ';' : delimiter;
  const dirs = pathValue.split(separator).filter((d) => d.length > 0);

  let extensions: string[] = [''];
  if (platform === 'win32' && extname(command) === '') {
    const configured = (pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0);
    // PATHEXT is conventionally uppercase while the files on disk are usually
    // lowercase. That is invisible on NTFS but matters on a case-sensitive
    // filesystem, so try both spellings.
    extensions = [...new Set(configured.flatMap((e) => [e, e.toLowerCase()]))];
  }

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/**
 * `platform` is a parameter rather than a read of `process.platform` so the
 * Windows resolution rules stay testable from any host.
 */
function isExecutableFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  // Windows has no executable bit; the extension is what decides.
  if (platform === 'win32') return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? '';
}
