/**
 * Real run data, in the shape the approved timeline draws.
 *
 * `TimelineEntry` is the prototype's discriminated union, unchanged - the
 * Timeline component still renders exactly the same cards. What changed is
 * where the entries come from: the prototype generated them on a timer, this
 * builds them from the run, its steps, its agent invocations, its verification
 * results and its git evidence.
 *
 * Two rules run through the whole file:
 *   - a number that was not measured is not shown;
 *   - a card that has no data is not emitted at all.
 */

import type {
  AgentInvocationView,
  GitContextView,
  MessageView,
  RunDetailView,
  RunStepView,
  VerificationResultView,
} from "@shared/ipc-contract";
import type { Agent, Provider, RunState } from "./orchestrator-data";

export type Check = { label: string; passed: boolean };

export type TimelineEntry =
  | { kind: "user"; id: string; text: string; time: string }
  | {
      kind: "agent";
      id: string;
      agent: Agent;
      duration: string;
      headline: string;
      lines: string[];
      stats?: { label: string; value: string }[];
      detail?: boolean;
      running?: boolean;
    }
  | {
      kind: "verification";
      id: string;
      checks: Check[];
      testsPassed: number;
      testsTotal: number;
    }
  | {
      kind: "evidence";
      id: string;
      filesChanged: number;
      additions: number;
      deletions: number;
      head: string;
    }
  | { kind: "iteration"; id: string; index: number }
  | {
      kind: "humanReview";
      id: string;
      reason: string;
      reasonKind: string;
      progress: string[];
      recommendation: string;
      options: string[];
    }
  | { kind: "doneGate"; id: string; checks: Check[] }
  | {
      kind: "done";
      id: string;
      objective: string;
      result: string;
      iterations: number;
      time: string;
      files: string;
      diff: string;
      tests: string;
      criteria: string;
      branch: string;
    }
  | { kind: "cancelled"; id: string; summary: string[] }
  | { kind: "noProgress"; id: string; detail: string }
  | { kind: "paused"; id: string; iteration: number };

// -- Formatting -------------------------------------------------------------

export function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** A measured duration, or an em dash. Never an estimate. */
function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Wall-clock span between two timestamps, in the done card's format. */
export function spanBetween(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  return formatDuration(end - start);
}

export function elapsedSeconds(startIso: string, endIso: string | null): number {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 1000);
}

// -- Invocation -> agent identity -------------------------------------------

const ROLE_LABELS: Record<string, string> = {
  ORCHESTRATOR: "ORCHESTRATOR",
  CODING_WORKER: "CODING WORKER",
  "CODING WORKER": "CODING WORKER",
  REVIEW: "REVIEW",
  REVIEWER: "REVIEW",
  IMAGE_GENERATOR: "IMAGE GENERATOR",
};

function providerOf(value: string | null): Provider {
  if (value === "openai" || value === "anthropic" || value === "github") return value;
  if (value === "google") return "gemini";
  return "openai";
}

export function agentOf(invocation: AgentInvocationView): Agent {
  return {
    role: ROLE_LABELS[invocation.role] ?? invocation.role,
    provider: providerOf(invocation.providerId),
    // The agent's registered name, or the role's own name. Never a vendor
    // product name the application has not actually been told to use.
    agent: invocation.agentName ?? invocation.role,
    account: invocation.accountName,
    model: invocation.model,
    reasoning: invocation.reasoning,
  };
}

// -- Verification -----------------------------------------------------------

function verificationEntries(
  results: VerificationResultView[],
  iteration: number,
): TimelineEntry | null {
  const forIteration = results.filter((r) => r.iteration === iteration);
  if (forIteration.length === 0) return null;
  return {
    kind: "verification",
    id: `verification-${iteration}`,
    checks: forIteration.map((r) => ({ label: r.label, passed: r.passed })),
    testsPassed: forIteration.filter((r) => r.passed).length,
    testsTotal: forIteration.length,
  };
}

// -- Steps ------------------------------------------------------------------

/** The steps of one iteration, as the activity panel lists them. */
export function stepsOfRun(detail: RunDetailView): {
  label: string;
  status: "done" | "failed" | "running" | "pending";
  time: string;
}[] {
  return detail.steps.map((step) => ({
    label: step.summary ?? step.phase,
    status:
      step.status === "running"
        ? "running"
        : step.status === "failed"
          ? "failed"
          : step.status === "passed" || step.status === "done"
            ? "done"
            : "pending",
    time: step.finishedAt ? spanBetween(step.startedAt, step.finishedAt) : step.status === "running" ? "running" : "—",
  }));
}

function evidenceEntry(git: GitContextView | null, iteration: number): TimelineEntry | null {
  // Emitted only when git actually reported a repository. No repository means
  // no evidence card, rather than a card full of zeros.
  if (!git || !git.isRepository || !git.head) return null;
  return {
    kind: "evidence",
    id: `evidence-${iteration}`,
    filesChanged: git.changedFiles,
    additions: git.additions,
    deletions: git.deletions,
    head: git.head,
  };
}

// -- The builder ------------------------------------------------------------

