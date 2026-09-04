import { useEffect, useMemo, useRef, useState } from "react";
import { PanelRightOpen, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AppSidebar } from "@/components/orch/AppSidebar";
import { TopContextBar } from "@/components/orch/TopContextBar";
import { TimelineView } from "@/components/orch/Timeline";
import { ActivityPanel } from "@/components/orch/ActivityPanel";
import { Composer } from "@/components/orch/Composer";
import {
  AgentDetailDialog,
  CancelDialog,
  CommandPalette,
  DiffDialog,
  EvidenceDialog,
  TeamDialog,
} from "@/components/orch/dialogs";
import { suggestions, type Agent, type RunState } from "@/lib/orchestrator-data";
import {
  agentOf,
  buildTimeline,
  elapsedSeconds,
  stepsOfRun,
  type TimelineEntry,
} from "@/lib/timeline";
import { invoke, useChannel } from "@/lib/bridge";
import { Link, useRouter } from "@/router";
import type { AppStateView, RunDetailView } from "@shared/ipc-contract";

/**
 * The workspace, exactly as approved.
 *
 * Layout, panel order, the xl breakpoint on the activity panel, the collapse
 * button and the keyboard shortcuts are the design's. Everything it shows is
 * the real run: the timeline is built from the run's steps, invocations,
 * verifications and git evidence, and the composer starts a real run.
 */
