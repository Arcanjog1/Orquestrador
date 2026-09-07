import { Check, ChevronRight, Loader2, PanelRightClose, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { runStateMeta, type Agent, type RunState } from "@/lib/orchestrator-data";
import { formatElapsed } from "@/lib/timeline";
import { AgentIdentity, SectionLabel, StatBlock, toneDot } from "./primitives";

export type Step = {
  label: string;
  status: "done" | "failed" | "running" | "pending";
  time: string;
};

/**
 * What the agent running right now is doing.
 *
 * The panel used to show a spinner and a run state, which is why a run that
 * hung and a run that was working looked the same for as long as anyone was
 * willing to wait. These are the three facts that decide whether waiting is
 * reasonable: how long it has been going, how long since it last did anything,
 * and what it is inside.
 *
 * Null means the runtime does not report progress - which is a real answer,
 * and is rendered as such. It is never rendered as "idle": claiming an agent
 * is doing nothing because we cannot see it is the mistake this replaces.
 */
export type Liveness = {
  agentLabel: string;
  elapsedMs: number;
  idleMs: number;
  currentTool: string | null;
  /** How long silence may last before the invocation is stopped, if capped. */
  idleTimeoutMs: number | null;
};

/** The delivery state of the exchange, as counts. */
export type ExchangeCounts = {
  /** Delegations handed over and not yet answered. */
  inFlight: number;
  /** Messages that ran out of attempts. Never zero silently - see below. */
  dead: number;
};

/** Long silence is worth naming; a short pause is not a symptom. */
const IDLE_WORTH_MENTIONING_MS = 15_000;

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * The activity panel, exactly as approved.
 *
 * Width (286), section order, dividers, the pulsing run dot and the step rows
 * are the design's. The prototype filled it with fixed numbers - "7 modified",
 * "236 / 237", "64%" and a six-row step list. Those are gone: the steps are the
 * stages the run actually reported, and a figure the application has not
 * measured is an em dash. The context meter renders only when there is a real
 * measurement, which there is not yet - so it is absent, not approximated.
 */
export function ActivityPanel({
  state,
  iteration,
  elapsed,
  onClose,
  onOpenEvidence,
  currentAgent,
  steps,
  filesChanged,
  tests,
  contextPercent,
  onOpenStep,
  liveness,
  exchange,
  onCancel,
}: {
  state: RunState;
  iteration: number;
  elapsed: number;
  onClose: () => void;
  onOpenEvidence: () => void;
  currentAgent: Agent | null;
  steps: Step[];
  filesChanged: number | null;
  tests: { passed: number; total: number } | null;
  contextPercent: number | null;
  onOpenStep: (index: number) => void;
  /** Live activity of the agent in flight, when its runtime reports any. */
  liveness: Liveness | null;
  /** How the exchange between the agents is going. */
  exchange: ExchangeCounts | null;
  /** Stops the run. Always offered while one is going. */
  onCancel: () => void;
}) {
  const meta = runStateMeta[state];
  const running = !["IDLE", "DONE", "CANCELLED", "FAILED", "PAUSED", "NEEDS_HUMAN"].includes(
    state,
  );

  return (
    <aside className="flex h-full w-[286px] shrink-0 flex-col border-l border-border bg-chrome">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-semibold">Activity</span>
        <button
          onClick={onClose}
          className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Recolher painel de atividade"
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <div>
          <SectionLabel>Run</SectionLabel>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={cn(
                "size-2 rounded-full",
                toneDot[meta.tone],
                running && "pulse-dot",
              )}
            />
            <span className="text-sm">{meta.label}</span>
            {iteration ? (
              <span className="ml-auto text-xs text-muted-foreground">
                Iteração {iteration}
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{meta.hint}</p>
        </div>

        <div className="border-t border-border pt-4">
          <SectionLabel>Agente atual</SectionLabel>
          <div className="mt-2">
            {currentAgent ? (
              <>
                <AgentIdentity agent={currentAgent} />
                <div className="mt-1.5 text-xs text-muted-foreground">
                  Conta: {currentAgent.account ?? "—"}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Nenhum agente em execução.</p>
            )}
          </div>
        </div>

        {running && (
          <div className="border-t border-border pt-4">
            <SectionLabel>Agora</SectionLabel>
            {liveness ? (
              <>
                <p className="mt-2 text-sm">
                  {liveness.agentLabel} · executando há{" "}
                  <span className="font-mono">{duration(liveness.elapsedMs)}</span>
                </p>
                {liveness.currentTool && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Ferramenta: <span className="font-mono">{liveness.currentTool}</span>
                  </p>
                )}
                {liveness.idleMs >= IDLE_WORTH_MENTIONING_MS && (
                  <p
                    className={cn(
                      "mt-1 text-xs",
                      liveness.idleTimeoutMs && liveness.idleMs >= liveness.idleTimeoutMs / 2
                        ? "text-attention"
                        : "text-muted-foreground",
                    )}
                  >
                    Sem atividade há{" "}
                    <span className="font-mono">{duration(liveness.idleMs)}</span>
                    {liveness.idleTimeoutMs
                      ? ` · será interrompido após ${duration(liveness.idleTimeoutMs)} de silêncio`
                      : ""}
                  </p>
                )}
              </>
            ) : (
              // Not "idle". The application cannot see inside this runtime, and
              // saying so is the honest answer; claiming the agent is doing
              // nothing would be a guess dressed as a fact.
              <p className="mt-2 text-xs text-muted-foreground">
                Este runtime não informa progresso durante a execução.
              </p>
            )}
            {exchange && (exchange.inFlight > 0 || exchange.dead > 0) && (
              <p className="mt-2 text-xs text-muted-foreground">
                {exchange.inFlight > 0 && `${exchange.inFlight} delegação(ões) aguardando resposta`}
                {exchange.inFlight > 0 && exchange.dead > 0 && " · "}
                {/* A message that ran out of attempts is named, never dropped
                    quietly: an abandoned result the person never hears about is
                    the failure this whole layer exists to prevent. */}
                {exchange.dead > 0 && (
                  <span className="text-danger">{exchange.dead} sem resposta</span>
                )}
              </p>
            )}
            <button
              onClick={onCancel}
              className="mt-3 w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-foreground/85 transition-colors hover:bg-accent"
            >
              Cancelar execução
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
          <StatBlock
            label="Tempo"
            value={<span className="font-mono text-xs">{formatElapsed(elapsed)}</span>}
          />
          <StatBlock
            label="Files"
            value={filesChanged === null ? "—" : `${filesChanged} modified`}
          />
          <StatBlock label="Tests" value={tests ? `${tests.passed} / ${tests.total}` : "—"} />
          <StatBlock
            label="Context"
            value={contextPercent === null ? "—" : `${contextPercent}%`}
          />
        </div>

        {contextPercent !== null && (
          <div className="border-t border-border pt-4">
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${contextPercent}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {contextPercent < 85 ? "Contexto saudável" : "Contexto alto"} · {contextPercent}%
              utilizado
            </p>
          </div>
        )}

        <div className="border-t border-border pt-4">
          <SectionLabel>Steps</SectionLabel>
          <div className="mt-2 space-y-0.5">
            {steps.map((s, i) => (
              <button
                key={`${s.label}-${i}`}
                onClick={() => onOpenStep(i)}
                className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent"
              >
                {s.status === "done" && <Check className="size-3.5 text-success" />}
                {s.status === "failed" && <X className="size-3.5 text-danger" />}
                {s.status === "running" && (
                  <Loader2 className="size-3.5 animate-spin text-running" />
                )}
                {s.status === "pending" && (
                  <span className="size-3.5 rounded-full border border-border" />
                )}
                <span className="truncate text-sm text-foreground/85">{s.label}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                  {s.time}
                </span>
                <ChevronRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
            {steps.length === 0 && (
              <p className="px-1.5 py-1.5 text-xs text-muted-foreground">
                Nenhuma etapa registrada ainda.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-border p-3">
        <button
          onClick={onOpenEvidence}
          className="w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-foreground/85 transition-colors hover:bg-accent"
        >
          Ver evidências
        </button>
      </div>
    </aside>
  );
}