/**
 * Builds the timeline for one run.
 *
 * Order follows the loop the product is built around:
 * user message -> per iteration (agents -> evidence -> verification) ->
 * terminal card for whatever the run's real status is.
 */
export function buildTimeline(detail: RunDetailView | null): TimelineEntry[] {
  if (!detail) return [];

  const entries: TimelineEntry[] = [];
  const { run, invocations, verifications, messages, steps } = detail;

  const userMessages = messages.filter((m) => m.kind === "USER_MESSAGE");
  if (userMessages.length > 0) {
    for (const message of userMessages) {
      entries.push({
        kind: "user",
        id: message.id,
        text: message.body,
        time: clockTime(message.createdAt),
      });
    }
  } else {
    // A run always has an objective even when its chat history was pruned.
    entries.push({
      kind: "user",
      id: `${run.id}-objective`,
      text: run.objective,
      time: clockTime(run.startedAt),
    });
  }

  const iterations = new Set<number>();
  for (const invocation of invocations) iterations.add(invocation.iteration);
  for (const result of verifications) iterations.add(result.iteration);
  for (const step of steps) if (step.iteration > 0) iterations.add(step.iteration);

  for (const iteration of [...iterations].sort((a, b) => a - b)) {
    if (iteration > 0) {
      // The real iteration number from the run, never a counter of our own.
      entries.push({ kind: "iteration", id: `iteration-${iteration}`, index: iteration });
    }

    for (const invocation of invocations.filter((i) => i.iteration === iteration)) {
      const running = invocation.outcome === "running";
      const entry: Extract<TimelineEntry, { kind: "agent" }> = {
        kind: "agent",
        id: invocation.id,
        agent: agentOf(invocation),
        duration: running ? "…" : formatDuration(invocation.durationMs),
        headline: invocation.task ?? invocation.role,
        lines: [],
        detail: true,
      };
      if (running) entry.running = true;
      entries.push(entry);
    }

    const evidence = evidenceEntry(detail.git, iteration);
    if (evidence && iteration === Math.max(...iterations)) entries.push(evidence);

    const verification = verificationEntries(verifications, iteration);
    if (verification) entries.push(verification);
  }

  // -- Terminal card ---------------------------------------------------------

  const terminal = terminalEntry(detail);
  if (terminal) entries.push(terminal);

  return entries;
}

function terminalEntry(detail: RunDetailView): TimelineEntry | null {
  const { run, verifications, git } = detail;

  switch (run.status as RunState) {
    case "NEEDS_HUMAN": {
      const decisions = detail.messages.filter((m) => m.kind === "HUMAN_REVIEW");
      // Once a decision has been recorded the card has served its purpose.
      if (decisions.length > 0) return null;
      return {
        kind: "humanReview",
        id: `${run.id}-human`,
        reason: run.terminationReason ?? "Uma decisão humana é necessária para continuar.",
        reasonKind: "Decisão necessária",
        progress: progressOf(detail),
        recommendation:
          run.terminationReason ??
          "Revise o que já foi registrado e decida como a execução deve seguir.",
        options: ["Continuar assim mesmo", "Escrever instrução", "Revisar comigo"],
      };
    }

    case "PAUSED":
      return { kind: "paused", id: `${run.id}-paused`, iteration: run.iteration };

    case "CANCELLED":
      return {
        kind: "cancelled",
        id: `${run.id}-cancelled`,
        summary: [
          run.terminationReason ?? "Execução interrompida pelo usuário.",
          ...progressOf(detail),
        ],
      };

    case "DONE": {
      const passed = verifications.filter((v) => v.passed).length;
      return {
        kind: "done",
        id: `${run.id}-done`,
        objective: run.objective,
        result: run.terminationReason ?? "Concluído e verificado.",
        iterations: run.iteration,
        time: spanBetween(run.startedAt, run.finishedAt),
        files: git?.isRepository ? String(git.changedFiles) : "—",
        diff: git?.isRepository ? `+${git.additions} / -${git.deletions}` : "—",
        tests: verifications.length > 0 ? `${passed}/${verifications.length}` : "—",
        criteria: verifications.length > 0 ? `${passed}/${verifications.length}` : "—",
        branch: run.baselineBranch ?? git?.branch ?? "—",
      };
    }

    case "FAILED":
      return {
        kind: "noProgress",
        id: `${run.id}-failed`,
        detail: run.terminationReason ?? "A execução falhou.",
      };

    default:
      return null;
  }
}

/** Facts already established, as short phrases. Only measured ones. */
function progressOf(detail: RunDetailView): string[] {
  const out: string[] = [];
  const done = detail.steps.filter((s) => s.status === "passed" || s.status === "done").length;
  if (done > 0) out.push(`${done} etapa${done === 1 ? "" : "s"} concluída${done === 1 ? "" : "s"}`);
  if (detail.invocations.length > 0) out.push(`${detail.invocations.length} invocação(ões) de agente`);
  const passed = detail.verifications.filter((v) => v.passed).length;
  if (detail.verifications.length > 0) out.push(`${passed}/${detail.verifications.length} verificações`);
  if (detail.git?.isRepository) out.push(`${detail.git.changedFiles} arquivo(s) alterado(s)`);
  return out;
}

export type { RunStepView, MessageView };
