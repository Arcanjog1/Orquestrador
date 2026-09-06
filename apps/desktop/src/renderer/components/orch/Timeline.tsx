import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FileDiff,
  GitCommitHorizontal,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  Pause,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TimelineEntry } from "@/lib/timeline";
import {
  AgentIdentity,
  CheckRow,
  ProviderIcon,
  SectionLabel,
  StatBlock,
} from "./primitives";

function Node({
  children,
  icon,
  tone = "neutral",
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  tone?: "neutral" | "running" | "success" | "attention" | "danger";
}) {
  const ring = {
    neutral: "border-border bg-surface-raised text-muted-foreground",
    running: "border-running/40 bg-running/12 text-running",
    success: "border-success/40 bg-success/12 text-success",
    attention: "border-attention/40 bg-attention/12 text-attention",
    danger: "border-danger/40 bg-danger/12 text-danger",
  }[tone];

  return (
    <div className="step-in relative flex gap-3 pb-4">
      <div
        className={cn(
          "z-10 grid size-8 shrink-0 place-items-center rounded-full border",
          ring,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function TimelineView({
  entries,
  onResolveHumanReview,
  onOpenDiff,
  onOpenEvidence,
  onOpenDetail,
  onResume,
  onOpenRunDetail,
  onRetry,
}: {
  entries: TimelineEntry[];
  onResolveHumanReview: (option: string) => void;
  onOpenDiff: () => void;
  onOpenEvidence: () => void;
  onOpenDetail: (entry: Extract<TimelineEntry, { kind: "agent" }>) => void;
  onResume: () => void;
  /** Opens the recorded steps and diagnostics of one run. */
  onOpenRunDetail: (runId: string) => void;
  /** Sends the run's objective again, as a new run. */
  onRetry: (runId: string) => void;
}) {
  return (
    <div className="timeline-rail mx-auto w-full max-w-3xl px-6 py-6">
      {entries.map((entry) => (
        <TimelineItem
          key={entry.id}
          entry={entry}
          onResolveHumanReview={onResolveHumanReview}
          onOpenDiff={onOpenDiff}
          onOpenEvidence={onOpenEvidence}
          onOpenDetail={onOpenDetail}
          onResume={onResume}
          onOpenRunDetail={onOpenRunDetail}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

function TimelineItem({
  entry,
  onResolveHumanReview,
  onOpenDiff,
  onOpenEvidence,
  onOpenDetail,
  onResume,
  onOpenRunDetail,
  onRetry,
}: {
  entry: TimelineEntry;
  onResolveHumanReview: (option: string) => void;
  onOpenDiff: () => void;
  onOpenEvidence: () => void;
  onOpenDetail: (entry: Extract<TimelineEntry, { kind: "agent" }>) => void;
  onResume: () => void;
  onOpenRunDetail: (runId: string) => void;
  onRetry: (runId: string) => void;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <Node
          icon={<span className="text-[11px] font-semibold">Você</span>}
          tone="neutral"
        >
          <div className="rounded-lg border border-border bg-surface px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">Você</span>
              <span className="text-xs text-muted-foreground">{entry.time}</span>
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-foreground/90">
              {entry.text}
            </p>
          </div>
        </Node>
      );

    case "iteration":
      return (
        <div className="step-in relative my-3 flex items-center gap-3 pl-1">
          <div className="z-10 rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Iteração {entry.index}
          </div>
          <div className="h-px flex-1 bg-border" />
        </div>
      );

    case "agent": {
      const isRunning = entry.running;
      return (
        <Node
          icon={<ProviderIcon provider={entry.agent.provider} />}
          tone={isRunning ? "running" : "neutral"}
        >
          <div
            className={cn(
              "rounded-lg border bg-surface px-3.5 py-3",
              isRunning ? "border-running/30" : "border-border",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <AgentIdentity agent={entry.agent} />
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {entry.duration}
              </span>
            </div>
            <div className="mt-2.5 text-sm font-medium text-foreground/95">
              {entry.headline}
            </div>
            <div className="mt-1 space-y-1">
              {entry.lines.map((l) => (
                <p key={l} className="text-sm leading-relaxed text-muted-foreground">
                  {l}
                </p>
              ))}
            </div>
            {entry.stats && (
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3">
                {entry.stats.map((s) => (
                  <StatBlock key={s.label} label={s.label} value={s.value} />
                ))}
              </div>
            )}
            {entry.detail && (
              <button
                onClick={() => onOpenDetail(entry)}
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Ver detalhes <ChevronRight className="size-3" />
              </button>
            )}
          </div>
        </Node>
      );
    }

    case "evidence":
      return (
        <Node icon={<GitCommitHorizontal className="size-4" />}>
          <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
            <div className="flex items-center justify-between">
              <SectionLabel>Evidence · Git</SectionLabel>
              <button
                onClick={onOpenEvidence}
                className="text-xs font-medium text-primary hover:underline"
              >
                Ver evidências
              </button>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-8 gap-y-2">
              <StatBlock label="Arquivos" value={`${entry.filesChanged} alterados`} />
              <StatBlock
                label="Diff"
                value={
                  <span className="font-mono text-xs">
                    <span className="text-success">+{entry.additions}</span>{" "}
                    <span className="text-danger">-{entry.deletions}</span>
                  </span>
                }
              />
              <StatBlock
                label="HEAD"
                value={<span className="font-mono text-xs">{entry.head}</span>}
              />
            </div>
          </div>
        </Node>
      );

    case "verification": {
      const failed = entry.checks.some((c) => !c.passed);
      return (
        <Node
          icon={<ShieldCheck className="size-4" />}
          tone={failed ? "danger" : "success"}
        >
          <div
            className={cn(
              "rounded-lg border bg-surface px-3.5 py-3",
              failed ? "border-danger/30" : "border-success/25",
            )}
          >
            <div className="flex items-center justify-between">
              <SectionLabel>Verification</SectionLabel>
              <span
                className={cn(
                  "font-mono text-[11px]",
                  failed ? "text-danger" : "text-success",
                )}
              >
                {entry.testsPassed} / {entry.testsTotal} testes
              </span>
            </div>
            <div className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
              {entry.checks.map((c) => (
                <CheckRow key={c.label} label={c.label} passed={c.passed} />
              ))}
            </div>
          </div>
        </Node>
      );
    }

    case "doneGate":
      return (
        <Node icon={<CircleCheck className="size-4" />} tone="running">
          <div className="rounded-lg border border-running/30 bg-running/[0.06] px-3.5 py-3">
            <SectionLabel>Final check</SectionLabel>
            <div className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
              {entry.checks.map((c) => (
                <CheckRow key={c.label} label={c.label} passed={c.passed} />
              ))}
            </div>
            <div className="shimmer mt-3 h-0.5 rounded-full bg-border" />
            <div className="mt-2 text-xs text-running">Concluindo…</div>
          </div>
        </Node>
      );

    case "humanReview":
      return (
        <Node icon={<TriangleAlert className="size-4" />} tone="attention">
          <div className="rounded-xl border border-attention/40 bg-attention/[0.07] p-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-attention">
                Revisão humana necessária
              </span>
              <span className="rounded-md bg-attention/15 px-1.5 py-0.5 text-[11px] text-attention">
                {entry.reasonKind}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-foreground/90">
              {entry.reason}
            </p>

            <div className="mt-3.5">
              <SectionLabel>O que já foi feito</SectionLabel>
              <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                {entry.progress.map((p) => (
                  <span key={p}>{p}</span>
                ))}
              </div>
            </div>

            <div className="mt-3.5 rounded-lg border border-border bg-surface p-3">
              <SectionLabel>Recomendação do orquestrador</SectionLabel>
              <p className="mt-1.5 text-sm leading-relaxed text-foreground/90">
                {entry.recommendation}
              </p>
            </div>

            <div className="mt-3.5 flex flex-wrap gap-2">
              {entry.options.map((o, i) => (
                <Button
                  key={o}
                  size="sm"
                  variant={i === 0 ? "default" : o === "Cancelar" ? "ghost" : "secondary"}
                  onClick={() => onResolveHumanReview(o)}
                  data-testid={`human-review-${i}`}
                >
                  {o}
                </Button>
              ))}
              <Button size="sm" variant="ghost" className="text-danger hover:text-danger">
                Cancelar tarefa
              </Button>
            </div>
          </div>
        </Node>
      );

    case "noProgress":
      return (
        <Node icon={<TriangleAlert className="size-4" />} tone="attention">
          <div className="rounded-lg border border-attention/35 bg-attention/[0.07] p-3.5">
            <div className="text-sm font-semibold text-attention">
              Sem progresso detectado
            </div>
            <p className="mt-1.5 text-sm text-foreground/90">{entry.detail}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => onRetry(entry.runId)}>
                Tentar novamente
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onOpenRunDetail(entry.runId)}>
                Detalhes
              </Button>
            </div>
          </div>
        </Node>
      );

    case "failed":
      return (
        <Node icon={<TriangleAlert className="size-4" />} tone="danger">
          <div
            className="rounded-lg border border-danger/35 bg-danger/[0.06] p-3.5"
            data-testid="run-failed-card"
          >
            <div className="text-sm font-semibold text-danger">{entry.title}</div>
            <p className="mt-1.5 text-sm text-foreground/90">{entry.detail}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onOpenRunDetail(entry.runId)}
                data-testid="run-failed-details"
              >
                Detalhes
              </Button>
              {entry.failureKind !== "readiness" && (
                <Button size="sm" variant="ghost" onClick={() => onRetry(entry.runId)}>
                  Tentar novamente
                </Button>
              )}
            </div>
          </div>
        </Node>
      );

    case "paused":
      return (
        <Node icon={<Pause className="size-4" />} tone="attention">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-attention/35 bg-attention/[0.07] px-3.5 py-3">
            <span className="text-sm text-foreground/90">
              Execução pausada após a iteração {entry.iteration}.
            </span>
            <Button size="sm" className="ml-auto" onClick={onResume}>
              <Play className="size-3.5" /> Continuar
            </Button>
          </div>
        </Node>
      );

    case "cancelled":
      return (
        <Node icon={<Square className="size-3.5" />} tone="neutral">
          <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
            <div className="text-sm font-semibold text-muted-foreground">
              Execução cancelada
            </div>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {entry.summary.map((s) => (
                <li key={s}>· {s}</li>
              ))}
            </ul>
          </div>
        </Node>
      );

    case "done":
      return (
        <Node icon={<Sparkles className="size-4" />} tone="success">
          <div className="rounded-xl border border-success/35 bg-success/[0.06] p-4">
            <div className="flex items-center gap-2">
              <CircleCheck className="size-4 text-success" />
              <span className="text-sm font-semibold text-success">Tarefa concluída</span>
            </div>
            <div className="mt-3">
              <SectionLabel>Objetivo</SectionLabel>
              <p className="mt-1 text-sm text-foreground/90">{entry.objective}</p>
              <p className="mt-2 text-sm text-muted-foreground">{entry.result}</p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 border-t border-success/20 pt-3 sm:grid-cols-4">
              <StatBlock label="Iterações" value={entry.iterations} />
              <StatBlock label="Tempo" value={entry.time} />
              <StatBlock label="Arquivos" value={entry.files} />
              <StatBlock
                label="Diff"
                value={<span className="font-mono text-xs">{entry.diff}</span>}
              />
              <StatBlock label="Testes" value={`✓ ${entry.tests}`} />
              <StatBlock label="Acceptance" value={`✓ ${entry.criteria}`} />
              <StatBlock
                label="Branch"
                value={<span className="font-mono text-xs">{entry.branch}</span>}
              />
              <StatBlock label="Agentes" value="Codex · Claude" />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" onClick={onOpenDiff}>
                <FileDiff className="size-3.5" /> Ver alterações
              </Button>
              <Button size="sm" variant="secondary" onClick={onOpenEvidence}>
                Ver evidências
              </Button>
            </div>
          </div>
        </Node>
      );
  }
}

export function CollapsedIterations({ items }: { items: { index: number; steps: number }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-1.5 px-6 pt-6">
      {items.map((it) => (
        <button
          key={it.index}
          onClick={() => setOpen(open === it.index ? null : it.index)}
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent"
        >
          {open === it.index ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <span className="font-mono text-[11px] tracking-[0.14em] uppercase">
            Iteração {it.index}
          </span>
          <span className="ml-auto text-xs text-success">✓ {it.steps} etapas</span>
        </button>
      ))}
    </div>
  );
}
