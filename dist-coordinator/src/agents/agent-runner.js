/**
 * The agent abstraction (spec 5).
 *
 * Codex- and Claude-specific command lines live behind these implementations
 * and nowhere else. The orchestration loop talks only to this interface, which
 * is what keeps spec 53 open: swapping which agent orchestrates and which one
 * works is a matter of passing different runners.
 */
/** Convenience for building an `AgentResult` in mocks and error paths. */
export function makeAgentResult(partial) {
    const finishedAt = partial.finishedAt ?? new Date().toISOString();
    return {
        outcome: 'completed',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: new Date(finishedAt).getTime() - new Date(partial.startedAt).getTime(),
        finishedAt,
        ...partial,
    };
}
//# sourceMappingURL=agent-runner.js.map