export function WorkspacePage({
  state,
  reloadState,
}: {
  state: AppStateView | null;
  reloadState: () => void;
}) {
  const router = useRouter();
  const workspace = state?.workspace ?? null;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const [diffOpen, setDiffOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [detailEntry, setDetailEntry] = useState<Extract<TimelineEntry, { kind: "agent" }> | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const run = useChannel(
    "runs:active",
    { workspaceId: workspace?.id ?? "" },
    { enabled: !!workspace, refreshOn: ["runs:changed", "app:stateChanged"] },
  );
  const branches = useChannel(
    "git:branches",
    { workspaceId: workspace?.id ?? "" },
    { enabled: !!workspace, refreshOn: ["app:stateChanged"] },
  );

  const detail: RunDetailView | null = run.data;
  const runState: RunState = detail?.run.status ?? "IDLE";
  const iteration = detail?.run.iteration ?? 0;
  const entries = useMemo(() => buildTimeline(detail), [detail]);

  // The clock ticks only while a run is genuinely open, so a finished run keeps
  // showing the time it actually took.
  const isOpen = !["IDLE", "DONE", "CANCELLED", "FAILED"].includes(runState);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!isOpen) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [isOpen]);
  const elapsed = detail
    ? elapsedSeconds(detail.run.startedAt, detail.run.finishedAt)
    : 0;
  void tick;

  const team: Agent[] = useMemo(
    () =>
      (state?.agents ?? []).map((a) => ({
        role: a.role,
        provider:
          a.providerId === "google"
            ? ("gemini" as const)
            : (a.providerId as Agent["provider"]),
        agent: a.displayName,
        account: a.accountName,
        model: a.model,
        reasoning: a.reasoning,
      })),
    [state?.agents],
  );
  const orchestrator = team.find((a) => a.role === "ORCHESTRATOR") ?? null;

  const currentAgent = useMemo(() => {
    if (!detail || detail.invocations.length === 0) return null;
    const last = detail.invocations[detail.invocations.length - 1];
    return last ? agentOf(last) : null;
  }, [detail]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newTask();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const fail = (error: unknown) =>
    toast(error instanceof Error ? error.message : "Não foi possível concluir a ação.");

  async function newTask() {
    if (!workspace) return;
    try {
      await invoke("sessions:create", { workspaceId: workspace.id, title: "Nova tarefa" });
      reloadState();
      toast("Nova tarefa — contexto do projeto mantido");
    } catch (error) {
      fail(error);
    }
  }

  async function startRun(text: string) {
    if (!workspace || !text.trim()) return;
    setSubmitting(true);
    try {
      await invoke("runs:start", {
        workspaceId: workspace.id,
        sessionId: null,
        objective: text.trim(),
      });
      run.reload();
      reloadState();
    } catch (error) {
      fail(error);
    } finally {
      setSubmitting(false);
    }
  }

  async function runAction(action: "runs:pause" | "runs:resume" | "runs:cancel", note?: string) {
    if (!detail) return;
    try {
      await invoke(action, { runId: detail.run.id });
      run.reload();
      if (note) toast(note);
    } catch (error) {
      fail(error);
    }
  }

  if (!workspace) return <NoWorkspace onChoose={reloadState} />;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AppSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        onNewTask={() => void newTask()}
        sessions={state?.sessions ?? []}
        workspaces={state?.workspaces ?? []}
        activeWorkspaceId={workspace.id}
        activeSessionId={detail?.run.sessionId ?? null}
        onOpenSession={() => run.reload()}
        onOpenWorkspace={(id) => {
          void invoke("workspaces:open", { workspaceId: id }).then(reloadState).catch(fail);
        }}
        accountName={
          state?.accounts.find((a) => a.isDefault)?.displayName ??
          state?.accounts[0]?.displayName ??
          null
        }
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <TopContextBar
          state={runState}
          iteration={iteration}
          onEditTeam={() => setTeamOpen(true)}
          workspace={workspace}
          git={state?.git ?? null}
          branches={branches.data ?? []}
          team={team}
          onOpenExternal={(url) => void invoke("app:openExternal", { url }).catch(fail)}
          onDisconnectGitHub={() =>
            toast("A integração com o GitHub ainda não é gerenciada pelo aplicativo.")
          }
          onChangeRepository={() => {
            void invoke("workspaces:choose", undefined).then(reloadState).catch(fail);
          }}
          onCreateBranch={() =>
            toast("Criar branch exige uma operação de escrita no Git, ainda não disponível.")
          }
          onAddContext={() => {
            void invoke("workspaces:choose", undefined).then(reloadState).catch(fail);
          }}
        />

        <div className="relative flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto">
            {entries.length === 0 ? (
              <EmptyState onSubmit={(text) => void startRun(text)} />
            ) : (
              <>
                <TimelineView
                  entries={entries}
                  onResolveHumanReview={(option) => {
                    if (!detail) return;
                    void invoke("runs:resolveHumanReview", { runId: detail.run.id, option })
                      .then(() => {
                        run.reload();
                        toast("Decisão registrada");
                      })
                      .catch(fail);
                  }}
                  onOpenDiff={() => setDiffOpen(true)}
                  onOpenEvidence={() => setEvidenceOpen(true)}
                  onOpenDetail={(e) => setDetailEntry(e)}
                  onResume={() => void runAction("runs:resume")}
                />
                <div ref={bottom} className="h-2" />
              </>
            )}
          </div>

          {activityOpen ? (
            <div className="hidden xl:block">
              <ActivityPanel
                state={runState}
                iteration={iteration}
                elapsed={elapsed}
                onClose={() => setActivityOpen(false)}
                onOpenEvidence={() => setEvidenceOpen(true)}
                currentAgent={currentAgent}
                steps={detail ? stepsOfRun(detail) : []}
                filesChanged={state?.git?.isRepository ? state.git.changedFiles : null}
                tests={
                  detail && detail.verifications.length > 0
                    ? {
                        passed: detail.verifications.filter((v) => v.passed).length,
                        total: detail.verifications.length,
                      }
                    : null
                }
                contextPercent={null}
                onOpenStep={() => setEvidenceOpen(true)}
              />
            </div>
          ) : (
            <button
              onClick={() => setActivityOpen(true)}
              className="absolute top-3 right-3 hidden size-8 place-items-center rounded-md border border-border bg-surface text-muted-foreground transition-colors hover:text-foreground xl:grid"
              aria-label="Abrir painel de atividade"
            >
              <PanelRightOpen className="size-4" />
            </button>
          )}
        </div>

        <Composer
          state={runState}
          onSubmit={(text) => void startRun(text)}
          onPause={() => void runAction("runs:pause", "Execução pausada com segurança")}
          onResume={() => void runAction("runs:resume")}
          onCancel={() => setCancelOpen(true)}
          orchestrator={orchestrator}
          disabled={submitting}
        />
      </main>

      <DiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        artifacts={detail?.artifacts ?? []}
        git={state?.git ?? null}
      />
      <EvidenceDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        git={state?.git ?? null}
        verifications={detail?.verifications ?? []}
      />
      <TeamDialog
        open={teamOpen}
        onOpenChange={setTeamOpen}
        team={team}
        onSave={() => {
          setTeamOpen(false);
          toast("A edição de equipe ainda não está disponível.");
        }}
      />
      <AgentDetailDialog
        entry={detailEntry}
        onOpenChange={() => setDetailEntry(null)}
        detail={detail}
      />
      <CancelDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        onConfirm={() => {
          setCancelOpen(false);
          void runAction("runs:cancel");
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onAction={(action) => {
          if (action === "Nova tarefa") void newTask();
          else if (action === "Configurar agentes") setTeamOpen(true);
          else if (action === "Contas e integrações")
            router.navigate("/configuracoes", { tab: "accounts" });
          else if (action === "Configurações") router.navigate("/configuracoes", { tab: "general" });
          else if (action === "Trocar projeto")
            void invoke("workspaces:choose", undefined).then(reloadState).catch(fail);
          else toast(`${action} ainda não está disponível.`);
        }}
      />
    </div>
  );
}

/** Shown before a project has been chosen. Uses the design's empty-state voice. */
function NoWorkspace({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid size-7 place-items-center rounded-md bg-primary/15">
          <Sparkles className="size-4 text-primary" />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Escolha um projeto</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          O AI Orchestrator trabalha dentro de uma pasta do seu computador. Escolha a pasta
          do projeto para começar.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <button
            onClick={() => {
              void invoke("workspaces:choose", undefined).then(onChoose);
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Selecionar pasta
          </button>
          <Link
            to="/onboarding"
            className="inline-flex items-center justify-center rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Ver o onboarding
          </Link>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onSubmit }: { onSubmit: (text: string) => void }) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col justify-center px-6 py-10">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm text-muted-foreground">AI Orchestrator</span>
      </div>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        O que vamos construir hoje?
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Defina o objetivo uma vez. A equipe planeja, delega, executa, verifica e corrige
        até provar que terminou — ou até precisar da sua decisão.
      </p>

      <div className="mt-6">
        <div className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          Sugestões
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => onSubmit(s)}
              className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-foreground/85 transition-colors hover:border-primary/40 hover:text-primary"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8 text-xs text-muted-foreground">
        Primeira vez aqui?{" "}
        <Link to="/onboarding" className="text-primary hover:underline">
          Ver o onboarding
        </Link>
      </div>
    </div>
  );
}
