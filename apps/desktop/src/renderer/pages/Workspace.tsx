import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelRightOpen, ShieldQuestion, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AppSidebar } from "@/components/orch/AppSidebar";
import { ProjectDialog } from "@/components/orch/ProjectDialog";
import { ProjectContextDialog } from "@/components/orch/ProjectContextDialog";
import { PrepareProjectDialog } from "@/components/orch/PrepareProjectDialog";
import { PermissionDialog } from "@/components/orch/PermissionDialog";
import { TopContextBar } from "@/components/orch/TopContextBar";
import { TimelineView } from "@/components/orch/Timeline";
import {
  ActivityPanel,
  type AgentStatus,
  type ExchangeCounts,
  type Liveness,
  type Step,
} from "@/components/orch/ActivityPanel";
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
  CloudStatusView,
  GitHubStatusView,
  PullRequestStatusView,
  ChatMessageView,
  RunDetailView,
  WorkspaceBranchesView,
  WorkspaceChangesView,
  ChatSessionView,
  ProjectView,
  ProjectRemovalPlanView,
  PermissionRequestView,
  RunActivityEvent,
  AgentMessageEvent,
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
  cloud,
  reload,
  onSelectWorkspace,
}: {
  workspaces: readonly WorkspaceView[];
  workspace: WorkspaceView | null;
  accounts: readonly AccountView[];
  github: GitHubStatusView | null;
  /** Whether this computer can reach a coordinator. Null before it is known. */
  cloud: CloudStatusView | null;
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
  /**
   * What the agent in flight is doing, from the ephemeral channel.
   *
   * Cleared whenever a run leaves the running state, so the panel can never
   * show a stale "executando há 4m" for an agent that finished ten minutes
   * ago - which would be the same lie, wearing a nicer number.
   */
  const [liveness, setLiveness] = useState<Liveness | null>(null);
  const [exchange, setExchange] = useState<ExchangeCounts>({ inFlight: 0, dead: 0 });
  const [agentStatus, setAgentStatus] = useState<readonly AgentStatus[]>([]);
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
  // What removing would do, as the main process reports it - not as the
  // renderer guesses it. The dialog can then say the real counts and the real
  // paths that stay untouched.
  const [removalPlan, setRemovalPlan] = useState<ProjectRemovalPlanView | null>(null);
  const [contextProject, setContextProject] = useState<ProjectView | null>(null);
  const [prepareProject, setPrepareProject] = useState<ProjectView | null>(null);
  // Authorisation requests raised by the run on screen. Loaded from the main
  // process rather than pushed, so reopening the app shows what is still
  // waiting instead of losing it with the window.
  const [permissions, setPermissions] = useState<readonly PermissionRequestView[]>([]);
  const [permissionOpen, setPermissionOpen] = useState<PermissionRequestView | null>(null);
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

  /**
   * The project the sidebar highlights.
   *
   * The open conversation's project when there is one, otherwise the project
   * bound to the folder on screen. Reading it from the conversation first is
   * what makes the highlight follow what the person is actually looking at.
   */
  /** Only what is still waiting: a decided request is history, not a task. */
  const pendingPermissions = useMemo(
    () => permissions.filter((request) => request.status === "pending"),
    [permissions],
  );

  const activeProjectId = useMemo(() => {
    const open = sessions.find((s) => s.id === sessionId);
    if (open?.projectId) return open.projectId;
    if (!workspace) return null;
    return projects.find((p) => p.workspaceId === workspace.id)?.id ?? null;
  }, [sessions, sessionId, projects, workspace]);

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
    // The conversation's latest run, opened where every other detail lives.
    // A conversation with no run has the item disabled rather than opening an
    // empty dialog that says nothing.
    openHistory: (session: ChatSessionView) => {
      if (!session.lastRun) {
        toast("Esta conversa ainda não iniciou nenhuma execução.");
        return;
      }
      setDetailRunId(session.lastRun.id);
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

  /**
   * Opens a project: switches to the folder its runs execute in, and shows
   * its most recent conversation when it has one.
   *
   * `project.open` makes the workspace if the project has none, which is what
   * a repository connected without a local folder needs. Nothing is cloned.
   */
  async function openProject(project: ProjectView) {
    try {
      const opened = await api.project.open({ projectId: project.id });
      const newest = sessions.find((s) => s.projectId === project.id) ?? null;
      if (opened.workspaceId !== workspace?.id) {
        if (newest) pendingSession.current = newest.id;
        onSelectWorkspace(opened.workspaceId);
        return;
      }
      if (newest) openSession(newest.id);
      await loadSessions();
    } catch (error) {
      fail(error);
    }
  }

  async function archiveProject(project: ProjectView, archived: boolean) {
    try {
      await api.project.setArchived({ projectId: project.id, archived });
      toast(
        archived
          ? `"${project.name}" arquivado. Nada foi apagado — restaure pelo mesmo menu.`
          : `"${project.name}" restaurado`,
      );
      await loadSessions();
    } catch (error) {
      fail(error);
    }
  }

  /** Asks the main process exactly what removing would do, then confirms it. */
  async function askToRemoveProject(project: ProjectView) {
    try {
      setRemovalPlan(await api.project.removalPlan({ projectId: project.id }));
    } catch (error) {
      fail(error);
    }
  }

  async function removeProject() {
    if (!removalPlan) return;
    try {
      const outcome = await api.project.remove({ projectId: removalPlan.projectId });
      toast(
        outcome.sessionsMoved > 0
          ? `Projeto removido da lista; ${outcome.sessionsMoved} conversa(s) foram para "Sem projeto"`
          : "Projeto removido da lista",
      );
      setRemovalPlan(null);
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

  /**
   * What this run is still waiting to be authorised for.
   *
   * Read whenever the run changes and whenever it reports progress, because a
   * refusal arrives at the end of an invocation - the moment the run stops.
   */
  const loadPermissions = useCallback(async () => {
    if (!run) {
      setPermissions([]);
      return;
    }
    try {
      setPermissions(await api.permission.forRun({ runId: run.id }));
    } catch {
      // A request list that cannot be read is not worth failing a screen over;
      // the run's own state still says it needs a person.
      setPermissions([]);
    }
  }, [run]);

  useEffect(() => {
    void loadPermissions();
  }, [loadPermissions, stage]);

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

  // Liveness. Nothing here is stored: it is the answer to "is it still
  // working?", which stops being true the moment the run ends.
  useEffect(
    () =>
      api.events.runActivity((event: RunActivityEvent) => {
        if (sessionId && event.sessionId !== sessionId) return;
        setLiveness({
          agentLabel: event.agentLabel,
          elapsedMs: event.elapsedMs,
          idleMs: event.idleMs,
          currentTool: event.currentTool,
          idleTimeoutMs: event.idleTimeoutMs,
        });
      }),
    [sessionId],
  );

  // The delivery state of the exchange. Counted from the events rather than
  // polled, so a delegation that was handed over and never answered shows up
  // as one still waiting instead of as nothing at all.
  useEffect(
    () =>
      api.events.runMessage((event: AgentMessageEvent) => {
        if (sessionId && event.conversationId !== sessionId) return;
        setExchange((prev) => {
          if (event.messageType !== "DELEGATION") return prev;
          if (event.status === "leased" || event.status === "started") {
            return { ...prev, inFlight: prev.inFlight + 1 };
          }
          if (event.status === "dead") {
            return { inFlight: Math.max(0, prev.inFlight - 1), dead: prev.dead + 1 };
          }
          if (["completed", "cancelled", "pending", "failed"].includes(event.status)) {
            return { ...prev, inFlight: Math.max(0, prev.inFlight - 1) };
          }
          return prev;
        });
      }),
    [sessionId],
  );

  // The team, and what each member is doing.
  //
  // Polled rather than pushed: an agent's status is a fact about the whole
  // application, not about this conversation, and the panel only has to be
  // right within a couple of seconds. While nothing is running it is read
  // once - a roster that is not changing does not need a timer.
  const refreshAgents = useCallback(() => {
    void api.agents
      .status()
      .then((rows) => setAgentStatus(rows as readonly AgentStatus[]))
      .catch(() => {});
  }, []);

  // -- Derived -------------------------------------------------------------

  const runState = runStateOf(run, stage);
  const iteration = run?.iterations ?? 0;
  const running = !["IDLE", "DONE", "CANCELLED", "FAILED", "PAUSED", "NEEDS_HUMAN"].includes(
    runState,
  );

  // A finished run has no "now". Keeping the last snapshot on screen would
  // show "executando há 4m" for an agent that stopped ten minutes ago, which
  // is the same untruth in nicer clothes.
  useEffect(() => {
    if (!running) {
      setLiveness(null);
      setExchange({ inFlight: 0, dead: 0 });
    }
  }, [running]);

  useEffect(() => {
    refreshAgents();
    if (!running) return;
    const timer = setInterval(refreshAgents, 3_000);
    return () => clearInterval(timer);
  }, [running, refreshAgents]);

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
        // A project connected from a repository has no workspace until it is
        // opened. Asking for it here is what lets "nova conversa" work on a
        // project the person has never opened, instead of quietly putting the
        // conversation in whichever folder happens to be on screen.
        const workspaceId = project
          ? (await api.project.open({ projectId: project.id })).workspaceId
          : workspace.id;
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
        activeProjectId={activeProjectId}
        activeSessionId={sessionId}
        onOpenSession={openSession}
        projectActions={{
          create: () => setProjectDialog({ project: null }),
          open: (project) => void openProject(project),
          rename: (project) => setProjectDialog({ project }),
          settings: (project) => setProjectDialog({ project }),
          context: (project) => setContextProject(project),
          prepare: (project) => setPrepareProject(project),
          archive: (project, archived) => void archiveProject(project, archived),
          remove: (project) => void askToRemoveProject(project),
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
                liveness={liveness}
                exchange={exchange}
                agents={agentStatus}
                onCancel={() => setCancelOpen(true)}
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

        {pendingPermissions.length > 0 && (
          <div
            className="mx-4 mb-2 rounded-lg border border-attention/40 bg-attention/5 px-3 py-2"
            data-testid="permission-banner"
          >
            <div className="flex items-center gap-2 text-xs text-attention">
              <ShieldQuestion className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                {pendingPermissions.length === 1
                  ? "O worker precisa de autorização para uma operação. Nada foi executado."
                  : `O worker precisa de autorização para ${pendingPermissions.length} operações. Nada foi executado.`}
              </span>
            </div>
            <div className="mt-2 space-y-1">
              {pendingPermissions.map((request) => (
                <button
                  key={request.id}
                  onClick={() => setPermissionOpen(request)}
                  className="flex w-full items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-left text-xs transition-colors hover:border-primary/40"
                  data-testid={`permission-open-${request.id}`}
                >
                  <span className="font-mono text-[11px]">{request.toolName}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                    {request.command ?? "comando não informado"}
                  </span>
                  <span className="shrink-0 text-[10px] text-primary">Revisar</span>
                </button>
              ))}
            </div>
          </div>
        )}

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
      <PermissionDialog
        request={permissionOpen}
        onOpenChange={(open) => !open && setPermissionOpen(null)}
        onDecided={(decided) => {
          toast(
            decided.status === "approved"
              ? `Autorizado: ${decided.approvedRule}. Envie a tarefa de novo para continuar — a sessão do Claude Code é retomada.`
              : "Recusado. Nada foi autorizado e a execução continua parada.",
          );
          void loadPermissions();
        }}
      />
      <ProjectContextDialog
        project={contextProject}
        onOpenChange={(open) => !open && setContextProject(null)}
      />
      <PrepareProjectDialog
        project={prepareProject}
        onOpenChange={(open) => !open && setPrepareProject(null)}
        onPrepared={(workspaceId) => {
          // The project kept its id and its conversations; what changed is
          // where its runs execute. Reload so the tree shows the new folder
          // under the same project rather than as a second one.
          reload();
          void loadSessions();
          if (workspaceId !== workspace.id) onSelectWorkspace(workspaceId);
        }}
      />
      <ConfirmDialog
        open={removalPlan !== null}
        onOpenChange={(v) => !v && setRemovalPlan(null)}
        title="Remover projeto da lista?"
        description={removalPlan ? describeRemoval(removalPlan) : ""}
        confirmLabel="Remover da lista"
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
        cloudConnected={cloud?.configured ?? false}
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

/**
 * The removal confirmation, in the words of what actually happens.
 *
 * Every clause here is a fact from the main process, and the last two
 * sentences are the ones that matter: an act of organisation must never read
 * as if it might delete somebody's code, and the only way to make that clear
 * is to name the folder and the repository that stay exactly where they are.
 */
function describeRemoval(plan: ProjectRemovalPlanView): string {
  const lines = [`"${plan.projectName}" sai da lista de projetos.`];
  lines.push(
    plan.sessionsAffected > 0
      ? `Suas ${plan.sessionsAffected} conversa(s) vão para "Sem projeto" e continuam com todas as mensagens e execuções.`
      : "Ele não tem conversas.",
  );
  if (plan.localPath) lines.push(`A pasta ${plan.localPath} continua no disco, intacta.`);
  if (plan.repositoryFullName) {
    lines.push(`O repositório ${plan.repositoryFullName} continua no GitHub, intacto.`);
  }
  lines.push("Nenhum arquivo é apagado e nenhum comando do git é executado.");
  lines.push('Se quiser poder voltar atrás, use "Arquivar" no lugar.');
  return lines.join(" ");
}
