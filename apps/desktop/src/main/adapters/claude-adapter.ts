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
 *
 * The model and the effort are chosen *per invocation*: the loop's router
 * hands them in on `AgentInput.routing`, and this adapter sends only what the
 * installed build declared it accepts - a flag the help page does not list is
 * not sent, and an effort value the help page does not name is not sent
 * either. What was actually sent comes back on `AgentResult.applied`.
 */

import type { AgentInput, AgentResult, AgentRunner, HealthStatusCore, ProcessRunner } from './adapter-types.js';
import { makeAgentResult, resolveFixedEffort } from '../core.js';
import type { WorkerRuntimeCapabilities } from '../core.js';
import {
  describeProbe,
  modelAliases,
  optionValues,
  readCapabilities,
  type CliCapabilities,
  type CliProbe,
  type ProbeState,
} from './cli-capabilities.js';

export interface ClaudeAdapterOptions {
  processManager: ProcessRunner;
  resolveExecutable: () => Promise<string>;
  /** Environment for the chosen account, from `ClaudeAccountManager`. */
  buildEnvironment: () => Record<string, string | undefined>;
  /** Default model (`--model`) for invocations that carry no routing. */
  model?: string | null;
  /** Default effort (`--effort`) for invocations that carry no routing. */
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
    const routing = input.routing ?? {
      model: this.options.model ?? null,
      reasoning: this.options.effort ?? null,
    };
    const plan = await this.buildArgs(executable, input.workingDirectory, routing);
    const env = { ...this.options.buildEnvironment(), ...(input.env ?? {}) };

    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const result = await this.options.processManager.run({
        command: executable,
        args: plan.args,
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
        applied: plan.applied,
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
   * What this build, in this account's environment, can take - read from
   * its own help page. The router consults this before choosing; a new
   * adapter is built per run, so a changed account or binary is re-read.
   */
  async describeCapabilities(cwd = process.cwd()): Promise<WorkerRuntimeCapabilities> {
    const executable = await this.options.resolveExecutable();
    const capabilities = await this.readHelp(executable, cwd);
    return {
      modelFlag: capabilities.flags.has('--model'),
      effortFlag: capabilities.flags.has('--effort'),
      declaredModels: modelAliases(capabilities.help),
      declaredEfforts: optionValues(capabilities.help, '--effort'),
    };
  }

  /**
   * The help page, read once per adapter - and only kept when it was read.
   *
   * A probe that crashed, timed out or could not be spawned says nothing about
   * this build's flags, so it is neither cached nor allowed to become the
   * "no headless mode" verdict. That conflation is what block A4 fixed on the
   * Codex side; the same trap is here, so the same rule applies.
   */
  private async readHelp(executable: string, cwd: string): Promise<CliCapabilities> {
    if (this.capabilities) return this.capabilities;
    const capabilities = await readCapabilities(
      this.options.processManager,
      executable,
      cwd,
      ['--help'],
      this.options.buildEnvironment(),
    );
    if (capabilities.probe.state !== 'OK') {
      throw ClaudeCapabilityError.fromProbe(executable, capabilities.probe);
    }
    this.capabilities = capabilities;
    return capabilities;
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
  private async buildArgs(
    executable: string,
    cwd: string,
    routing: { model: string | null; reasoning: string | null },
  ): Promise<ClaudePlan> {
    const capabilities = await this.readHelp(executable, cwd);
    if (!capabilities.flags.has('--print')) {
      throw new ClaudeCapabilityError(
        'CAPABILITY_UNSUPPORTED',
        'Esta versão do Claude Code não oferece um modo não interativo compatível.',
        `o executável respondeu, mas sua ajuda não declara --print (${describeProbe(capabilities.probe)})`,
        executable,
      );
    }
    const args = ['--print'];
    if (capabilities.flags.has('--permission-mode')) {
      args.push('--permission-mode', 'acceptEdits');
    }

    const applied: ClaudePlan['applied'] = { model: null, reasoning: null, fallbackUsed: false, note: null };
    const notes: string[] = [];

    // Claude Code 2.1.263 offers `--model <model>` and `--effort <level>`;
    // each is sent only when the help page lists it.
    if (routing.model) {
      if (capabilities.flags.has('--model')) {
        args.push('--model', routing.model);
        applied.model = routing.model;
      } else {
        applied.fallbackUsed = true;
        notes.push('esta versão do Claude Code não aceita --model');
      }
    }
    if (routing.reasoning) {
      if (capabilities.flags.has('--effort')) {
        // The value must be one the help page names: an internal tier that
        // the router already mapped, or a manual choice, is checked again
        // here so that "max" never reaches a build that did not declare it.
        const resolved = resolveFixedEffort(routing.reasoning, optionValues(capabilities.help, '--effort'));
        if (resolved.value) {
          args.push('--effort', resolved.value);
          applied.reasoning = resolved.value;
        }
        if (resolved.fallbackUsed) {
          applied.fallbackUsed = true;
          if (resolved.note) notes.push(resolved.note);
        }
      } else {
        applied.fallbackUsed = true;
        notes.push('esta versão do Claude Code não aceita --effort');
      }
    }
    applied.note = notes.length > 0 ? notes.join('; ') : null;
    return { args, applied };
  }
}

interface ClaudePlan {
  readonly args: string[];
  readonly applied: { model: string | null; reasoning: string | null; fallbackUsed: boolean; note: string | null };
}

/** Same vocabulary as the Codex side: a failed check is not a verdict. */
export type ClaudeCapabilityReason =
  | 'CAPABILITY_UNSUPPORTED'
  | 'PROBE_FAILED'
  | 'PROBE_TIMEOUT'
  | 'EXECUTABLE_INCOMPATIBLE'
  | 'EXECUTABLE_NOT_FOUND'
  | 'PROCESS_ABORTED'
  | 'PARSER_FAILED';

const REASON_MESSAGE: Record<ClaudeCapabilityReason, string> = {
  CAPABILITY_UNSUPPORTED: 'Esta versão do Claude Code não oferece um modo não interativo compatível.',
  PROBE_FAILED: 'O Claude Code não respondeu à verificação de recursos.',
  PROBE_TIMEOUT: 'O Claude Code não respondeu à verificação de recursos dentro do tempo previsto.',
  EXECUTABLE_INCOMPATIBLE: 'O Claude Code instalado não conseguiu iniciar neste computador.',
  EXECUTABLE_NOT_FOUND: 'O executável do Claude Code não foi encontrado.',
  PROCESS_ABORTED: 'A verificação do Claude Code foi interrompida antes de terminar.',
  PARSER_FAILED: 'O Claude Code respondeu de uma forma que este aplicativo ainda não sabe ler.',
};

const REASON_OF_PROBE: Record<Exclude<ProbeState, 'OK'>, ClaudeCapabilityReason> = {
  EXECUTABLE_NOT_FOUND: 'EXECUTABLE_NOT_FOUND',
  PROBE_TIMEOUT: 'PROBE_TIMEOUT',
  PROCESS_ABORTED: 'PROCESS_ABORTED',
  EXECUTABLE_INCOMPATIBLE: 'EXECUTABLE_INCOMPATIBLE',
  PROBE_FAILED: 'PROBE_FAILED',
  PARSER_FAILED: 'PARSER_FAILED',
};

export class ClaudeCapabilityError extends Error {
  readonly userMessage: string;
  constructor(
    readonly reason: ClaudeCapabilityReason,
    message: string,
    readonly diagnosis: string | null = null,
    readonly executable: string | null = null,
  ) {
    super(diagnosis ? `${message} (${diagnosis})` : message);
    this.name = 'ClaudeCapabilityError';
    this.userMessage = diagnosis ? `${message} Detalhe: ${diagnosis}.` : message;
  }

  static fromProbe(executable: string, probe: CliProbe): ClaudeCapabilityError {
    const reason = probe.state === 'OK' ? 'CAPABILITY_UNSUPPORTED' : REASON_OF_PROBE[probe.state];
    return new ClaudeCapabilityError(reason, REASON_MESSAGE[reason], describeProbe(probe), executable);
  }
}
