/**
 * Codex as the orchestrator agent.
 *
 * Three rules this adapter exists to keep:
 *
 *  - the executable comes from `RuntimeManager.getExecutablePath('codex')`,
 *    never from PATH, so the app works on a machine that has never seen Codex;
 *  - the prompt goes over **stdin**, never on the command line, so no prompt
 *    can be mangled by quoting or picked up by another process's argv;
 *  - the non-interactive mode is *detected*, not assumed.
 */

import type { AgentInput, AgentResult, AgentRunner, HealthStatusCore, ProcessManager } from './adapter-types.js';
import { makeAgentResult } from '../core.js';
import { readCapabilities, type CliCapabilities } from './cli-capabilities.js';

export interface CodexAdapterOptions {
  processManager: ProcessManager;
  /** Resolves the managed executable; called lazily so a missing runtime is a
   *  clear error at use time rather than at construction time. */
  resolveExecutable: () => Promise<string>;
}

export class CodexAdapter implements AgentRunner {
  readonly kind = 'codex' as const;
  readonly label = 'Codex';

  private capabilities: CliCapabilities | null = null;
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly options: CodexAdapterOptions) {}

  async run(input: AgentInput): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const executable = await this.options.resolveExecutable();
    const args = await this.buildArgs(executable, input.workingDirectory);

    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const result = await this.options.processManager.run({
        command: executable,
        args,
        cwd: input.workingDirectory,
        stdin: input.prompt,
        timeoutMs: input.timeoutMs,
        signal: controller.signal,
        ...(input.env ? { env: input.env } : {}),
      });
      return makeAgentResult({
        startedAt,
        outcome: result.outcome,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
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
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0) {
        return { healthy: false, executable, problem: 'O Codex não respondeu como esperado.' };
      }
      return { healthy: true, executable, version: result.stdout.trim().split(/\s+/).pop() ?? '' };
    } catch (error) {
      return {
        healthy: false,
        problem: 'O Codex ainda não está configurado.',
        hint: 'Configurar automaticamente',
      };
    }
  }

  /**
   * Picks the non-interactive invocation this Codex build actually supports.
   *
   * `codex exec` is the documented headless mode. If a build does not offer it
   * we refuse rather than fall back to the interactive TUI, which would hang
   * forever behind a GUI with no terminal attached.
   */
  private async buildArgs(executable: string, cwd: string): Promise<string[]> {
    this.capabilities ??= await readCapabilities(this.options.processManager, executable, cwd);
    if (!this.capabilities.subcommands.has('exec')) {
      throw new CodexCapabilityError(
        'Esta versão do Codex não oferece um modo não interativo compatível.',
      );
    }
    const args = ['exec'];
    // `--skip-git-repo-check` only exists on builds that refuse to run outside a
    // repository; adding it when offered keeps a scratch folder usable.
    if (this.capabilities.flags.has('--skip-git-repo-check')) args.push('--skip-git-repo-check');
    return args;
  }
}

export class CodexCapabilityError extends Error {
  readonly userMessage: string;
  constructor(message: string) {
    super(message);
    this.name = 'CodexCapabilityError';
    this.userMessage = message;
  }
}
