import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelRightOpen, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AppSidebar } from "@/components/orch/AppSidebar";
import { TopContextBar } from "@/components/orch/TopContextBar";
import { TimelineView } from "@/components/orch/Timeline";
import { ActivityPanel, type Step } from "@/components/orch/ActivityPanel";
import { Composer } from "@/components/orch/Composer";
import {
  AddProjectDialog,
  AgentDetailDialog,
  CancelDialog,
  CommandPalette,
  DiffDialog,
  EvidenceDialog,
  TeamDialog,
} from "@/components/orch/dialogs";
import { reasoningLabel, suggestions, type Agent } from "@/lib/orchestrator-data";
import {
  agentOfAuthor,
  buildTimeline,
  elapsedSeconds,
  runStateOf,
  spanBetween,
  type TimelineEntry,
} from "@/lib/timeline";
import { api, messageOf } from "@/lib/api";
import { Link, useRouter } from "@/router";
import type {
  AccountView,
  ChatMessageView,
  ChatSessionView,
  RunProgressEvent,
  RunView,
  WorkspaceView,
} from "@shared/ipc-contract";

/**
 * The workspace, exactly as approved.
 *
 * Layout, panel order, the xl breakpoint on the activity panel, the collapse
 * button and the keyboard shortcuts are the design's. Everything it shows is
 * the real run: the timeline is built from persisted chat messages, the status
 * from the run record and the live `run:progress` stage, and the composer
 * calls `chat.sendMessage`, which is what actually starts the loop.
 */
