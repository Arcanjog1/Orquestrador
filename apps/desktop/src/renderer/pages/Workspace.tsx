import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelRightOpen, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AppSidebar } from "@/components/orch/AppSidebar";
import { ProjectDialog } from "@/components/orch/ProjectDialog";
import { TopContextBar } from "@/components/orch/TopContextBar";
import { TimelineView } from "@/components/orch/Timeline";
import { ActivityPanel, type Step } from "@/components/orch/ActivityPanel";
import { Composer } from "@/components/orch/Composer";
import { DiffDialog, EvidenceDialog, RunDetailDialog } from "@/components/orch/RunDialogs";
import { CommitDialog, CreateBranchDialog, PullRequestDialog } from "@/components/orch/GitDialogs";
import {
  AddProjectDialog,
  AgentDetailDialog,
  CancelDialog,
  CommandPalette,
  TeamDialog,
  RenameDialog,
  RenameSessionDialog,
  ConfirmDialog,
} from "@/components/orch/dialogs";
import { reasoningLabel, suggestions, type Agent, selectionLabel } from "@/lib/orchestrator-data";
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
  GitHubStatusView,
  PullRequestStatusView,
  ChatMessageView,
  RunDetailView,
  WorkspaceBranchesView,
  WorkspaceChangesView,
  ChatSessionView,
  ProjectView,
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
  github,
  reload,
  onSelectWorkspace,
}: {
  workspaces: readonly WorkspaceView[];
  workspace: WorkspaceView | null;
  accounts: readonly AccountView[];
  github: GitHubStatusView | null;
  reload: () => void;
  onSelectWorkspace: (id: string) => void;
}) {
  const router = useRouter();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const [diffOpen, setDiffOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [changes, setChanges] = useState<WorkspaceChangesView | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetailView | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [branches, setBranches] = useState<WorkspaceBranchesView | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [dirtySwitch, setDirtySwitch] = useState<{ branch: string; message: string } | null>(null);
  const [renamingWorkspace, setRenamingWorkspace] = useState(false);
  const [removingWorkspace, setRemovingWorkspace] = useState(false);
  const [pullRequest, setPullRequest] = useState<PullRequestStatusView | null>(null);
  const [gitDialog, setGitDialog] = useState<"commit" | "branch" | "pr" | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [detailEntry, setDetailEntry] = useState<Extract<TimelineEntry, { kind: "agent" }> | null>(
    null,
  );

  const [sessions, setSessions] = useState<readonly ChatSessionView[]>([]);
  const [projects, setProjects] = useState<readonly ProjectView[]>([]);
  const [projectDialog, setProjectDialog] = useState<{ project: ProjectView | null } | null>(null);
  const [removingProject, setRemovingProject] = useState<ProjectView | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // A conversation to open once the page has switched to its folder.
  const pendingSession = useRef<string | null>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<ChatSessionView | null>(null);
  const [deleting, setDeleting] = useState<ChatSessionView | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
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
      // Every conversation, of every project and folder: the sidebar files
      // them by project; the open one must belong to the folder on screen.
      const [list, projectList] = await Promise.all([
        api.chat.listAllSessions({
          includeArchived: showArchived,
          ...(search.trim() ? { query: search.trim() } : {}),
        }),
        api.project.list(),
      ]);
      setSessions(list);
      setProjects(projectList);
      // A filter narrows the list, not the conversation being read: only when
      // the open one is truly gone does the selection move.
      setSessionId((current) => {
        if (current && list.some((s) => s.id === current)) return current;
        if (current && (search.trim() || !showArchived)) return current;
        return list.find((s) => s.workspaceId === workspace.id)?.id ?? null;
      });
    } catch (error) {
      fail(error);
    }
  }, [workspace, fail, search, showArchived]);

  const sessionActions = {
    rename: (session: ChatSessionView) => setRenaming(session),
    archive: async (session: ChatSessionView, archived: boolean) => {
      try {
        await api.chat.archiveSession({ sessionId: session.id, archived });
        toast(archived ? "Conversa arquivada" : "Conversa restaurada");
        await loadSessions();
      } catch (error) {
        fail(error);
      }
    },
    remove: (session: ChatSessionView) => setDeleting(session),
    move: async (session: ChatSessionView, projectId: string | null) => {
      try {
        const moved = await api.chat.moveSession({ sessionId: session.id, projectId });
        toast(moved.projectName ? `Movida para ${moved.projectName}` : "Movida para Sem projeto");
        await loadSessions();
      } catch (error) {
        fail(error);
      }
    },
  };

  /** Opens a conversation, switching to its folder first when it lives elsewhere. */
  const openSession = (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (target && workspace && target.workspaceId !== workspace.id) {
      pendingSession.current = id;
      onSelectWorkspace(target.workspaceId);
      return;
    }
    setSessionId(id);
    setRun(null);
    setStage(null);
    setStages([]);
  };

  async function removeProject() {
    if (!removingProject) return;
    try {
      const outcome = await api.project.remove({ projectId: removingProject.id });
      toast(
        outcome.sessionsMoved > 0
          ? `Projeto excluído; ${outcome.sessionsMoved} conversa(s) foram para Sem projeto`
          : "Projeto excluído",
      );
      setRemovingProject(null);
      await loadSessions();
    } catch (error) {
      fail(error);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await api.chat.deleteSession({ sessionId: deleting.id });
      toast("Conversa apagada");
      if (sessionId === deleting.id) {
        setSessionId(null);
        setMessages([]);
        setRun(null);
        setStage(null);
        setStages([]);
      }
      setDeleting(null);
      await loadSessions();
    } catch (error) {
      fail(error);
    } finally {
      setDeletingBusy(false);
    }
  }

  useEffect(() => {
    // Switching folders opens the conversation that asked for the switch,
    // when there is one; otherwise it starts clean.
    setSessionId(pendingSession.current);
    pendingSession.current = null;
    setMessages([]);
    setRun(null);
    setStage(null);
    setStages([]);
    setSearch("");
    setShowArchived(false);
  }, [workspace?.id]);

  useEffect(() => {
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

  // -- The working copy, read with git, never remembered ---------------------

  const refreshChanges = useCallback(async () => {
    if (!workspace) {
      setChanges(null);
      return;
    }
    try {
      setChanges(await api.workspace.changes({ workspaceId: workspace.id }));
    } catch {
      setChanges(null);
    }
  }, [workspace?.id]);

  useEffect(() => {
    void refreshChanges();
  }, [refreshChanges]);

  // The last run of the conversation being read, so its verifications and
  // steps are on the panel before a new one starts.
  useEffect(() => {
    if (!run) {
      setRunDetail(null);
      return;
    }
    let alive = true;
    api.run
      .detail({ runId: run.id })
      .then((d) => alive && setRunDetail(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [run?.id, run?.status]);

  // -- Branches: read from git on demand, switched only on request ---------

  // Reads overlap (a switch refreshes, and opening the chip refreshes again);
  // only the newest answer may land, or a slower, older read would paint a
  // tree that is no longer there.
  const branchesRead = useRef(0);
  const refreshBranches = useCallback(async () => {
    if (!workspace) {
      setBranches(null);
      return;
    }
    const read = ++branchesRead.current;
    try {
      const fresh = await api.workspace.branches({ workspaceId: workspace.id });
      if (read === branchesRead.current) setBranches(fresh);
    } catch (error) {
      fail(error);
    }
  }, [workspace?.id, fail]);

  useEffect(() => {
    setBranches(null);
    void refreshBranches();
  }, [refreshBranches]);

  async function checkout(branch: string, allowDirty = false) {
    if (!workspace) return;
    setSwitching(branch);
    try {
      const result = await api.workspace.checkout({ workspaceId: workspace.id, branch, allowDirty });
      if (!result.switched) {
        setDirtySwitch({ branch, message: result.message });
        return;
      }
      toast(`Branch trocada para ${result.workspace.branch ?? branch}`);
      setDirtySwitch(null);
      reload();
      await Promise.all([refreshBranches(), refreshChanges()]);
    } catch (error) {
      fail(error);
    } finally {
      setSwitching(null);
    }
  }

  // -- GitHub: pull requests and checks for the current branch ------------

  const refreshPullRequest = useCallback(async () => {
    if (!workspace) {
      setPullRequest(null);
      return;
    }
    try {
      setPullRequest(await api.github.pullRequestStatus({ workspaceId: workspace.id }));
    } catch {
      setPullRequest(null);
    }
  }, [workspace?.id]);

  useEffect(() => {
    setPullRequest(null);
    void refreshPullRequest();
  }, [refreshPullRequest, github?.connected]);

  /** A git action's outcome, as a toast and a refresh of what it changed. */
  async function afterGit(result: { ok: boolean; summary: string; output: string }) {
    toast(result.summary);
    reload();
    await Promise.all([refreshBranches(), refreshChanges(), refreshPullRequest()]);
  }

  const [pushConfirm, setPushConfirm] = useState(false);

  /** Push asks first unless the person switched that off in Settings → Git. */
  async function pushRequested() {
    try {
      const settings = await api.settings.all();
      if ((settings["git.confirmBeforePush"] ?? "true") === "true") setPushConfirm(true);
      else await runGit("push");
    } catch (error) {
      fail(error);
    }
  }

  async function runGit(action: "fetch" | "push") {
    if (!workspace) return;
    try {
      const result = await (action === "fetch"
        ? api.workspace.fetch({ workspaceId: workspace.id })
        : api.workspace.push({ workspaceId: workspace.id }));
      await afterGit(result);
    } catch (error) {
      fail(error);
    }
  }

  async function removeWorkspace() {
    if (!workspace) return;
    try {
      await api.workspace.remove({ workspaceId: workspace.id });
      toast(`"${workspace.name}" removido da lista`);
      setRemovingWorkspace(false);
      reload();
    } catch (error) {
      fail(error);
    }
  }

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
          void api.run
            .detail({ runId: event.runId })
            .then(setRunDetail)
            .catch(() => {});
        }
        // The working copy moved: the panel's file count is read again.
        if (["evidence", "verification", "done", "failed", "cancelled", "blocked"].includes(event.stage)) {
          void refreshChanges();
        }
      }),
    [sessionId, refreshChanges],
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
      // "Padrão do CLI" unless a model was pinned under Configuração avançada.
      orchestratorModel:
        team?.orchestrator.selection === "manual"
          ? (team.orchestrator.model ?? "Padrão do CLI")
          : team?.orchestrator.agentId
            ? "Padrão do CLI"
            : null,
      orchestratorReasoning:
        team?.orchestrator.selection === "manual" ? reasoningLabel(team.orchestrator.reasoning) : null,
      workerName: team?.worker.agentId ? "Claude Code" : null,
      workerAccount: team?.worker.accountName ?? null,
      // Under automatic selection the worker has no fixed model: the badge
      // says so, and each invocation's card carries the model that ran.
      workerModel:
        team?.worker.selection === "manual" ? (team.worker.model ?? null) : team?.worker.agentId ? selectionLabel(team.worker.selection) : null,
      workerReasoning:
        team?.worker.selection === "manual" ? reasoningLabel(team.worker.reasoning) : null,
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
        filesChanged: changes?.isRepository ? changes.files.length : null,
        tests:
          runDetail && runDetail.verifications.length > 0
            ? {
                passed: runDetail.verifications.filter((v) => v.passed).length,
                total: runDetail.verifications.length,
              }
            : null,
      }),
    [messages, run, identity, workspace, stage, changes, runDetail],
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

  /**
   * A new conversation. Inside a project it is born there and works in the
   * project's folder (switching to it when it is another); otherwise it is
   * "Sem projeto", in the folder on screen.
   */
  const newTask = useCallback(
    async (project: ProjectView | null = null) => {
      if (!workspace) return;
      try {
        const workspaceId = project?.workspaceId ?? workspace.id;
        const created = await api.chat.createSession({
          workspaceId,
          title: "Nova tarefa",
          projectId: project?.id ?? null,
        });
        if (workspaceId !== workspace.id) {
          pendingSession.current = created.id;
          onSelectWorkspace(workspaceId);
          toast(`Nova conversa em ${project?.name ?? "Sem projeto"}`);
          return;
        }
        await loadSessions();
        setSessionId(created.id);
        setRun(null);
        setStage(null);
        setStages([]);
        toast(project ? `Nova conversa em ${project.name}` : "Nova tarefa — contexto do projeto mantido");
      } catch (error) {
        fail(error);
      }
    },
    [workspace, loadSessions, fail, onSelectWorkspace],
  );

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

  /**
   * The human-review card's three choices, each a real operation:
   * "Continuar" starts a new run that reads the conversation so far,
   * "Dar instrução" hands the keyboard back, "Cancelar" closes the run.
   */
  async function resolveHumanReview(option: string) {
    if (option === "Continuar") {
      await send("Continue de onde parou. O bloqueio foi resolvido; prossiga com o objetivo original.");
    } else if (option === "Dar instrução") {
      composerRef.current?.focus();
    } else if (option === "Cancelar" && run) {
      try {
        await api.run.cancel({ runId: run.id });
        setRun(await api.run.get({ runId: run.id }));
        await loadMessages();
      } catch (error) {
        fail(error);
      }
    } else {
      await send(option);
    }
  }

  async function retry(runId: string) {
    try {
      const previous = await api.run.get({ runId });
      await send(previous.objective);
    } catch (error) {
      fail(error);
    }
  }

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
        projects={projects}
        workspaces={workspaces}
        activeWorkspaceId={workspace.id}
        activeSessionId={sessionId}
        onOpenSession={openSession}
        onOpenWorkspace={onSelectWorkspace}
        projectActions={{
          create: () => setProjectDialog({ project: null }),
          rename: (project) => setProjectDialog({ project }),
          linkWorkspace: (project) => setProjectDialog({ project }),
          remove: (project) => setRemovingProject(project),
          newSession: (project) => void newTask(project),
        }}
        accountName={
          accounts.find((a) => a.state === "connected")?.name ?? accounts[0]?.name ?? null
        }
        sessionActions={sessionActions}
        search={search}
        onSearch={setSearch}
        showArchived={showArchived}
        onShowArchived={setShowArchived}
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
          onRenameWorkspace={() => setRenamingWorkspace(true)}
          onRemoveWorkspace={() => setRemovingWorkspace(true)}
          onOpenFolder={() => void api.workspace.openFolder({ workspaceId: workspace.id }).catch(fail)}
          branches={branches}
          onRefreshBranches={() => void refreshBranches()}
          onCheckout={(branch) => void checkout(branch)}
          switching={switching}
          github={github}
          pullRequest={pullRequest}
          onRefreshPullRequest={() => void refreshPullRequest()}
          onOpenGitHubSettings={() => router.navigate("/configuracoes", { tab: "accounts" })}
          onFetch={() => void runGit("fetch")}
          onCreateBranch={() => setGitDialog("branch")}
          onCommit={() => setGitDialog("commit")}
          onPush={() => void pushRequested()}
          onPullRequest={() => setGitDialog("pr")}
        />

        <div className="relative flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto">
            {entries.length === 0 ? (
              <EmptyState onSubmit={(text) => void send(text)} />
            ) : (
              <>
                <TimelineView
                  entries={entries}
                  onResolveHumanReview={(option) => void resolveHumanReview(option)}
                  onOpenDiff={() => setDiffOpen(true)}
                  onOpenEvidence={() => setEvidenceOpen(true)}
                  onOpenDetail={(e) => setDetailEntry(e)}
                  onResume={() => toast("A execução não pode ser retomada; envie uma nova instrução.")}
                  onOpenRunDetail={(id) => setDetailRunId(id)}
                  onRetry={(id) => void retry(id)}
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
                filesChanged={changes?.isRepository ? changes.files.length : null}
                tests={
                  runDetail && runDetail.verifications.length > 0
                    ? {
                        passed: runDetail.verifications.filter((v) => v.passed).length,
                        total: runDetail.verifications.length,
                      }
                    : null
                }
                contextPercent={null}
                onOpenStep={() => (run ? setDetailRunId(run.id) : setEvidenceOpen(true))}
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
          onCancel={() => setCancelOpen(true)}
          orchestrator={team.find((a) => a.role === "ORCHESTRATOR") ?? null}
          disabled={sending}
          inputRef={composerRef}
        />
      </main>

      <DiffDialog open={diffOpen} onOpenChange={setDiffOpen} workspace={workspace} />
      <EvidenceDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        workspace={workspace}
        runId={run?.id ?? null}
      />
      <RunDetailDialog runId={detailRunId} onOpenChange={(v) => !v && setDetailRunId(null)} />
      <ConfirmDialog
        open={pushConfirm}
        onOpenChange={setPushConfirm}
        title="Enviar para o remoto?"
        description={`git push da branch ${workspace.branch ?? "atual"} para origin. Pode ser desligado em Configurações → Git.`}
        confirmLabel="Push"
        onConfirm={() => {
          setPushConfirm(false);
          void runGit("push");
        }}
      />
      <CommitDialog
        open={gitDialog === "commit"}
        onOpenChange={(v) => !v && setGitDialog(null)}
        workspace={workspace}
        onDone={(result) => void afterGit(result)}
      />
      <CreateBranchDialog
        open={gitDialog === "branch"}
        onOpenChange={(v) => !v && setGitDialog(null)}
        workspace={workspace}
        onDone={(result) => void afterGit(result)}
      />
      <PullRequestDialog
        open={gitDialog === "pr"}
        onOpenChange={(v) => !v && setGitDialog(null)}
        workspace={workspace}
        base={workspace.defaultBranch}
        onDone={(pr) => {
          toast(`Pull request #${pr.number} aberto`);
          void refreshPullRequest();
        }}
      />
      <RenameDialog
        open={renamingWorkspace}
        title="Renomear projeto"
        description="Só o nome na lista muda. A pasta continua onde está."
        value={workspace.name}
        onOpenChange={setRenamingWorkspace}
        testid="rename-workspace"
        onSave={async (name) => {
          await api.workspace.rename({ workspaceId: workspace.id, name });
          toast("Projeto renomeado");
          reload();
        }}
      />
      <ConfirmDialog
        open={removingWorkspace}
        onOpenChange={setRemovingWorkspace}
        title="Remover projeto da lista?"
        description={`"${workspace.name}" sai da lista com suas conversas, execuções e verificações registradas. A pasta ${workspace.localPath} e todos os seus arquivos ficam intactos.`}
        confirmLabel="Remover da lista"
        onConfirm={() => void removeWorkspace()}
      />
      <ConfirmDialog
        open={dirtySwitch !== null}
        onOpenChange={(v) => !v && setDirtySwitch(null)}
        title="Trocar de branch com alterações pendentes?"
        description={`${dirtySwitch?.message ?? ""} O git leva as alterações junto quando pode, e recusa a troca se alguma seria perdida. Nada é descartado.`}
        confirmLabel="Trocar mesmo assim"
        busy={switching !== null}
        onConfirm={() => dirtySwitch && void checkout(dirtySwitch.branch, true)}
      />
      <RenameSessionDialog
        session={renaming}
        onOpenChange={(v) => !v && setRenaming(null)}
        onRenamed={() => {
          toast("Conversa renomeada");
          void loadSessions();
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Apagar conversa?"
        description={
          deleting
            ? `"${deleting.title}" e suas mensagens serão removidas. As execuções que ela iniciou continuam no histórico, e nenhum arquivo do projeto é alterado.`
            : ""
        }
        confirmLabel="Apagar conversa"
        busy={deletingBusy}
        onConfirm={() => void confirmDelete()}
      />
      <ProjectDialog
        open={projectDialog !== null}
        project={projectDialog?.project ?? null}
        workspaces={workspaces}
        defaultWorkspaceId={workspace.id}
        onOpenChange={(v) => !v && setProjectDialog(null)}
        onSaved={(project) => {
          toast(projectDialog?.project ? "Projeto salvo" : `Projeto "${project.name}" criado`);
          void loadSessions();
        }}
      />
      <ConfirmDialog
        open={removingProject !== null}
        onOpenChange={(v) => !v && setRemovingProject(null)}
        title="Excluir projeto?"
        description={
          removingProject
            ? `"${removingProject.name}" sai da lista. Suas ${removingProject.sessionCount} conversa(s) vão para "Sem projeto" e continuam com suas mensagens e execuções. Nenhuma pasta, repositório ou arquivo é tocado.`
            : ""
        }
        confirmLabel="Excluir projeto"
        onConfirm={() => void removeProject()}
      />
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
        githubConnected={github?.connected ?? false}
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
