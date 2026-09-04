import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { DiffDialog, EvidenceDialog } from "@/components/orch/dialogs";
import { SectionLabel, StatusPill } from "@/components/orch/primitives";
import { runStateOf, spanBetween } from "@/lib/timeline";
import { api, messageOf } from "@/lib/api";
import { Link } from "@/router";
import type { ChatSessionView, RunView, WorkspaceView } from "@shared/ipc-contract";

/**
 * Run history, exactly as approved.
 *
 * Same page frame, same run card, same status pill. The rows are this
 * workspace's real sessions and the run each one produced, read back over the
 * bridge - there is no separate history store.
 */
export function HistoryPage({ workspace }: { workspace: WorkspaceView | null }) {
  const [rows, setRows] = useState<{ session: ChatSessionView; run: RunView | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState(false);
  const [evidence, setEvidence] = useState(false);

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
        const sessions = await api.chat.listSessions({ workspaceId: workspace.id });
        // A session's run is found through its messages: the loop stamps the
        // run id on everything it says.
        const built = await Promise.all(
          sessions.map(async (session) => {
            const messages = await api.chat.listMessages({ sessionId: session.id });
            const runId = [...messages].reverse().find((m) => m.runId)?.runId ?? null;
            if (!runId) return { session, run: null };
            try {
              return { session, run: await api.run.get({ runId }) };
            } catch {
              return { session, run: null };
            }
          }),
        );
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
            {rows.map(({ session, run }) => (
              <div
                key={session.id}
                className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-medium">{session.title}</span>
                  <StatusPill state={runStateOf(run, null)} />
                  <span className="ml-auto text-xs text-muted-foreground">
                    {new Date(session.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <span>{run?.iterations ?? 0} iterações</span>
                  <span className="font-mono">
                    {run ? spanBetween(run.startedAt, run.finishedAt) : "—"}
                  </span>
                  <span className="font-mono">{workspace?.branch ?? "—"}</span>
                  <button onClick={() => setDiff(true)} className="text-primary hover:underline">
                    Ver alterações
                  </button>
                  <button
                    onClick={() => setEvidence(true)}
                    className="text-primary hover:underline"
                  >
                    Ver evidências
                  </button>
                </div>
                {run?.summary && (
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
      <EvidenceDialog open={evidence} onOpenChange={setEvidence} workspace={workspace} />
    </div>
  );
}