export function WorkspacePage({
  workspaces,
  workspace,
  accounts,
  reload,
  onSelectWorkspace,
}: {
  workspaces: readonly WorkspaceView[];
  workspace: WorkspaceView | null;
  accounts: readonly AccountView[];
  reload: () => void;
  onSelectWorkspace: (id: string) => void;
}) {
  const router = useRouter();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const [diffOpen, setDiffOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [detailEntry, setDetailEntry] = useState<Extract<TimelineEntry, { kind: "agent" }> | null>(
    null,
  );

  const [sessions, setSessions] = useState<readonly ChatSessionView[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly ChatMessageView[]>([]);
  const [run, setRun] = useState<RunView | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [stages, setStages] = useState<{ stage: string; label: string; status: string }[]>([]);
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const fail = useCallback((error: unknown) => toast(messageOf(error)), []);

  // -- Sessions ------------------------------------------------------------

  const loadSessions = useCallback(async () => {
    if (!workspace) return;
    try {
      const list = await api.chat.listSessions({ workspaceId: workspace.id });
      setSessions(list);
      setSessionId((current) => (current && list.some((s) => s.id === current) ? current : list[0]?.id ?? null));
    } catch (error) {
      fail(error);
    }
  }, [workspace, fail]);

  useEffect(() => {
    setSessionId(null);
    setMessages([]);
    setRun(null);
    setStage(null);
    setStages([]);
    void loadSessions();
  }, [loadSessions]);

  const loadMessages = useCallback(async () => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    try {
      setMessages(await api.chat.listMessages({ sessionId }));
    } catch (error) {
      fail(error);
    }
  }, [sessionId, fail]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  // -- Live run progress ---------------------------------------------------

  useEffect(
    () =>
      api.events.runProgress((event: RunProgressEvent) => {
        if (sessionId && event.sessionId !== sessionId) return;
        setStage(event.stage);
        setStages((prev) => {
          const next = prev.filter((s) => s.stage !== event.stage);
          return [...next, { stage: event.stage, label: event.label, status: event.status }];
        });
        if (event.message) {
          setMessages((prev) =>
            prev.some((m) => m.id === event.message!.id) ? prev : [...prev, event.message!],
          );
        }
        // A terminal stage means the run record changed; re-read it rather than
        // guessing the new status here.
        if (["done", "failed", "cancelled", "blocked"].includes(event.stage)) {
          void api.run
            .get({ runId: event.runId })
            .then(setRun)
            .catch(() => {});
        }
      }),
    [sessionId],
  );

  // -- Derived -------------------------------------------------------------

  const runState = runStateOf(run, stage);
  const iteration = run?.iterations ?? 0;

  // Agent, account, model and reasoning are four different things, and the
  // header, the timeline and the team dialog all read them from the same
  // place: the workspace's persisted team.
  const identity = useMemo(() => {
    const team = workspace?.team;
    return {
      orchestratorName: team?.orchestrator.agentId ? "Codex" : null,
      orchestratorAccount: team?.orchestrator.accountName ?? null,
      orchestratorModel: team?.orchestrator.model ?? null,
      orchestratorReasoning: reasoningLabel(team?.orchestrator.reasoning),
      workerName: team?.worker.agentId ? "Claude Code" : null,
      workerAccount: team?.worker.accountName ?? null,
      workerModel: team?.worker.model ?? null,
      workerReasoning: reasoningLabel(team?.worker.reasoning),
    };
  }, [workspace]);

  const entries = useMemo(
    () =>
      buildTimeline({
        messages,
        run,
        agents: identity,
        branch: workspace?.branch ?? null,
        liveStage: stage,
      }),
    [messages, run, identity, workspace, stage],
  );

  const team: Agent[] = useMemo(() => {
    const out: Agent[] = [];
    const orchestrator = agentOfAuthor("orchestrator", identity);
    const worker = agentOfAuthor("worker", identity);
    if (workspace?.orchestratorAgentId && orchestrator) out.push(orchestrator);
    if (workspace?.workerAgentId && worker) out.push(worker);
    return out;
  }, [identity, workspace]);

  const currentAgent = useMemo(() => {
    if (stage === "worker") return agentOfAuthor("worker", identity);
    if (stage === "orchestrator" || stage === "analysing" || stage === "review")
      return agentOfAuthor("orchestrator", identity);
    return null;
  }, [stage, identity]);

  const steps: Step[] = useMemo(
    () =>
      stages.map((s) => ({
        label: s.label,
        status:
          s.status === "RUNNING" ? "running" : s.status === "FAILED" ? "failed" : "done",
        time: "—",
      })),
    [stages],
  );

  const isOpen = !["IDLE", "DONE", "CANCELLED", "FAILED"].includes(runState);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isOpen) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [isOpen]);
  const elapsed = run ? elapsedSeconds(run.startedAt, run.finishedAt) : 0;

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length]);

  // -- Actions -------------------------------------------------------------

  const newTask = useCallback(async () => {
    if (!workspace) return;
    try {
      const created = await api.chat.createSession({
        workspaceId: workspace.id,
        title: "Nova tarefa",
      });
      await loadSessions();
      setSessionId(created.id);
      setRun(null);
      setStage(null);
      setStages([]);
      toast("Nova tarefa — contexto do projeto mantido");
    } catch (error) {
      fail(error);
    }
  }, [workspace, loadSessions, fail]);

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
  }, [newTask]);

  async function send(text: string) {
    if (!workspace || !text.trim()) return;
    setSending(true);
    try {
      let target = sessionId;
      if (!target) {
        const created = await api.chat.createSession({
          workspaceId: workspace.id,
          title: text.trim().slice(0, 80),
        });
        target = created.id;
        setSessionId(target);
        await loadSessions();
      }
      setStages([]);
      const result = await api.chat.sendMessage({ sessionId: target, text: text.trim() });
      setMessages((prev) => [...prev, result.message]);
      setRun(result.run);
      setStage(null);
    } catch (error) {
      fail(error);
    } finally {
      setSending(false);
    }
  }

  async function cancelRun() {
    if (!run) return;
    try {
      await api.run.cancel({ runId: run.id });
      setRun(await api.run.get({ runId: run.id }));
    } catch (error) {
      fail(error);
    }
  }

  const openExternal = (url: string) => {
    void api.app.openExternal({ url }).catch(fail);
  };

  if (!workspace) {
    return <NoWorkspace onAdd={() => setAddProjectOpen(true)} open={addProjectOpen}
      onOpenChange={setAddProjectOpen} onAdded={(id) => { reload(); onSelectWorkspace(id); }} />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AppSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        onNewTask={() => void newTask()}
        sessions={sessions}
        workspaces={workspaces}
        activeWorkspaceId={workspace.id}
        activeSessionId={sessionId}
        onOpenSession={(id) => {
          setSessionId(id);
          setRun(null);
          setStage(null);
          setStages([]);
        }}
        onOpenWorkspace={onSelectWorkspace}
        accountName={
          accounts.find((a) => a.state === "connected")?.name ?? accounts[0]?.name ?? null
        }
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <TopContextBar
          state={runState}
          iteration={iteration}
          onEditTeam={() => setTeamOpen(true)}
          workspace={workspace}
          workspaces={workspaces}
          team={team}
          onOpenExternal={openExternal}
          onOpenWorkspace={onSelectWorkspace}
          onAddProject={() => setAddProjectOpen(true)}
        />

        <div className="relative flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto">
            {entries.length === 0 ? (
              <EmptyState onSubmit={(text) => void send(text)} />
            ) : (
              <>
                <TimelineView
                  entries={entries}
                  onResolveHumanReview={(option) => void send(option)}
                  onOpenDiff={() => setDiffOpen(true)}
                  onOpenEvidence={() => setEvidenceOpen(true)}
                  onOpenDetail={(e) => setDetailEntry(e)}
                  onResume={() => toast("A execução não pode ser retomada; envie uma nova instrução.")}
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
                steps={steps}
                filesChanged={null}
                tests={null}
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
          onSubmit={(text) => void send(text)}
          onPause={() => toast("Pausar ainda não está disponível; use Cancelar.")}
          onResume={() => {}}
          onCancel={() => setCancelOpen(true)}
          orchestrator={team.find((a) => a.role === "ORCHESTRATOR") ?? null}
          disabled={sending}
        />
      </main>

      <DiffDialog open={diffOpen} onOpenChange={setDiffOpen} workspace={workspace} />
      <EvidenceDialog open={evidenceOpen} onOpenChange={setEvidenceOpen} workspace={workspace} />
      <TeamDialog
        open={teamOpen}
        onOpenChange={setTeamOpen}
        accounts={accounts}
        workspace={workspace}
        onSaved={() => {
          reload();
          toast("Equipe salva");
        }}
      />
      <AgentDetailDialog entry={detailEntry} onOpenChange={() => setDetailEntry(null)} />
      <CancelDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        onConfirm={() => {
          setCancelOpen(false);
          void cancelRun();
        }}
      />
      <AddProjectDialog
        open={addProjectOpen}
        onOpenChange={setAddProjectOpen}
        onAdded={(id) => {
          reload();
          onSelectWorkspace(id);
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onAction={(action) => {
          if (action === "Nova tarefa") void newTask();
          else if (action === "Configurar agentes") setTeamOpen(true);
          else if (action === "Trocar projeto") setAddProjectOpen(true);
          else if (action === "Contas e integrações")
            router.navigate("/configuracoes", { tab: "accounts" });
          else if (action === "Configurações") router.navigate("/configuracoes", { tab: "general" });
          else if (action === "Histórico de execuções") router.navigate("/historico");
        }}
      />
    </div>
  );
}

function NoWorkspace({
  onAdd,
  open,
  onOpenChange,
  onAdded,
}: {
  onAdd: () => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: (id: string) => void;
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid size-7 place-items-center rounded-md bg-primary/15">
          <Sparkles className="size-4 text-primary" />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Escolha um projeto</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          O AI Orchestrator trabalha dentro de uma pasta do seu computador. Escolha a pasta
          do projeto, ou clone um repositório, para começar.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <button
            onClick={onAdd}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Adicionar projeto
          </button>
          <Link
            to="/onboarding"
            className="inline-flex items-center justify-center rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Ver o onboarding
          </Link>
        </div>
      </div>
      <AddProjectDialog open={open} onOpenChange={onOpenChange} onAdded={onAdded} />
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
