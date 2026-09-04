import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { DiffDialog, EvidenceDialog } from "@/components/orch/dialogs";
import { SectionLabel, StatusPill } from "@/components/orch/primitives";
import { invoke, useChannel } from "@/lib/bridge";
import { spanBetween } from "@/lib/timeline";
import { Link } from "@/router";
import type { AppStateView, RunDetailView } from "@shared/ipc-contract";

/**
 * Run history, exactly as approved.
 *
 * Same page frame, same run card, same status pill. The rows are the
 * workspace's real runs, and "Ver alterações"/"Ver evidências" open that run's
 * own artifacts and verification results rather than a shared sample.
 */
export function HistoryPage({ state }: { state: AppStateView | null }) {
  const workspace = state?.workspace ?? null;
  const [diff, setDiff] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const [detail, setDetail] = useState<RunDetailView | null>(null);

  const runs = useChannel(
    "runs:list",
    { workspaceId: workspace?.id ?? "" },
    { enabled: !!workspace, refreshOn: ["runs:changed"] },
  );

  const openDetail = async (runId: string, which: "diff" | "evidence") => {
    const loaded = await invoke("runs:detail", { runId });
    setDetail(loaded);
    if (which === "diff") setDiff(true);
    else setEvidence(true);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Voltar ao workspace
        </Link>

        <h1 className="mt-6 text-xl font-semibold tracking-tight">
          Histórico de execuções
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Projeto: {workspace?.displayName ?? "nenhum"}
        </p>

        <div className="mt-8">
          <SectionLabel>Runs</SectionLabel>
          <div className="mt-3 space-y-2">
            {(runs.data ?? []).map((r) => (
              <div
                key={r.id}
                className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-medium">{r.objective}</span>
                  <StatusPill state={r.status} />
                  <span className="ml-auto text-xs text-muted-foreground">
                    {new Date(r.startedAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <span>{r.iteration} iterações</span>
                  <span className="font-mono">{spanBetween(r.startedAt, r.finishedAt)}</span>
                  <span className="font-mono">{r.baselineBranch ?? "—"}</span>
                  <button
                    onClick={() => void openDetail(r.id, "diff")}
                    className="text-primary hover:underline"
                  >
                    Ver alterações
                  </button>
                  <button
                    onClick={() => void openDetail(r.id, "evidence")}
                    className="text-primary hover:underline"
                  >
                    Ver evidências
                  </button>
                </div>
              </div>
            ))}
            {(runs.data ?? []).length === 0 && (
              <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
                {workspace
                  ? "Nenhuma execução registrada para este projeto."
                  : "Escolha um projeto para ver o histórico."}
              </p>
            )}
          </div>
        </div>
      </div>

      <DiffDialog
        open={diff}
        onOpenChange={setDiff}
        artifacts={detail?.artifacts ?? []}
        git={detail?.git ?? null}
      />
      <EvidenceDialog
        open={evidence}
        onOpenChange={setEvidence}
        git={detail?.git ?? null}
        verifications={detail?.verifications ?? []}
      />
    </div>
  );
}
