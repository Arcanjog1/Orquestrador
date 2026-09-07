/**
 * Human-readable, tag-prefixed logging (spec 30).
 *
 * Rule: only decisions, tasks, states, evidence and results are printed. Model
 * reasoning is never surfaced, and every line is redacted before it is written
 * to the console or to the run's log file.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from '../security/secret-redactor.js';
export const LOG_TAGS = [
    'START',
    'PREFLIGHT',
    'BASELINE',
    'ORCHESTRATOR',
    'CODEX',
    'WORKER',
    'CLAUDE',
    'EVIDENCE',
    'VERIFY',
    'DONE',
    'BLOCKED',
    'CANCEL',
    'RESUME',
    'STATE',
    'WARN',
    'ERROR',
    'PROFILE',
];
export class Logger {
    options;
    fileReady = false;
    constructor(options = {}) {
        this.options = options;
    }
    /** Attaches (or replaces) the log file. Used once the session dir exists. */
    setFile(filePath) {
        this.options.filePath = filePath;
        this.fileReady = false;
    }
    /**
     * Emits a tagged block:
     *
     *   [CODEX]
     *   Decision: delegate
     */
    log(tag, ...lines) {
        const stamp = this.options.timestamps ? ` ${new Date().toISOString()}` : '';
        const body = lines
            .flatMap((l) => String(l).split('\n'))
            .map((l) => redact(l))
            .join('\n');
        const block = `[${tag}]${stamp}\n${body}\n`;
        if (!this.options.quiet) {
            const stream = tag === 'ERROR' || tag === 'WARN' ? process.stderr : process.stdout;
            stream.write(`${block}\n`);
        }
        this.appendToFile(block);
    }
    /** Prints without a tag block; used for CLI output such as `status`. */
    plain(text) {
        if (!this.options.quiet)
            process.stdout.write(`${redact(text)}\n`);
    }
    warn(...lines) {
        this.log('WARN', ...lines);
    }
    error(...lines) {
        this.log('ERROR', ...lines);
    }
    appendToFile(block) {
        const path = this.options.filePath;
        if (!path)
            return;
        try {
            if (!this.fileReady) {
                mkdirSync(dirname(path), { recursive: true });
                this.fileReady = true;
            }
            appendFileSync(path, `${block}\n`, 'utf8');
        }
        catch {
            // Logging must never take a run down. Console output already happened.
        }
    }
}
/** Logger that swallows everything. Convenient default for library use. */
export const silentLogger = new Logger({ quiet: true });
//# sourceMappingURL=logger.js.map