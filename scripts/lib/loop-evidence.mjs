/**
 * Reads what one run left behind, and prints it as a record a person can
 * check line by line.
 *
 * Everything here comes out of the database the loop already writes to -
 * runs, run_steps, agent_invocations, verification_results, messages. Nothing
 * is computed from the agents' own words: the worker's task is the row the
 * loop persisted before invoking it, the verification verdict is the exit
 * code the verifier recorded, and the decision is the step the orchestrator
 * turn wrote. Used by the real-provider smoke so its output is complete.
 *
 * Each turn is labelled with the agent, adapter and account the loop bound it
 * to, looked up from the agents and accounts tables by id. An account is named
 * by its display name and provider only; its profile directory, auth method
 * and anything the CLI keeps inside it stay out of the record.
 *
 * No credential, environment variable or token is read or shown.
 */

const clip = (text, max = 400) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** A plain object; safe to JSON.stringify, safe to assert on. */
export function collectLoopEvidence(database, runId, sessionId) {
  const run = database.runs.require(runId);
  const steps = database.runs.steps(runId);
  const invocations = database.runs.invocations(runId);
  const verifications = database.runs.verifications(runId);
  const messages = database.chat.listMessages(sessionId);

  const workers = invocations.filter((i) => i.role === 'CODING_WORKER');
  const orchestrators = invocations.filter((i) => i.role === 'ORCHESTRATOR');
  const boundTo = (invocation) => describeBinding(database, invocation);
  const decisions = steps.filter((s) => s.phase === 'orchestrator');
  const gate = steps.filter((s) => s.phase === 'done-gate').at(-1) ?? null;

  return {
    run: {
      id: run.id,
      status: run.status,
      iterations: run.iteration,
      summary: run.termination_reason,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
    },
    counts: {
      userMessages: messages.filter((m) => m.author === 'user').length,
      orchestratorInvocations: orchestrators.length,
      workerInvocations: workers.length,
      iterations: new Set(invocations.map((i) => i.iteration)).size,
    },
    // The orchestrator's decisions, one per turn, as the loop recorded them.
    decisions: decisions.map((s) => ({
      iteration: s.iteration,
      outcome: s.status,
      action: s.summary,
    })),
    // Each worker turn: the instruction the loop handed it, and how it ended.
    workerTurns: workers.map((i) => ({
      iteration: i.iteration,
      invocationId: i.id,
      ...boundTo(i),
      prompt: i.task,
      outcome: i.outcome,
      exitCode: i.exit_code,
      durationMs: i.duration_ms,
      startedAt: i.started_at,
      finishedAt: i.finished_at,
    })),
    orchestratorTurns: orchestrators.map((i) => ({
      iteration: i.iteration,
      invocationId: i.id,
      ...boundTo(i),
      outcome: i.outcome,
      exitCode: i.exit_code,
      durationMs: i.duration_ms,
      startedAt: i.started_at,
      finishedAt: i.finished_at,
    })),
    verifications: verifications.map((v) => ({
      iteration: v.iteration,
      command: v.command,
      passed: v.passed === 1,
      exitCode: v.exit_code,
      refused: v.refused,
      durationMs: v.duration_ms,
    })),
    evidenceSteps: steps
      .filter((s) => s.phase === 'evidence')
      .map((s) => ({ iteration: s.iteration, status: s.status, summary: s.summary })),
    doneGate: gate ? { iteration: gate.iteration, verdict: gate.status, detail: gate.summary } : null,
  };
}

/**
 * Which agent, adapter and account an invocation ran under. The loop records
 * the worker's account on the row; the orchestrator's comes from its agent.
 */
function describeBinding(database, invocation) {
  const agent = invocation.agent_id ? database.agents.find(invocation.agent_id) : undefined;
  const accountId = invocation.account_id ?? agent?.account_id ?? null;
  const account = accountId ? database.accounts.find(accountId) : undefined;
  return {
    agent: agent?.display_name ?? null,
    adapter: agent?.adapter_id ?? null,
    account: account ? `${account.display_name} (${account.provider_id})` : null,
  };
}

const binding = (t) => `${t.adapter ?? 'adapter ?'} · ${t.account ?? 'no account bound'}`;

export function printLoopEvidence(evidence, log = console.log) {
  const { run, counts, decisions, workerTurns, orchestratorTurns, verifications, evidenceSteps, doneGate } =
    evidence;
  log('');
  log('LOOP EVIDENCE (read back from the database, not from the agents)');
  log(`  run ${run.id}: ${run.status}${run.summary ? ` - ${clip(run.summary, 160)}` : ''}`);
  log(`  user messages ${counts.userMessages} · orchestrator turns ${counts.orchestratorInvocations} · worker turns ${counts.workerInvocations} · iterations ${counts.iterations}`);
  for (const d of decisions) log(`  codex #${d.iteration}: ${d.outcome} -> ${d.action ?? '(none)'}`);
  for (const t of orchestratorTurns) {
    log(`  codex turn it${t.iteration} ${t.invocationId}: ${t.outcome} exit=${t.exitCode ?? 'null'} ${t.durationMs ?? '?'}ms [${binding(t)}] ${t.startedAt} → ${t.finishedAt ?? '?'}`);
  }
  for (const t of workerTurns) {
    log(`  claude turn it${t.iteration} ${t.invocationId}: ${t.outcome} exit=${t.exitCode ?? 'null'} ${t.durationMs ?? '?'}ms [${binding(t)}] ${t.startedAt} → ${t.finishedAt ?? '?'}`);
    log(`    prompt: ${clip(t.prompt)}`);
  }
  for (const e of evidenceSteps) log(`  evidence it${e.iteration}: ${e.status} (${e.summary ?? ''})`);
  for (const v of verifications) {
    log(`  verification it${v.iteration}: ${v.passed ? 'PASS' : v.refused ? `REFUSED ${v.refused}` : `FAIL exit=${v.exitCode}`} ${v.command}`);
  }
  log(`  done gate: ${doneGate ? `${doneGate.verdict}${doneGate.detail ? ` (${clip(doneGate.detail, 200)})` : ''}` : 'not reached'}`);
}
