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

import type {
  AgentInput,
  AgentResult,
  AgentRunner,
  DeniedToolCall,
  HealthStatusCore,
  ProcessRunner,
} from './adapter-types.js';
import { makeAgentResult, redact, resolveFixedEffort } from '../core.js';
import { ActivityMonitor } from '../../../../../src/agents/activity-monitor.js';
import type { InvocationUsage, ProviderFailureKind, WorkerRuntimeCapabilities } from '../core.js';
import {
  declaredFlag,
  describeProbe,
  modelAliases,
  optionValues,
  readCapabilities,
  type CliCapabilities,
  type CliProbe,
  type ProbeState,
} from './cli-capabilities.js';

/**
 * The tools a worker uses to read and write files.
 *
 * Bare tool names, which is the documented form for "this tool runs without a
 * prompt". They are the right tools for file work - `Write` creates a file,
 * `Edit` changes one - and reaching for a shell to do the same thing is what
 * turned "create a six-byte file" into a denied PowerShell call.
 *
 * `Bash` and `PowerShell` are deliberately **not** here. A command still needs
 * its own approval, for the scope it names and nothing wider.
 */
const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

/** A bound on the command line, so a long grant list cannot break the spawn. */
const MAX_ALLOWED_RULES = 64;

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
   * How long a streamed turn may say nothing before it is stopped.
   *
   * Only applied when the build can stream; see `run`. Omitted means
   * `DEFAULT_IDLE_TIMEOUT_MS`.
   */
  idleTimeoutMs?: number;
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
  /**
   * Permission rules a person has explicitly approved for this workspace.
   *
   * Read at call time, because an approval can arrive between two delegations
   * - which is the whole point of the approval flow. Each entry is a
   * documented permission rule (`Bash(node check.mjs)`, `Write`), and the list
   * carries only what somebody actually approved: nothing here is inferred
   * from a failure, and nothing is added by the application on its own.
   */
  allowedTools?: () => readonly string[];
}

export class ClaudeCodeAdapter implements AgentRunner {
  readonly kind = 'claude-code' as const;
  readonly label = 'Claude Code';

  private capabilities: CliCapabilities | null = null;
  /** `undefined` = not asked yet; `null` = asked and the tool did not say. */
  private version: string | null | undefined = undefined;
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
    if (input.strictRouting && ((routing.model && plan.applied.model !== routing.model) || (routing.reasoning && !plan.applied.reasoning))) throw new Error('O runtime não permite garantir o teto configurado. Atualize o runtime.');
    const env = { ...this.options.buildEnvironment(), ...(input.env ?? {}) };

    const controller = new AbortController();
    this.controllers.add(controller);

    // What this invocation is doing, as it does it.
    //
    // The reason this exists: with `--output-format json` the CLI says nothing
    // until it is finished, so a turn that hung and a turn that was working
    // looked identical from here - for as long as the hard timeout allowed.
    // `stream-json` makes each step observable, and the monitor turns those
    // steps into "running for 4m, tool: Write" instead of silence.
    const idleTimeoutMs = input.idleTimeoutMs ?? this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const monitor = new ActivityMonitor(new Date(startedAt), {
      idleTimeoutMs,
      ...(input.onActivity ? { onChange: input.onActivity } : {}),
    });

    // Read before the invocation, so the run itself is the last thing spawned
    // and the probe is paid for once per adapter rather than once per turn.
    const version = await this.versionOf(executable, input.workingDirectory);

