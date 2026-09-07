/**
 * final-report.md generation (spec 44).
 *
 * Written whenever a run reaches a terminal status - DONE, BLOCKED, CANCELLED
 * or FAILED - so there is always a human-readable record of what happened and
 * what evidence backs it.
 */
import { describeStatus } from '../core/run-state.js';
import { commandPassed } from '../orchestrator/verifier.js';
export function buildFinalReport(input) {
    const { state, finalEvidence } = input;
    const lines = [];
    lines.push(`# Final report - ${state.runId}`, '');
    lines.push('## Objective', '', state.objective.trim() || '(empty)', '');
    lines.push('## Status', '', `**${state.status}** - ${describeStatus(state.status)}`, '', `- Started: ${state.createdAt}`, `- Finished: ${state.finishedAt ?? '(not finished)'}`, `- Duration: ${formatDuration(state.createdAt, state.finishedAt ?? state.updatedAt)}`, `- Mode: ${state.mode === 'mock' ? 'mock agents' : 'real agent CLIs'}`, `- Project: ${state.projectPath}`);
    if (state.terminationReason)
        lines.push(`- Reason: ${state.terminationReason}`);
    lines.push('');
    lines.push('## Iterations', '', `${state.iteration} of a maximum ${state.maxIterations}.`, '');
    if (state.iterations.length === 0) {
        lines.push('No iteration was recorded.', '');
    }
    else {
        lines.push('| # | Decision | Worker | Verification | Notes |', '|---|---|---|---|---|');
        for (const it of state.iterations) {
            const decision = it.decision?.action ?? (it.decisionError ? 'invalid output' : '-');
            const worker = it.worker
                ? `${it.worker.agent}${it.worker.profile ? ` (${it.worker.profile})` : ''} exit ${it.worker.exitCode}`
                : '-';
            const verification = it.verification?.length
                ? `${it.verification.filter(commandPassed).length}/${it.verification.length} passed`
                : '-';
            const notes = [
                it.doneRejection ? 'DONE rejected' : '',
                it.decisionRepairAttempts > 0 ? `${it.decisionRepairAttempts} format repair(s)` : '',
                ...it.notes,
            ]
                .filter(Boolean)
                .join('; ');
            lines.push(`| ${it.iteration} | ${decision} | ${worker} | ${verification} | ${escapeCell(notes)} |`);
        }
        lines.push('');
    }
    lines.push('## Claude profiles used', '');
    const profiles = new Set(state.iterations.map((it) => it.worker?.profile).filter((p) => Boolean(p)));
    if (state.claudeProfile)
        profiles.add(state.claudeProfile);
    lines.push(profiles.size ? [...profiles].map((p) => `- ${p}`).join('\n') : '- (none)', '');
    lines.push('## Files changed', '');
    if (!finalEvidence) {
        lines.push('Final evidence could not be collected.', '');
    }
    else if (!finalEvidence.isGitRepository) {
        lines.push('The project is not a git repository, so no file evidence was collected.', '');
    }
    else if (finalEvidence.changedFiles.length === 0) {
        lines.push('No file changed relative to the baseline.', '');
    }
    else {
        lines.push(...finalEvidence.changedFiles.map((f) => `- ${f}`), '');
        if (finalEvidence.addedFiles.length) {
            lines.push('Added:', ...finalEvidence.addedFiles.map((f) => `- ${f}`), '');
        }
        if (finalEvidence.deletedFiles.length) {
            lines.push('Deleted:', ...finalEvidence.deletedFiles.map((f) => `- ${f}`), '');
        }
        if (finalEvidence.diffStat.trim()) {
            lines.push('```', finalEvidence.diffStat.trim(), '```', '');
        }
    }
    lines.push('## Tests executed', '');
    const allResults = state.iterations.flatMap((it) => it.verification ?? []);
    const gateResults = lastDoneGateResults(state);
    const results = gateResults.length ? gateResults : allResults;
    if (results.length === 0) {
        lines.push('No verification command was run.', '');
    }
    else {
        lines.push('| Command | Exit | Duration | Result |', '|---|---|---|---|');
        for (const r of results) {
            lines.push(`| \`${escapeCell(r.command)}\` | ${r.exitCode ?? '-'} | ${formatMs(r.durationMs)} | ${describeResult(r)} |`);
        }
        lines.push('');
    }
    lines.push('## Acceptance criteria', '');
    if (state.criteria.length === 0) {
        lines.push('The orchestrator never stated an acceptance criterion.', '');
    }
    else {
        for (const c of state.criteria) {
            const mark = c.status === 'satisfied' ? 'x' : ' ';
            const suffix = c.status === 'failed' ? ' **(failed)**' : c.status === 'unknown' ? ' *(no evidence)*' : '';
            lines.push(`- [${mark}] ${c.text}${suffix}${c.note ? ` - ${c.note}` : ''}`);
        }
        lines.push('');
    }
    lines.push('## Evidence', '');
    lines.push(`Per-iteration evidence, prompts and raw agent output are under \`iterations/\` in this run's`, 'directory. Each iteration holds `evidence.json`, `git-diff.patch`, `git-status.txt` and', '`tests.json`, all collected by the orchestrator rather than reported by an agent.', '');
    lines.push('## Remaining warnings', '');
    const warnings = [...input.warnings];
    if (state.baseline?.dirty) {
        warnings.push('The working tree already had uncommitted changes before this run started. They were ' +
            'preserved, but the diff above mixes them with the run\'s own changes.');
    }
    if (state.workerInterrupted) {
        warnings.push('A worker task was interrupted; its completion could not be determined.');
    }
    lines.push(warnings.length ? warnings.map((w) => `- ${w}`).join('\n') : '- (none)', '');
    lines.push('## Baseline commit', '');
    if (!state.baseline) {
        lines.push('No baseline was captured.', '');
    }
    else {
        lines.push(`- Commit: ${state.baseline.commit ?? '(no commits yet)'}`, `- Branch: ${state.baseline.branch ?? '(detached or unborn)'}`, `- Captured: ${state.baseline.capturedAt}`, `- Working tree at start: ${state.baseline.dirty ? 'dirty' : 'clean'}`, '');
    }
    lines.push('## Final git status', '');
    if (finalEvidence?.statusShort.trim()) {
        lines.push('```', finalEvidence.statusShort.trimEnd(), '```', '');
    }
    else if (finalEvidence) {
        lines.push('Clean working tree.', '');
    }
    else {
        lines.push('Not available.', '');
    }
    lines.push('---', '', 'Nothing was committed, pushed or merged: the MVP never does that on its own (spec 34).', '');
    return lines.join('\n');
}
function lastDoneGateResults(state) {
    for (let i = state.iterations.length - 1; i >= 0; i -= 1) {
        const gate = state.iterations[i]?.doneRejection;
        if (gate)
            return gate.verification;
    }
    return [];
}
function describeResult(result) {
    if (result.refused)
        return `refused - ${result.refused}`;
    if (result.timedOut)
        return 'timed out';
    return result.exitCode === 0 ? 'passed' : 'failed';
}
function escapeCell(text) {
    return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function formatMs(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
export function formatDuration(startIso, endIso) {
    const ms = Math.max(0, new Date(endIso).getTime() - new Date(startIso).getTime());
    const totalSeconds = Math.floor(ms / 1000);
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}
//# sourceMappingURL=final-report.js.map