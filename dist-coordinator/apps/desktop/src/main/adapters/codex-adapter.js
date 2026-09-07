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
 *
 * The orchestrator's model and reasoning level are the person's fixed choice
 * for the project. The reasoning level is still checked against the installed
 * build before it is sent: a Codex older than rust-v0.140.0 does not know
 * `max`, and sending it would be the incident this product just fixed, from
 * the other direction. An unsupported level is replaced by the strongest one
 * the build supports, and the result says so.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSupportedEfforts, makeAgentResult, resolveFixedEffort, versionNumberOf } from '../core.js';
import { describeProbe, readCapabilities, } from './cli-capabilities.js';
export class CodexAdapter {
    options;
    kind = 'codex';
    label = 'Codex';
    capabilities = null;
    /** `codex exec --help`: a subcommand's flags are not in the top-level help. */
    execCapabilities = null;
    /** The installed version, read once, for the reasoning-level check. */
    version;
    controllers = new Set();
    constructor(options) {
        this.options = options;
    }
    /**
     * The environment **every** child of this adapter runs under.
     *
     * This is the whole of block A4: the capability probe, the version read and
     * the health check used to inherit the machine's environment while only
     * `codex exec` got the overlay. On the reported Windows machine that meant
     * `codex --help` still ran with the `OPENSSL_ia32cap` that makes AWS-LC
     * abort before `main`, so the help page came back empty, `exec` was not
     * found on it, and a runnable Codex was declared to have no headless mode.
     * One environment, built once per invocation, for all of them.
     */
    environment(extra) {
        return { ...(this.options.buildEnvironment?.() ?? {}), ...(extra ?? {}) };
    }
    async run(input) {
        const startedAt = new Date().toISOString();
        const executable = await this.options.resolveExecutable();
        // Scratch directory for the structured-output files. Removed in `finally`,
        // so a cancelled or crashed run leaves nothing behind.
        const scratch = mkdtempSync(join(tmpdir(), 'codex-run-'));
        const controller = new AbortController();
        this.controllers.add(controller);
        try {
            const routing = input.routing ?? {
                model: this.options.model ?? null,
                reasoning: this.options.reasoningEffort ?? null,
            };
            // Built before the plan, so the capability probe inside `buildArgs`
            // runs under exactly the environment the real invocation will.
            const env = this.environment(input.env);
            const plan = await this.buildArgs(executable, input.workingDirectory, scratch, routing, env);
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
                executable,
                applied: plan.applied,
                ...(result.error ? { error: result.error } : {}),
            });
        }
        finally {
            this.controllers.delete(controller);
            rmSync(scratch, { recursive: true, force: true });
        }
    }
    async cancel() {
        for (const controller of this.controllers)
            controller.abort();
    }
    async healthCheck() {
        try {
            const executable = await this.options.resolveExecutable();
            const env = this.environment();
            const result = await this.options.processManager.run({
                command: executable,
                args: ['--version'],
                cwd: process.cwd(),
                timeoutMs: 30_000,
                ...(Object.keys(env).length > 0 ? { env } : {}),
            });
            if (result.exitCode !== 0) {
                return { healthy: false, executable, problem: 'O Codex não respondeu como esperado.' };
            }
            return { healthy: true, executable, version: result.stdout.trim().split(/\s+/).pop() ?? '' };
        }
        catch (error) {
            return {
                healthy: false,
                problem: 'O Codex ainda não está configurado.',
                hint: 'Configurar automaticamente',
            };
        }
    }
    /**
     * The reasoning levels the installed build accepts, from its version.
     * Null when the version cannot be read: only the universal levels are
     * then sent.
     */
    async supportedEfforts(cwd = process.cwd()) {
        const executable = await this.options.resolveExecutable();
        return codexSupportedEfforts(await this.readVersion(executable, cwd));
    }
    async readVersion(executable, cwd) {
        if (this.version !== undefined)
            return this.version;
        try {
            const env = this.environment();
            const result = await this.options.processManager.run({
                command: executable,
                args: ['--version'],
                cwd,
                timeoutMs: 30_000,
                ...(Object.keys(env).length > 0 ? { env } : {}),
            });
            this.version = result.exitCode === 0 ? versionNumberOf(result.stdout.trim()) : null;
        }
        catch {
            this.version = null;
        }
        return this.version;
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
    async buildArgs(executable, cwd, scratch, routing, env) {
        this.capabilities ??= await readCapabilities(this.options.processManager, executable, cwd, ['--help'], env);
        // A probe that did not run is not evidence about the CLI. Say which of
        // the two happened, and never spend the second probe on a binary that
        // could not answer the first.
        //
        // `PARSER_FAILED` is the exception, and deliberately so: the binary ran
        // and exited cleanly, we simply could not read the page it printed. That
        // is a question for the CLI (`codex exec --help`, below), not grounds to
        // condemn it here.
        if (this.capabilities.probe.state !== 'OK' && this.capabilities.probe.state !== 'PARSER_FAILED') {
            // Not cached: the next run re-probes rather than repeating a verdict
            // reached while, say, the machine was still holding the file open.
            const probe = this.capabilities.probe;
            this.capabilities = null;
            throw CodexCapabilityError.fromProbe(executable, probe);
        }
        this.execCapabilities ??= await readCapabilities(this.options.processManager, executable, cwd, ['exec', '--help'], env);
        // `exec` is confirmed by either page. The top-level list is one parser's
        // reading of one layout; `codex exec --help` answering at all is the CLI
        // itself saying the subcommand exists. Requiring both would make a help
        // layout change look like a missing feature - which is the bug this
        // block exists to stop repeating.
        const execOnTopLevel = this.capabilities.subcommands.has('exec');
        const execAnswers = this.execCapabilities.probe.state === 'OK';
        if (!execOnTopLevel && !execAnswers) {
            const probe = this.execCapabilities.probe;
            this.execCapabilities = null;
            if (probe.state === 'PROBE_FAILED' || probe.state === 'PARSER_FAILED') {
                throw new CodexCapabilityError('CAPABILITY_UNSUPPORTED', 'Esta versão do Codex não oferece um modo não interativo compatível.', `o executável respondeu, mas não oferece o subcomando "exec" (${describeProbe(probe)})`, executable);
            }
            throw CodexCapabilityError.fromProbe(executable, probe);
        }
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
        const applied = { model: null, reasoning: null, fallbackUsed: false, note: null };
        const notes = [];
        // The team's model and reasoning level, only on builds whose `exec` takes
        // them. codex-cli 0.153.0 offers `-m/--model` and `-c/--config key=value`,
        // and `model_reasoning_effort` is a documented config key. The value is
        // quoted so the CLI's TOML reader takes it as the string it is.
        if (routing.model) {
            if (this.execCapabilities.flags.has('--model')) {
                args.push('--model', routing.model);
                applied.model = routing.model;
            }
            else {
                applied.fallbackUsed = true;
                notes.push('esta versão do Codex não aceita --model');
            }
        }
        if (routing.reasoning) {
            if (this.execCapabilities.flags.has('--config')) {
                const supported = codexSupportedEfforts(await this.readVersion(executable, cwd));
                const resolved = resolveFixedEffort(routing.reasoning, supported);
                if (resolved.value) {
                    args.push('--config', `model_reasoning_effort="${resolved.value}"`);
                    applied.reasoning = resolved.value;
                }
                if (resolved.fallbackUsed) {
                    applied.fallbackUsed = true;
                    if (resolved.note)
                        notes.push(resolved.note);
                }
            }
            else {
                applied.fallbackUsed = true;
                notes.push('esta versão do Codex não aceita --config');
            }
        }
        applied.note = notes.length > 0 ? notes.join('; ') : null;
        let lastMessagePath = null;
        if (this.execCapabilities.flags.has('--output-last-message')) {
            lastMessagePath = join(scratch, 'last-message.txt');
            args.push('--output-last-message', lastMessagePath);
        }
        return { args, lastMessagePath, applied };
    }
}
/** Reads a file the CLI may or may not have written. Absence is not an error. */
function readIfPresent(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
}
/** The sentence a person reads, per reason. */
const REASON_MESSAGE = {
    CAPABILITY_UNSUPPORTED: 'Esta versão do Codex não oferece um modo não interativo compatível.',
    PROBE_FAILED: 'O Codex não respondeu à verificação de recursos.',
    PROBE_TIMEOUT: 'O Codex não respondeu à verificação de recursos dentro do tempo previsto.',
    EXECUTABLE_INCOMPATIBLE: 'O Codex instalado não conseguiu iniciar neste computador.',
    EXECUTABLE_NOT_FOUND: 'O executável do Codex não foi encontrado.',
    PROCESS_ABORTED: 'A verificação do Codex foi interrompida antes de terminar.',
    PARSER_FAILED: 'O Codex respondeu de uma forma que este aplicativo ainda não sabe ler.',
};
/** How a probe state maps onto the reason a run is refused. */
const REASON_OF_PROBE = {
    EXECUTABLE_NOT_FOUND: 'EXECUTABLE_NOT_FOUND',
    PROBE_TIMEOUT: 'PROBE_TIMEOUT',
    PROCESS_ABORTED: 'PROCESS_ABORTED',
    EXECUTABLE_INCOMPATIBLE: 'EXECUTABLE_INCOMPATIBLE',
    PROBE_FAILED: 'PROBE_FAILED',
    PARSER_FAILED: 'PARSER_FAILED',
};
export class CodexCapabilityError extends Error {
    reason;
    diagnosis;
    executable;
    userMessage;
    constructor(reason, message, 
    /** The evidence: what ran, how it ended, what it printed. */
    diagnosis = null, executable = null) {
        super(diagnosis ? `${message} (${diagnosis})` : message);
        this.reason = reason;
        this.diagnosis = diagnosis;
        this.executable = executable;
        this.name = 'CodexCapabilityError';
        this.userMessage = diagnosis ? `${message} Detalhe: ${diagnosis}.` : message;
    }
    /** Builds the error a failed probe deserves, never the capability verdict. */
    static fromProbe(executable, probe) {
        const reason = probe.state === 'OK' ? 'CAPABILITY_UNSUPPORTED' : REASON_OF_PROBE[probe.state];
        return new CodexCapabilityError(reason, REASON_MESSAGE[reason], describeProbe(probe), executable);
    }
}
//# sourceMappingURL=codex-adapter.js.map