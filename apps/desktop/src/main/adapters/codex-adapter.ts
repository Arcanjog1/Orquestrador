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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInput, AgentResult, AgentRunner, HealthStatusCore, ProcessManager } from './adapter-types.js';
import { makeAgentResult } from '../core.js';
import { readCapabilities, type CliCapabilities } from './cli-capabilities.js';

export interface CodexAdapterOptions {
  processManager: ProcessManager;
  /** Resolves the managed executable; called lazily so a missing runtime is a
   *  clear error at use time rather than at construction time. */
  resolveExecutable: () => Promise<string>;
  /**
   * JSON Schema constraining the model's final message.
   *
   * Supplied by the caller rather than baked in, so the adapter stays free of
   * orchestration semantics. Used only when the installed build offers
   * `--output-schema`.
   */
  outputSchema?: unknown;
  /**
   * Environment for the chosen Codex account, from `CodexAccountManager`.
   *
   * Sets that account's CODEX_HOME and deletes any inherited token, so two
   * workspaces bound to two accounts never share a login.
   */
  buildEnvironment?: () => Record<string, string | undefined>;
}

export class CodexAdapter implements AgentRunner {
  readonly kind = 'codex' as const;
  readonly label = 'Codex';

  private capabilities: CliCapabilities | null = null;
  /** `codex exec --help`: a subcommand's flags are not in the top-level help. */
  private execCapabilities: CliCapabilities | null = null;
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly options: CodexAdapterOptions) {}

  async run(input: AgentInput): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const executable = await this.options.resolveExecutable();

    // Scratch directory for the structured-output files. Removed in `finally`,
    // so a cancelled or crashed run leaves nothing behind.
    const scratch = mkdtempSync(join(tmpdir(), 'codex-run-'));
    const controller = new AbortController();
    this.controllers.add(controller);

    try {
      const plan = await this.buildArgs(executable, input.workingDirectory, scratch);
      const env = { ...(this.options.buildEnvironment?.() ?? {}), ...(input.env ?? {}) };
      const result = await this.options.processManager.run({
        command: executable,
        args: plan.args,
        cwd: input.workingDirectory,
        stdin: input.prompt,
        timeoutMs: input.timeoutMs,
        signal: controller.signal,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      });

      // The final message, when Codex was asked to write one, is the answer.
      // Its stdout is a transcript: readable, but not a contract. Falling back
      // to stdout keeps a build without the flag working exactly as before.
      const lastMessage = plan.lastMessagePath ? readIfPresent(plan.lastMessagePath) : null;
      const stdout = lastMessage && lastMessage.trim().length > 0 ? lastMessage : result.stdout;

      return makeAgentResult({
        startedAt,
        outcome: result.outcome,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        ...(result.error ? { error: result.error } : {}),
      });
    } finally {
      this.controllers.delete(controller);
      rmSync(scratch, { recursive: true, force: true });
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
   *
   * Flags are read from `codex exec --help`, not from the top level: a
   * subcommand's options do not appear in its parent's help, so checking the
   * top-level page finds nothing and silently drops every flag. Measured
   * against codex-cli 0.153.0, where `--skip-git-repo-check` and `--sandbox`
   * live on `exec` alone.
   *
   * `--json` is still not used: it prints *events* as JSONL, and the decision
   * parser would read the first event as the decision. The structured path is
   * `--output-schema` plus `-o/--output-last-message`, which is what this
   * builds when the installed build offers them.
   */
  private async buildArgs(executable: string, cwd: string, scratch: string): Promise<CodexPlan> {
    this.capabilities ??= await readCapabilities(this.options.processManager, executable, cwd);
    if (!this.capabilities.subcommands.has('exec')) {
      throw new CodexCapabilityError(
        'Esta versão do Codex não oferece um modo não interativo compatível.',
      );
    }

    this.execCapabilities ??= await readCapabilities(this.options.processManager, executable, cwd, [
      'exec',
      '--help',
    ]);

    const args = ['exec'];
    // Keeps a scratch folder usable on builds that otherwise refuse to run
    // outside a repository.
    if (this.execCapabilities.flags.has('--skip-git-repo-check')) {
      args.push('--skip-git-repo-check');
    }
    // The orchestrator supervises; the worker edits. Read-only makes that the
    // sandbox's rule rather than a line in a prompt.
    if (this.execCapabilities.flags.has('--sandbox')) {
      args.push('--sandbox', 'read-only');
    }

    // Structured output, when this build supports it: tell Codex the shape the
    // answer must take, and ask for that answer in a file of its own. Both are
    // additive - without them the loop still parses stdout, which is why the
    // fallback in `run` matters.
    if (this.options.outputSchema !== undefined && this.execCapabilities.flags.has('--output-schema')) {
      const schemaPath = join(scratch, 'decision.schema.json');
      writeFileSync(schemaPath, `${JSON.stringify(this.options.outputSchema, null, 2)}\n`, 'utf8');
      args.push('--output-schema', schemaPath);
    }

    let lastMessagePath: string | null = null;
    if (this.execCapabilities.flags.has('--output-last-message')) {
      lastMessagePath = join(scratch, 'last-message.txt');
      args.push('--output-last-message', lastMessagePath);
    }

    return { args, lastMessagePath };
  }
}

interface CodexPlan {
  readonly args: string[];
  /** Where Codex was asked to write its final message, when it can. */
  readonly lastMessagePath: string | null;
}

/** Reads a file the CLI may or may not have written. Absence is not an error. */
function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
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
