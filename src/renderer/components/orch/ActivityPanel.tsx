import { Check, ChevronRight, Loader2, PanelRightClose, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { runStateMeta, type Agent, type RunState } from "@/lib/orchestrator-data";
import { formatElapsed } from "@/lib/timeline";
import { AgentIdentity, SectionLabel, StatBlock, toneDot } from "./primitives";

type Step = { label: string; status: "done" | "failed" | "running" | "pending"; time: string };

/**
 * The activity panel, exactly as approved.
 *
 * Width (286), section order, dividers, the pulsing run dot and the step rows
 * are the design's. The prototype filled it with fixed numbers - "7 modified",
 * "236 / 237", "64%" and a six-row step list. Those are gone: each figure is
 * either measured or shown as an em dash, and the context meter renders only
 * when the application actually has a context measurement, which it does not
 * yet - so it is absent rather than approximated.
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
}: {
  state: RunState;
  iteration: number;
  elapsed: number;
  onClose: () => void;
  onOpenEvidence: () => void;
  /** The agent invoked most recently, or null when none has run. */
  currentAgent: Agent | null;
  steps: Step[];
  filesChanged: number | null;
  tests: { passed: number; total: number } | null;
  /** Context usage, when the application has measured it. */
  contextPercent: number | null;
  onOpenStep: (index: number) => void;
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
