import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { DiffDialog, RunDetailDialog } from "@/components/orch/RunDialogs";
import { SectionLabel, StatusPill } from "@/components/orch/primitives";
import { runStateOf, spanBetween } from "@/lib/timeline";
import { api, messageOf } from "@/lib/api";
import { Link } from "@/router";
import type { RunView, WorkspaceView } from "@shared/ipc-contract";

/**
 * Run history, exactly as approved.
 *
 * Same page frame, same run card, same status pill. The rows are this
 * workspace's real sessions and the run each one produced, read back over the
 * bridge - there is no separate history store.
 */
export function HistoryPage({ workspace }: { workspace: WorkspaceView | null }) {
  const [rows, setRows] = useState<{ run: RunView; title: string; archived: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState(false);
  const [detailRun, setDetailRun] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!workspace) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        // The history is the runs table itself, newest first. A run whose
        // conversation was deleted is still here, under its own objective.
        const [runs, sessions] = await Promise.all([
          api.run.list({ workspaceId: workspace.id }),
          api.chat.listSessions({ workspaceId: workspace.id, includeArchived: true }),
        ]);
        const byId = new Map(sessions.map((s) => [s.id, s]));
        const built = runs.map((run) => {
          const session = byId.get(run.sessionId);
          return {
            run,
            title: session?.title ?? run.objective.split("\n")[0]?.slice(0, 80) ?? run.id,
            archived: session?.archivedAt !== null && session?.archivedAt !== undefined,
          };
        });
        if (alive) {
          setRows(built);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(messageOf(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspace]);

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
          Projeto: {workspace?.name ?? "nenhum"}
        </p>

        <div className="mt-8">
          <SectionLabel>Runs</SectionLabel>
          <div className="mt-3 space-y-2">
            {rows.map(({ run, title, archived }) => (
              <div
                key={run.id}
                className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong"
                data-testid={`history-${run.id}`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-medium">{title}</span>
                  {archived && (
                    <span className="text-[11px] text-muted-foreground">arquivada</span>
                  )}
                  <StatusPill state={runStateOf(run, null)} />
                  <span className="ml-auto text-xs text-muted-foreground">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <span>{run.iterations} iterações</span>
                  <span className="font-mono">{spanBetween(run.startedAt, run.finishedAt)}</span>
                  <span className="font-mono">{workspace?.branch ?? "—"}</span>
                  <button onClick={() => setDiff(true)} className="text-primary hover:underline">
                    Ver alterações atuais
                  </button>
                  <button
                    onClick={() => setDetailRun(run.id)}
                    className="text-primary hover:underline"
                    data-testid={`history-detail-${run.id}`}
                  >
                    Detalhes
                  </button>
                </div>
                {run.summary && (
                  <p className="mt-2 text-sm text-foreground/85">{run.summary}</p>
                )}
              </div>
            ))}
            {!loading && rows.length === 0 && (
              <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
                {workspace
                  ? "Nenhuma execução registrada para este projeto."
                  : "Escolha um projeto para ver o histórico."}
              </p>
            )}
            {error && (
              <p className="rounded-lg border border-danger/30 bg-danger/[0.07] p-4 text-sm text-danger">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>

      <DiffDialog open={diff} onOpenChange={setDiff} workspace={workspace} />
      <RunDetailDialog runId={detailRun} onOpenChange={(v) => !v && setDetailRun(null)} />
    </div>
  );
}
