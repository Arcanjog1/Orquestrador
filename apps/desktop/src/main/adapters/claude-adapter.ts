/**
 * Claude Code as the coding worker.
 *
 * The account is what makes this adapter different from the Codex one: every
 * invocation runs with the environment `ClaudeAccountManager` builds for the
 * chosen account, which sets that account's private CLAUDE_CONFIG_DIR and
 * deletes any credential variable inherited from the machine. Two workspaces
 * bound to two accounts therefore never share a login.
 *
 * As with Codex: managed executable, prompt over stdin, flags detected.
 */

import type { AgentInput, AgentResult, AgentRunner, HealthStatusCore, ProcessManager } from './adapter-types.js';
import { makeAgentResult } from '../core.js';
import { readCapabilities, type CliCapabilities } from './cli-capabilities.js';

export interface ClaudeAdapterOptions {
  processManager: ProcessManager;
  resolveExecutable: () => Promise<string>;
  /** Environment for the chosen account, from `ClaudeAccountManager`. */
  buildEnvironment: () => Record<string, string | undefined>;
  /** Model to run with (`--model`), when the team chose one. */
  model?: string | null;
  /** Effort level (`--effort low|medium|high`), when the team chose one. */
  effort?: string | null;
}

export class ClaudeCodeAdapter implements AgentRunner {
  readonly kind = 'claude-code' as const;
  readonly label = 'Claude Code';

  private capabilities: CliCapabilities | null = null;
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly options: ClaudeAdapterOptions) {}

  async run(input: AgentInput): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const executable = await this.options.resolveExecutable();
    const args = await this.buildArgs(executable, input.workingDirectory);
    const env = { ...this.options.buildEnvironment(), ...(input.env ?? {}) };

    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const result = await this.options.processManager.run({
        command: executable,
        args,
        cwd: input.workingDirectory,
        stdin: input.prompt,
        env,
        timeoutMs: input.timeoutMs,
        signal: controller.signal,
      });
      return makeAgentResult({
        startedAt,
        outcome: result.outcome,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        executable,
        ...(result.error ? { error: result.error } : {}),
      });
    } finally {
      this.controllers.delete(controller);
    }
  }

  async cancel(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
  }

  async healthCheck(): Promise<HealthStatusCore> {
    try {
      const executable = await this.options.resolveExecutable();
      const result = await this.options.processManager.run({
        command: executable,
        args: ['--version'],
        cwd: process.cwd(),
        env: this.options.buildEnvironment(),
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0) {
        return { healthy: false, executable, problem: 'O Claude Code não respondeu como esperado.' };
      }
      return { healthy: true, executable, version: result.stdout.trim().split(/\s+/)[0] ?? '' };
    } catch {
      return {
        healthy: false,
        problem: 'O Claude Code ainda não está configurado.',
        hint: 'Configurar automaticamente',
      };
    }
  }

  /**
   * Builds the headless invocation.
   *
   * `--print` is the documented non-interactive mode. Permission handling is
   * only added when the build advertises `--permission-mode`, and then only
   * with `acceptEdits`: the worker is expected to edit files in the workspace
   * it was given, and nothing wider. A build without a print mode is refused
   * rather than launched into its interactive UI.
   */
  private async buildArgs(executable: string, cwd: string): Promise<string[]> {
    this.capabilities ??= await readCapabilities(this.options.processManager, executable, cwd);
    if (!this.capabilities.flags.has('--print')) {
      throw new ClaudeCapabilityError(
        'Esta versão do Claude Code não oferece um modo não interativo compatível.',
      );
    }
    const args = ['--print'];
    if (this.capabilities.flags.has('--permission-mode')) {
      args.push('--permission-mode', 'acceptEdits');
    }
    // The team's choices, only on builds that take them. Claude Code 2.1.261
    // offers `--model <model>` and `--effort <level>`.
    if (this.options.model && this.capabilities.flags.has('--model')) {
      args.push('--model', this.options.model);
    }
    if (this.options.effort && this.capabilities.flags.has('--effort')) {
      args.push('--effort', this.options.effort);
    }
    return args;
  }
}

export class ClaudeCapabilityError extends Error {
  readonly userMessage: string;
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCapabilityError';
    this.userMessage = message;
  }
}