    try {
      const result = await this.options.processManager.run({
        command: executable,
        args: plan.args,
        cwd: input.workingDirectory,
        stdin: input.prompt,
        env,
        timeoutMs: input.timeoutMs,
        // Silence has its own deadline, shorter than the hard one. A build
        // that cannot stream is left on the hard timeout alone: capping
        // silence when silence is the documented behaviour would kill healthy
        // runs, which would be worse than the problem being fixed.
        ...(plan.streaming && idleTimeoutMs > 0 ? { idleTimeoutMs } : {}),
        signal: controller.signal,
        onStdout: (chunk) => monitor.observe(chunk),
      });
      // When the build takes `--output-format json`, stdout is a documented
      // envelope rather than free text: it carries the answer, the session id
      // to resume next time, and the cost the CLI itself computed. Reading it
      // is what lets a worker keep its context between delegations instead of
      // meeting the codebase again on every turn.
      const envelope = plan.streaming
        ? readStreamEnvelope(result.stdout)
        : plan.jsonOutput
          ? readEnvelope(result.stdout)
          : null;

      // The envelope reports a failure *inside* a run that exited 0.
      //
      // This is the trap this whole block exists for. `claude -p` exits 0 and
      // sets `is_error` when the run itself failed - a refused tool, a turn
      // limit, an error during execution. Reading only `result` therefore
      // turned "the worker was not allowed to write the file" into "the worker
      // finished cleanly and changed nothing", which the loop then read as no
      // progress and answered by escalating the model. No model can fix a
      // refused permission, so the run escalated to the top and stopped with
      // nobody ever seeing the actual cause.
      // A run stopped for producing nothing is its own diagnosis, and it
      // outranks whatever the (absent or partial) envelope says: there is no
      // envelope when the CLI never got to write one.
      const stalled = result.trace?.idleTimedOut === true;
      const failure: ProviderFailureKind | null = stalled
        ? 'no-activity'
        : envelope
          ? classifyEnvelope(envelope)
          : null;
      const denials = envelope?.permissionDenials ?? [];
      // The same refusals, with the command attached. This is what the
      // approval dialog is built from: a tool name alone cannot be approved.
      const deniedCalls = envelope?.deniedCalls ?? [];
      // What the CLI said, and which build said it. Both are read here rather
      // than reconstructed later, because after this function returns the
      // process is gone and nothing can be asked again.
      const failureDetail = stalled
        ? `no output for ${Math.round(idleTimeoutMs / 1000)}s`
        : envelope
          ? describeEnvelopeFailure(envelope)
          : result.outcome !== 'completed' || result.exitCode !== 0
            ? // No envelope at all: the stream never produced a result line.
              // That is itself the diagnosis, and it used to arrive as silence.
              `sem envelope legível (outcome=${result.outcome}, exit=${result.exitCode ?? 'null'})`
            : null;
      const stderr = [result.stderr, describeDenials(denials), envelope?.errorSummary ?? '', stallSummary(stalled, idleTimeoutMs, monitor)]
        .filter((part) => part.trim().length > 0)
        .join('\n');

      return makeAgentResult({
        startedAt,
        outcome: result.outcome,
        // An envelope that says it failed is a failure, whatever the exit code
        // was. Keeping the CLI's own 0 here would hide it from every check
        // downstream that reads `exitCode`.
        exitCode: failure ? (result.exitCode === 0 ? 1 : result.exitCode) : result.exitCode,
        signal: result.signal,
        // Never lose what came back. When the envelope cannot be read, the raw
        // stdout is the report; when it can, `result` is.
        stdout: envelope?.text ?? result.stdout,
        stderr,
        truncated: result.truncated,
        executable,
        applied: plan.applied,
        observed: {model:reportedClaudeModel(result.stdout),reasoning:null},
        // Exactly what `--allowedTools` carried, so an authorisation can be
        // proven at the runtime instead of inferred from a grant row.
        authorisedTools: plan.authorisedTools,
        ...(envelope?.sessionId ? { sessionId: envelope.sessionId } : {}),
        ...(envelope?.usage ? { usage: envelope.usage } : {}),
        ...(failure ? { failure } : {}),
        // The tool's own words, kept next to our classification rather than
        // replaced by it. This is the field that turns "erro do provider" into
        // something a person can act on.
        ...(failureDetail ? { failureDetail } : {}),
        ...(version ? { version } : {}),
        ...(denials.length > 0 ? { permissionDenials: denials } : {}),
        ...(deniedCalls.length > 0 ? { deniedCalls } : {}),
        activity: monitor.snapshot(),
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

    // The tools a worker needs to do file work, named explicitly.
    //
    // This is the fix for the run that failed. `acceptEdits` is documented to
    // auto-approve file edits and a *specific* list of filesystem shell
    // commands - `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`, and the
    // PowerShell content cmdlets - and then:
    //
    //   "all other Bash commands except the built-in read-only set still
    //    prompt"
    //   - https://code.claude.com/docs/en/permission-modes
    //
    // In `--print` there is nobody to answer a prompt, so those calls are
    // denied. A worker asked to create a six-byte file reached for a shell,
    // was prompted, and the prompt could not be answered.
    //
    // Naming the file tools here is not a way around that policy. It is the
    // policy: `acceptEdits` exists precisely to let Claude write files in the
    // working directory, and `--allowedTools` states it independently of the
    // mode, so a mode change cannot silently take it away. It grants nothing
    // outside these tools - a shell command still needs its own approval - and
    // `--allowedTools` never widens the tool *set*, only what runs without a
    // prompt (`--tools` is the flag that would restrict availability).
    //
    // The lookup goes through `declaredFlag` because `parseHelp` folds every
    // flag to lower case: `flags.has('--allowedTools')` is always false, and
    // writing it that way would have made this whole fix silently inert.
    const allowedToolsFlag = declaredFlag(capabilities, '--allowedTools', '--allowed-tools');
    let authorisedTools: readonly string[] = [];
    if (allowedToolsFlag) {
      const flag = allowedToolsFlag;
      const rules = [...FILE_TOOLS, ...(this.options.allowedTools?.() ?? [])];
      // De-duplicated and bounded: a grant list that grew without limit would
      // eventually build a command line the shell refuses.
      const unique = [...new Set(rules.map((rule) => rule.trim()).filter((r) => r.length > 0))];
      authorisedTools = unique.slice(0, MAX_ALLOWED_RULES);
      if (authorisedTools.length > 0) args.push(flag, ...authorisedTools);
    }
    // The documented structured envelope. Additive: a build without it keeps
    // answering as plain text and everything below still works.
    const jsonOutput = capabilities.flags.has('--output-format');
    // Stream the turn when the build offers it.
    //
    // `json` buffers everything until the run ends, which is what made a long
    // execution unobservable: no output meant no way to tell work from a hang.
    // `stream-json` emits the same final `result` object as its last line, so
    // nothing downstream changes - the envelope is read from that line instead
    // of from the whole of stdout - and every step before it becomes visible.
    // `--verbose` is required alongside it in `--print` mode.
    const streaming =
      jsonOutput &&
      (optionValues(capabilities.help, '--output-format') ?? []).includes('stream-json') &&
      capabilities.flags.has('--verbose');
    if (streaming) args.push('--output-format', 'stream-json', '--verbose');
    else if (jsonOutput) args.push('--output-format', 'json');
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
    return { args, applied, jsonOutput, streaming, authorisedTools };
  }

  /**
   * The installed build's version, read once and remembered.
   *
   * Read from `--version`, which every build has. Cached for the life of the
   * adapter because a new adapter is built per run, so a changed binary is
   * re-read anyway.
   *
   * Returns null rather than throwing or guessing. A version this application
   * could not obtain is "não informado" on screen, which is a true statement;
   * a fabricated one would send somebody chasing the wrong release notes.
   */
  private async versionOf(executable: string, cwd: string): Promise<string | null> {
    if (this.version !== undefined) return this.version;
    try {
      const probe = await this.options.processManager.run({
        command: executable,
        args: ['--version'],
        cwd,
        env: this.options.buildEnvironment(),
        timeoutMs: 15_000,
      });
      const line = probe.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
      this.version = line.length > 0 && probe.exitCode === 0 ? line.slice(0, 120) : null;
    } catch {
      this.version = null;
    }
    return this.version;
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
  /** Exactly what `--allowedTools` carried, for the record. */
  readonly authorisedTools: readonly string[];
  readonly applied: { model: string | null; reasoning: string | null; fallbackUsed: boolean; note: string | null };
  /** True when `--output-format json` was sent, so stdout is the envelope. */
  readonly jsonOutput: boolean;
  /** True when the turn was streamed, so stdout is line-delimited events. */
  readonly streaming: boolean;
}

interface ClaudeEnvelope {
  text: string;
  sessionId: string | null;
  usage: InvocationUsage | null;
  /** `success`, `error_max_turns`, `error_during_execution`, … */
  subtype: string | null;
  isError: boolean;
  /** Tools the run asked for and was refused, as the CLI reported them. */
  permissionDenials: string[];
  /** The same refusals with their command and arguments, where reported. */
  deniedCalls: DeniedToolCall[];
  /** A short line naming the failure, for stderr. Empty when there is none. */
  errorSummary: string;
}

/**
 * What kind of failure the envelope describes, or null when it describes none.
 *
 * A refused tool is `tool-permission-denied` rather than a generic failure
 * because the loop treats it differently: it is mechanical, so no stronger
 * model is tried, and it is actionable, so the orchestrator is told what was
 * refused instead of "no progress".
 */
function classifyEnvelope(envelope: ClaudeEnvelope): ProviderFailureKind | null {
  if (envelope.permissionDenials.length > 0) return 'tool-permission-denied';
  if (!envelope.isError) {
    // A run that succeeded but said nothing is still nothing to act on, and
    // saying so beats handing the orchestrator an empty string.
    return envelope.text.trim().length === 0 ? 'empty-response' : null;
  }
  // Everything else is `provider-error`, and that is deliberate: the loop
  // branches on a handful of kinds, and inventing one per CLI subtype would
  // make the routing table guess at meanings the tool never promised.
  //
  // What is NOT acceptable is losing the subtype on the way. The previous
  // version had two branches that returned the same value, so
  // `error_during_execution` and `error_max_turns` — different problems with
  // different fixes — both reached the screen as "erro do provider" and
  // nothing else. `describeEnvelopeFailure` below keeps the tool's own words.
  return 'provider-error';
}

/**
 * The CLI's own account of the failure, in the words it used.
 *
 * Deliberately not translated and not interpreted: `error_max_turns` means the
 * run hit its turn limit and `error_during_execution` means something threw,
 * and a person debugging needs to know which. Guessing a friendlier cause from
 * a subtype we do not control is how a specific problem becomes a wrong one.
 */
export function describeEnvelopeFailure(envelope: ClaudeEnvelope): string | null {
  if (!envelope.isError && envelope.permissionDenials.length === 0) return null;
  const parts: string[] = [];
  if (envelope.subtype) parts.push(`subtype=${envelope.subtype}`);
  if (envelope.permissionDenials.length > 0) {
    parts.push(`permission_denials=${envelope.permissionDenials.join(',')}`);
  }
  if (envelope.isError) parts.push('is_error=true');
  return parts.length > 0 ? parts.join(' · ') : null;
}

function describeDenials(denials: readonly string[]): string {
  if (denials.length === 0) return '';
  return `Ferramentas recusadas nesta execução: ${denials.join(', ')}.`;
}

/**
 * Reads `--output-format json`.
 *
 * Documented fields on the result message: `result`, `subtype`, `is_error`,
 * `session_id`, `total_cost_usd`, `usage`, `permission_denials` and
 * `structured_output`. The cost is the CLI's own figure, which beats any price
 * table this application could keep, so it is marked as reported.
 *
 * Anything unreadable returns null and the caller falls back to raw stdout -
 * a build that changed its envelope must not lose the answer.
 */
function readEnvelope(stdout: string): ClaudeEnvelope | null {
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
  const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : null;
  const isError = parsed.is_error === true;
  const permissionDenials = readDenials(parsed.permission_denials);
  const deniedCalls = readDeniedCalls(parsed.permission_denials);
  const errorSummary = isError
    ? `A execução do Claude Code terminou em erro${subtype ? ` (${subtype})` : ''}.`
    : '';

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
  return { text, sessionId, usage, subtype, isError, permissionDenials, deniedCalls, errorSummary };
}

/**
 * The refused tools, named.
 *
 * The shape is a list of objects the CLI writes; only the tool name is taken,
 * because the rest can carry the arguments a tool was called with and those
 * may contain anything the person typed.
 */
function readDenials(value: unknown): string[] {
  return [...new Set(readDeniedCalls(value).map((call) => call.toolName))];
}

/**
 * The refused calls, with whatever detail the provider attached to them.
 *
 * The shape is **verified against the real CLI**, not guessed. Claude Code
 * 2.1.263 emits exactly this for a refused Bash call:
 *
 * ```json
 * {
 *   "tool_name": "Bash",
 *   "tool_use_id": "toolu_015GDcCy2Xi2Kr9w6cxMPQVX",
 *   "tool_input": {
 *     "command": "node -e \"...\"",
 *     "description": "Create hello.txt with content 'pronto' via node"
 *   }
 * }
 * ```
 *
 * It is still read defensively - the shape is not part of any published
 * contract and can change between releases - so the alternative spellings are
 * kept, a bare string is accepted as a tool name, and anything not found stays
 * absent so the interface can say "não informado" instead of inventing it.
 *
 * The input is read **only here**, and only for a call that was refused. The
 * activity monitor still never reads tool inputs: those belong to work in
 * progress and can carry the person's own text. A refused call is different -
 * it is about to be shown to the owner of the machine so they can decide
 * whether to allow it, and a decision needs the command.
 */
export function readDeniedCalls(value: unknown): DeniedToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: DeniedToolCall[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, 20)) {
    const call = readDeniedCall(entry);
    if (!call) continue;
    // One row per (tool, command): a provider that reports the same refusal
    // twice must not produce two dialogs asking the same question.
    const key = `${call.toolName}\u0000${call.command ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push(call);
  }
  return calls;
}

function readDeniedCall(entry: unknown): DeniedToolCall | null {
  if (typeof entry === 'string') {
    const name = entry.trim().slice(0, 80);
    return name.length > 0 ? { toolName: name } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const row = entry as Record<string, unknown>;
  const name = str(row.tool_name) ?? str(row.name) ?? str(row.tool);
  if (!name) return null;

  const input = (row.tool_input ?? row.input ?? row.parameters) as unknown;
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  // `command` for Bash and PowerShell, `file_path` for the file tools: the one
  // thing a person most needs to see, promoted out of the argument blob.
  const command = str(fields.command) ?? str(fields.file_path) ?? str(row.command);

  // The agent's own explanation of the call. The command says what; this says
  // why, and it is what turns an approval dialog from a puzzle into a question.
  const description = str(fields.description) ?? str(row.description);

  return {
    toolName: name.slice(0, 80),
    ...(str(row.tool_use_id) ?? str(row.id)
      ? { toolUseId: (str(row.tool_use_id) ?? str(row.id))!.slice(0, 120) }
      : {}),
    ...(command ? { command: redact(command).slice(0, 2000) } : {}),
    ...(description ? { description: redact(description).slice(0, 500) } : {}),
    ...(Object.keys(fields).length > 0
      ? { arguments: redact(JSON.stringify(fields)).slice(0, 4000) }
      : {}),
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
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


/**
 * How long a streamed turn may produce nothing before it is called stuck.
 *
 * Ten minutes. Long enough that a genuinely slow tool - a large install, a
 * full test suite - is never mistaken for a hang, and short enough that a
 * person is not left watching a dead window for the length of the hard
 * timeout. Buzz's harness defaults to a comparable figure (620s) for the same
 * job, which is some evidence the order of magnitude is right.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Reads `--output-format stream-json`.
 *
 * The stream is line-delimited JSON and its **last** `result` object is the
 * same envelope `--output-format json` would have printed on its own. So this
 * finds that line and hands it to the very same reader: one parser, one set of
 * rules about `is_error` and `permission_denials`, and no second place for the
 * envelope's meaning to drift.
 *
 * A stream that ends without a result object - the process was killed, the
 * build changed its format - returns null, and the caller falls back to raw
 * stdout. Losing the output would be worse than not labelling it.
 */
export function readStreamEnvelope(stdout: string): ClaudeEnvelope | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== 'result') continue;
    return readEnvelope(line);
  }
  return null;
}

/** The stall, in the words the details screen shows. Empty when there was none. */
function stallSummary(stalled: boolean, idleTimeoutMs: number, monitor: ActivityMonitor): string {
  if (!stalled) return '';
  const snapshot = monitor.snapshot();
  const seconds = Math.round(idleTimeoutMs / 1000);
  const doing = snapshot.currentTool ? ` A última coisa que fez foi usar ${snapshot.currentTool}.` : '';
  return (
    `O worker ficou ${seconds}s sem produzir nenhuma saída e foi interrompido.` +
    `${doing} Isso não é falta de capacidade: um modelo mais forte não destrava um processo parado.`
  );
}

/** Only structured provider events count; prose or our own flags never do. */
export function reportedClaudeModel(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event=JSON.parse(line);
      if (event?.type==='system' && event.subtype==='init' && typeof event.model==='string') return event.model;
      if (event?.type==='result' && event.modelUsage && typeof event.modelUsage==='object') {
        const names=Object.keys(event.modelUsage);
        if (names.length===1) return names[0]!;
      }
    } catch { /* Non-JSON transcript lines are not evidence of the model. */ }
  }
  return null;
}
