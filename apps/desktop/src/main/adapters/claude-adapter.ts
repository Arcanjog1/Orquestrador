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
import type { InvocationUsage, WorkerRuntimeCapabilities } from '../core.js';
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
  /**
   * The session this worker should continue, when there is one.
   *
   * Read at call time rather than fixed at construction, because the id only
   * exists after the first invocation has answered with it. `claude -p
   * --resume <session-id>` is the documented way to continue a session
   * started non-interactively - and it is the *only* way, since sessions
   * created with `-p` are deliberately left out of the interactive picker.
   */
  resumeSessionId?: () => string | null;
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
    const resume = input.resumeSessionId ?? this.options.resumeSessionId?.() ?? null;
    const plan = await this.buildArgs(executable, input.workingDirectory, routing, resume);
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
      // When the build takes `--output-format json`, stdout is a documented
      // envelope rather than free text: it carries the answer, the session id
      // to resume next time, and the cost the CLI itself computed. Reading it
      // is what lets a worker keep its context between delegations instead of
      // meeting the codebase again on every turn.
      const envelope = plan.jsonOutput ? readEnvelope(result.stdout) : null;
      return makeAgentResult({
        startedAt,
        outcome: result.outcome,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: envelope?.text ?? result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        executable,
        applied: plan.applied,
        ...(envelope?.sessionId ? { sessionId: envelope.sessionId } : {}),
        ...(envelope?.usage ? { usage: envelope.usage } : {}),
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
    resumeSessionId: string | null,
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
    // The documented structured envelope. Additive: a build without it keeps
    // answering as plain text and everything below still works.
    const jsonOutput = capabilities.flags.has('--output-format');
    if (jsonOutput) args.push('--output-format', 'json');
    // Continue where this worker left off, when this conversation has already
    // produced a session for this account. `--bare` is deliberately never
    // sent: it does not read the subscription login, and requiring an API key
    // is exactly the cost this product refuses to impose.
    if (resumeSessionId && capabilities.flags.has('--resume')) {
      args.push('--resume', resumeSessionId);
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
    return { args, applied, jsonOutput };
  }

  /** True when the installed build can continue a session by id. */
  async supportsResume(cwd = process.cwd()): Promise<boolean> {
    const executable = await this.options.resolveExecutable();
    const capabilities = await this.readHelp(executable, cwd);
    return capabilities.flags.has('--resume') && capabilities.flags.has('--output-format');
  }
}

interface ClaudePlan {
  readonly args: string[];
  readonly applied: { model: string | null; reasoning: string | null; fallbackUsed: boolean; note: string | null };
  /** True when `--output-format json` was sent, so stdout is the envelope. */
  readonly jsonOutput: boolean;
}

/**
 * Reads `--output-format json`.
 *
 * Documented fields: `result` (the answer), `session_id`, `total_cost_usd`
 * and `usage`. The cost is the CLI's own figure, which beats any price table
 * this application could keep, so it is marked as reported.
 *
 * Anything unreadable returns null and the caller falls back to raw stdout -
 * a build that changed its envelope must not lose the answer.
 */
function readEnvelope(
  stdout: string,
): { text: string; sessionId: string | null; usage: InvocationUsage | null } | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const result = parsed.result;
  const structured = parsed.structured_output;
  const text =
    typeof result === 'string'
      ? result
      : structured !== undefined
        ? JSON.stringify(structured)
        : stdout;
  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;

  const raw = (parsed.usage ?? {}) as Record<string, unknown>;
  const input = numberOrNull(raw.input_tokens);
  const output = numberOrNull(raw.output_tokens);
  const cost = numberOrNull(parsed.total_cost_usd);
  const usage: InvocationUsage | null =
    input === null && output === null && cost === null
      ? null
      : {
          // The official CLI on the person's own login: the plan pays for it.
          // A cost figure here is what the run consumed, not a separate bill.
          billing: 'subscription',
          inputTokens: input,
          outputTokens: output,
          cachedInputTokens: numberOrNull(raw.cache_read_input_tokens),
          reasoningTokens: null,
          totalTokens: input === null && output === null ? null : (input ?? 0) + (output ?? 0),
          costUsd: cost,
          costReported: cost !== null,
        };
  return { text, sessionId, usage };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
