import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Cloud,
  Folder,
  FolderInput,
  Github,
  History,
  MessagesSquare,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plug,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Users,
  FolderGit2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Link } from "@/router";
import type { ChatSessionView, ProjectView } from "@shared/ipc-contract";
import { SectionLabel } from "./primitives";

/** What the tree can do to one conversation. */
export interface SessionActions {
  rename: (session: ChatSessionView) => void;
  archive: (session: ChatSessionView, archived: boolean) => void;
  remove: (session: ChatSessionView) => void;
  /** Files the conversation under a project, or under none. */
  move: (session: ChatSessionView, projectId: string | null) => void;
  /** Opens the run history and details of the conversation's latest run. */
  openHistory: (session: ChatSessionView) => void;
}

/** What the tree can do to one project. */
export interface ProjectActions {
  create: () => void;
  open: (project: ProjectView) => void;
  rename: (project: ProjectView) => void;
  /** The project's own settings: name, repository, folder. */
  settings: (project: ProjectView) => void;
  /** What the agents are told about this project. */
  context: (project: ProjectView) => void;
  /** Give the project a folder to work in: associate one, or clone. */
  prepare: (project: ProjectView) => void;
  archive: (project: ProjectView, archived: boolean) => void;
  remove: (project: ProjectView) => void;
  /** A conversation born inside the project. */
  newSession: (project: ProjectView | null) => void;
}

/** The id the "Sem projeto" group uses in the collapse state. */
const NO_PROJECT = "__none__";

const COLLAPSED_WIDTH = 62;
const MIN_WIDTH = 208;
const MAX_WIDTH = 440;
const DEFAULT_WIDTH = 264;
const WIDTH_KEY = "orchestrator.sidebar.width";
const FOLD_KEY = "orchestrator.sidebar.folded";

/**
 * The sidebar: one tree, and only one.
 *
 * It used to have three lists — Recentes, Projetos and Pastas — and the same
 * folder could be in two of them at once, which is the confusion this rewrite
 * exists to end. There is now exactly one hierarchy:
 *
 * ```
 * PROJETO
 *   ├── Conversa 1
 *   ├── Conversa 2
 *   └── …
 * ```
 *
 * A project is the repository or the folder; the conversations are independent
 * sessions inside it. "Pastas" is gone as a section — not as a capability: a
 * folder is now shown *as* its project, with a folder badge, and the folder
 * actions live in the project's menu where a person would look for them.
 *
 * Two groups sit outside the projects, and only when they have something in
 * them: **Sem projeto**, for conversations that belong to none, and
 * **Arquivados**, so putting a project away is visibly reversible.
 *
 * The width is a drag away and is remembered; collapsing leaves a 62px rail of
 * icons. Searching flattens the tree and names the project each hit is in, so
 * a conversation inside a collapsed project is still findable — which was the
 * point of collapsing being safe.
 */
export function AppSidebar({
  collapsed,
  onToggle,
  onNewTask,
  sessions,
  projects,
  activeProjectId,
  activeSessionId,
  onOpenSession,
  accountName,
  sessionActions,
  projectActions,
  search,
  onSearch,
  showArchived,
  onShowArchived,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onNewTask?: () => void;
  /** Every conversation, of every project. */
  sessions: readonly ChatSessionView[];
  /** Every project, archived ones included; this component groups them. */
  projects: readonly ProjectView[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  /** The first connected account's name, or null when none is connected. */
  accountName: string | null;
  sessionActions?: SessionActions;
  projectActions?: ProjectActions;
  /** Title filter and archive toggle, owned by the page so the list is real. */
  search?: string;
  onSearch?: (query: string) => void;
  showArchived?: boolean;
  onShowArchived?: (show: boolean) => void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>(readFolded);
  const [width, setWidth] = useState<number>(readWidth);
  const [dragging, setDragging] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);
  const searching = (search ?? "").trim().length > 0;

  // Remembered across restarts, because a width a person chose and lost is
  // worse than one they never chose.
  useEffect(() => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* a browser with storage disabled still gets a working sidebar */
    }
  }, [width]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FOLD_KEY, JSON.stringify(folded));
    } catch {
      /* same */
    }
  }, [folded]);

  const onDragStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = asideRef.current?.getBoundingClientRect().width ?? width;
      setDragging(true);

      const move = (moveEvent: PointerEvent) => {
        const next = clampWidth(startWidth + (moveEvent.clientX - startX));
        setWidth(next);
      };
      const stop = () => {
        setDragging(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
    },
    [collapsed, width],
  );

  const { active, archived, loose } = useMemo(() => {
    const byProject = new Map<string, ChatSessionView[]>();
    for (const session of sessions) {
      const key = session.projectId ?? NO_PROJECT;
      const list = byProject.get(key) ?? [];
      list.push(session);
      byProject.set(key, list);
    }
    const withSessions = (project: ProjectView) => ({
      project,
      sessions: byProject.get(project.id) ?? [],
    });
    return {
      active: projects.filter((p) => !p.archivedAt).map(withSessions),
      archived: projects.filter((p) => p.archivedAt).map(withSessions),
      loose: byProject.get(NO_PROJECT) ?? [],
    };
  }, [sessions, projects]);

  const toggleFold = (key: string) => setFolded((prev) => ({ ...prev, [key]: !prev[key] }));

  // Opening a conversation inside a folded project unfolds it. Otherwise a
  // new conversation, correctly filed, is invisible - and "it went somewhere
  // else" is exactly what an invisible correct answer looks like.
  const openSessionProjectId = sessions.find((s) => s.id === activeSessionId)?.projectId ?? null;
  useEffect(() => {
    const key = openSessionProjectId ?? NO_PROJECT;
    setFolded((prev) => (prev[key] ? { ...prev, [key]: false } : prev));
  }, [openSessionProjectId, activeSessionId]);

  const renderSession = (t: ChatSessionView, withProject: boolean) => (
    <div
      key={t.id}
      className={cn(
        "group flex w-full items-center gap-1 rounded-md text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground",
        (t.id === activeSessionId || menuFor === t.id) && "bg-sidebar-accent text-foreground",
        t.archivedAt && "text-sidebar-foreground/55",
      )}
      data-testid={`session-${t.id}`}
      data-project-id={t.projectId ?? ""}
    >
      <button
        onClick={() => onOpenSession(t.id)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left",
          collapsed && "justify-center px-0",
        )}
        title={t.projectName ? `${t.projectName} · ${t.title}` : t.title}
        data-testid={`open-session-${t.id}`}
      >
        <SessionMark session={t} />
        {!collapsed && (
          <span className="min-w-0 truncate">
            {withProject && (
              <span className="text-muted-foreground">{t.projectName ?? "Sem projeto"} · </span>
            )}
            {t.title}
          </span>
        )}
      </button>
      {!collapsed && sessionActions && (
        <DropdownMenu open={menuFor === t.id} onOpenChange={(open) => setMenuFor(open ? t.id : null)}>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100",
                menuFor === t.id && "opacity-100",
              )}
              aria-label={`Opções de ${t.title}`}
              data-testid={`session-menu-${t.id}`}
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem onClick={() => sessionActions.rename(t)} data-testid={`rename-session-${t.id}`}>
              <Pencil className="size-3.5" /> Renomear
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => sessionActions.openHistory(t)}
              disabled={!t.lastRun}
              data-testid={`history-session-${t.id}`}
            >
              <History className="size-3.5" /> Histórico e detalhes
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid={`move-session-${t.id}`}>
                <FolderInput className="size-3.5" /> Mover para projeto
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-52">
                {projects
                  .filter((project) => !project.archivedAt)
                  .map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      disabled={project.id === t.projectId}
                      onClick={() => sessionActions.move(t, project.id)}
                      data-testid={`move-session-${t.id}-to-${project.id}`}
                    >
                      <ProjectIcon project={project} className="size-3.5" /> {project.name}
                    </DropdownMenuItem>
                  ))}
                {projects.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  disabled={t.projectId === null}
                  onClick={() => sessionActions.move(t, null)}
                  data-testid={`move-session-${t.id}-to-none`}
                >
                  Sem projeto
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              onClick={() => sessionActions.archive(t, !t.archivedAt)}
              data-testid={`archive-session-${t.id}`}
            >
              {t.archivedAt ? (
                <>
                  <ArchiveRestore className="size-3.5" /> Desarquivar
                </>
              ) : (
                <>
                  <Archive className="size-3.5" /> Arquivar
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => sessionActions.remove(t)}
              className="text-danger focus:text-danger"
              data-testid={`delete-session-${t.id}`}
            >
              <Trash2 className="size-3.5" /> Apagar
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  const renderProject = (project: ProjectView | null, list: readonly ChatSessionView[]) => {
    const key = project?.id ?? NO_PROJECT;
    const title = project?.name ?? "Sem projeto";
    // A search opens every project: a hit inside a folded one must be visible,
    // or collapsing a project would quietly hide it from search.
    const open = searching || !folded[key];
    const isActive = project !== null && project.id === activeProjectId;
    return (
      <div key={key} className="mt-0.5" data-testid={project ? `project-${project.id}` : "project-none"}>
        <div
          className={cn(
            "group flex items-center gap-1 rounded-md pr-1 text-[13px] font-medium text-sidebar-foreground/90 transition-colors hover:bg-sidebar-accent hover:text-foreground",
            (menuFor === key || isActive) && "bg-sidebar-accent text-foreground",
            project?.archivedAt && "text-sidebar-foreground/55",
          )}
          data-active={isActive ? "true" : "false"}
        >
          <button
            onClick={() => toggleFold(key)}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
            aria-label={open ? `Recolher ${title}` : `Expandir ${title}`}
            aria-expanded={open}
            data-testid={project ? `toggle-project-${project.id}` : "toggle-project-none"}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <button
            onClick={() => (project && projectActions ? projectActions.open(project) : toggleFold(key))}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
            title={project ? describeProject(project) : "Conversas que não estão em nenhum projeto"}
            data-testid={project ? `open-project-${project.id}` : "open-project-none"}
          >
            {project ? (
              <ProjectIcon project={project} className="size-3.5 shrink-0 text-primary/85" />
            ) : (
              <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{title}</span>
          </button>
          {list.length > 0 && (
            <span
              className="shrink-0 px-1 text-[10px] tabular-nums text-muted-foreground group-hover:opacity-0"
              data-testid={project ? `count-project-${project.id}` : "count-project-none"}
            >
              {list.length}
            </span>
          )}
          {projectActions && (
            <button
              onClick={() => projectActions.newSession(project)}
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100"
              aria-label={`Nova conversa em ${title}`}
              title="Nova conversa neste projeto"
              data-testid={project ? `new-session-in-${project.id}` : "new-session-in-none"}
            >
              <Plus className="size-3.5" />
            </button>
          )}
          {projectActions && project && (
            <DropdownMenu open={menuFor === key} onOpenChange={(o) => setMenuFor(o ? key : null)}>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100",
                    menuFor === key && "opacity-100",
                  )}
                  aria-label={`Opções de ${project.name}`}
                  data-testid={`project-menu-${project.id}`}
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem onClick={() => projectActions.open(project)} data-testid={`open-project-menu-${project.id}`}>
                  <ProjectIcon project={project} className="size-3.5" /> Abrir
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => projectActions.newSession(project)}
                  data-testid={`new-session-menu-${project.id}`}
                >
                  <Plus className="size-3.5" /> Nova conversa
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => projectActions.rename(project)} data-testid={`rename-project-${project.id}`}>
                  <Pencil className="size-3.5" /> Renomear
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => projectActions.settings(project)} data-testid={`settings-project-${project.id}`}>
                  <Settings className="size-3.5" /> Configurações
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => projectActions.context(project)} data-testid={`context-project-${project.id}`}>
                  <NotebookPen className="size-3.5" /> Contexto do projeto
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => projectActions.prepare(project)} data-testid={`prepare-project-${project.id}`}>
                  <FolderGit2 className="size-3.5" /> Preparar para codar
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => projectActions.archive(project, !project.archivedAt)}
                  data-testid={`archive-project-${project.id}`}
                >
                  {project.archivedAt ? (
                    <>
                      <ArchiveRestore className="size-3.5" /> Restaurar
                    </>
                  ) : (
                    <>
                      <Archive className="size-3.5" /> Arquivar
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => projectActions.remove(project)}
                  className="text-danger focus:text-danger"
                  data-testid={`delete-project-${project.id}`}
                >
                  <Trash2 className="size-3.5" /> Remover da lista
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {open && (
          <div className="ml-[18px] space-y-px border-l border-sidebar-border pl-1.5">
            {list.map((t) => renderSession(t, false))}
            {list.length === 0 && (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">
                {searching ? "Nada com esse título." : "Nenhuma conversa ainda."}
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      ref={asideRef}
      style={collapsed ? undefined : { width }}
      className={cn(
        "guild-sidebar relative flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar",
        collapsed && "w-[62px]",
        // The transition is on width, and it has to be off while dragging or
        // the handle lags a frame behind the pointer and feels broken.
        !dragging && "transition-[width] duration-200",
      )}
      data-testid="app-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <div className="guild-brand flex h-14 items-center gap-2 px-3">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/15">
          <Sparkles className="size-4 text-primary" />
        </div>
        {!collapsed && <span className="truncate text-sm font-semibold">AI Orchestrator</span>}
        <button
          onClick={onToggle}
          className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          aria-label={collapsed ? "Expandir sidebar" : "Recolher sidebar"}
          data-testid="toggle-sidebar"
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
        </button>
      </div>

      <div className="px-3">
        <button
          onClick={onNewTask}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border border-border-strong bg-sidebar-accent px-2.5 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10",
            collapsed && "justify-center px-0",
          )}
          data-testid="new-task"
          title="Nova tarefa"
        >
          <Plus className="size-4 text-primary" />
          {!collapsed && "Nova tarefa"}
        </button>
      </div>

      <nav className="mt-4 flex-1 overflow-y-auto px-3 pb-3">
        {!collapsed && onSearch && (
          <label className="flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={search ?? ""}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Buscar conversas"
              className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              data-testid="session-search"
            />
          </label>
        )}

        {/* Search: one flat list across projects, each hit naming its project,
            so a conversation inside a collapsed project is still findable. */}
        {!collapsed && searching && (
          <div className="mt-3" data-testid="search-results">
            <SectionLabel>Resultados</SectionLabel>
            <div className="mt-2 space-y-px" data-testid="session-list">
              {sessions.map((t) => renderSession(t, true))}
              {sessions.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma conversa com esse título.</p>
              )}
            </div>
          </div>
        )}

        {!collapsed && !searching && (
          <>
            <div className="mt-4 flex items-center justify-between">
              <SectionLabel>Guilda · Projetos</SectionLabel>
              <div className="flex items-center gap-2">
                {onShowArchived && (
                  <button
                    onClick={() => onShowArchived(!showArchived)}
                    className={cn(
                      "text-[11px] text-muted-foreground transition-colors hover:text-foreground",
                      showArchived && "text-primary",
                    )}
                    data-testid="toggle-archived"
                    title="Mostrar também o que foi arquivado"
                  >
                    {showArchived ? "Ocultar arquivados" : "Arquivados"}
                  </button>
                )}
                {projectActions && (
                  <button
                    onClick={projectActions.create}
                    className="grid size-5 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                    aria-label="Novo projeto"
                    title="Novo projeto"
                    data-testid="new-project"
                  >
                    <Plus className="size-3.5" />
                  </button>
                )}
              </div>
            </div>

            <div className="mt-1" data-testid="session-list">
              {active.map(({ project, sessions: list }) => renderProject(project, list))}

              {/* Only when it holds something: an empty "Sem projeto" row is a
                  permanent reminder of a state the person is not in. */}
              {loose.length > 0 && renderProject(null, loose)}

              {active.length === 0 && loose.length === 0 && (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  Nenhum projeto ainda. Conecte um repositório ou abra uma pasta.
                </p>
              )}

              {projectActions && (
                <button
                  onClick={projectActions.create}
                  className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                  data-testid="new-project-row"
                >
                  <Plus className="size-3.5" /> Novo projeto
                </button>
              )}
            </div>

            {archived.length > 0 && (
              <div className="mt-5" data-testid="archived-projects">
                <SectionLabel>Arquivados</SectionLabel>
                <div className="mt-1">
                  {archived.map(({ project, sessions: list }) => renderProject(project, list))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Collapsed: a rail of projects, so the tree is still navigable. */}
        {collapsed && (
          <div className="mt-4 space-y-0.5" data-testid="project-rail">
            {active.map(({ project }) => (
              <button
                key={project.id}
                onClick={() => projectActions?.open(project)}
                className={cn(
                  "flex w-full justify-center rounded-md px-0 py-1.5 text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground",
                  project.id === activeProjectId && "bg-sidebar-accent text-foreground",
                )}
                title={describeProject(project)}
                data-testid={`rail-project-${project.id}`}
              >
                <ProjectIcon project={project} className="size-4" />
              </button>
            ))}
          </div>
        )}
      </nav>

      <div className="space-y-0.5 border-t border-sidebar-border p-3">
        <Link to="/configuracoes" search={{tab:'agents'}} aria-label="Guilda · Agentes e modelos"
          className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground',collapsed && 'justify-center px-0')}>
          <Users className="size-4 text-muted-foreground"/>{!collapsed && 'Guilda · Agentes e modelos'}
        </Link>
        <Link
          to="/historico"
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground",
            collapsed && "justify-center px-0",
          )}
        >
          <History className="size-4 text-muted-foreground" />
          {!collapsed && "Histórico de execuções"}
        </Link>
        <Link
          to="/configuracoes"
          search={{ tab: "general" }}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground",
            collapsed && "justify-center px-0",
          )}
        >
          <Settings className="size-4 text-muted-foreground" />
          {!collapsed && "Configurações"}
        </Link>
        <Link
          to="/configuracoes"
          search={{ tab: "accounts" }}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground",
            collapsed && "justify-center px-0",
          )}
        >
          <Plug className="size-4 text-muted-foreground" />
          {!collapsed && "Contas e integrações"}
        </Link>

        <div
          className={cn(
            "mt-2 flex items-center gap-2 rounded-md px-2 py-1.5",
            collapsed && "justify-center px-0",
          )}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
            {initialsOf(accountName)}
          </span>
          {!collapsed && (
            <div className="min-w-0">
              <div className="truncate text-sm">{accountName ?? "Nenhuma conta"}</div>
              <div className="truncate text-xs text-muted-foreground">Local · Desktop</div>
            </div>
          )}
        </div>
      </div>

      {/* The resize handle. Four pixels wide, on the border, and inert while
          collapsed - dragging a 62px rail wider would fight the toggle. */}
      {!collapsed && (
        <div
          onPointerDown={onDragStart}
          onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionar a barra lateral"
          title="Arraste para redimensionar; duplo clique para o padrão"
          data-testid="sidebar-resize"
          className={cn(
            "absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize",
            "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-primary/40",
            dragging && "after:bg-primary/60",
          )}
        />
      )}
    </aside>
  );
}

/**
 * What a project is, in one glyph.
 *
 * GitHub when it has a repository, a cloud when it runs elsewhere, a folder
 * when it is a directory on this computer, and a conversation bubble when it
 * is none of those — which is a real, useful kind of project here, not a
 * missing value.
 */
function ProjectIcon({ project, className }: { project: ProjectView; className?: string }) {
  if (project.repositoryFullName) return <Github className={className} data-kind="repository" />;
  if (project.environment === "cloud") return <Cloud className={className} data-kind="cloud" />;
  if (project.localPath) return <Folder className={className} data-kind="folder" />;
  return <MessagesSquare className={className} data-kind="conversation" />;
}

/** The tooltip: where this project's work happens, said plainly. */
function describeProject(project: ProjectView): string {
  const lines = [project.name];
  if (project.repositoryFullName) {
    lines.push(
      `GitHub: ${project.repositoryFullName}${project.defaultBranch ? ` · ${project.defaultBranch}` : ""}`,
    );
  }
  if (project.localPath) lines.push(`Pasta: ${project.localPath}`);
  if (project.environment === "cloud") lines.push("Execução remota");
  else if (project.environment === "conversation") lines.push("Só conversa: nenhum arquivo é alterado");
  else if (project.localPath) lines.push("Execução local, neste computador");
  if (project.archivedAt) lines.push("Arquivado");
  return lines.join("\n");
}

/**
 * The conversation's state, as one small mark.
 *
 * Discreet on purpose: a running conversation should be findable at a glance
 * without the sidebar turning into a status board.
 */
function SessionMark({ session }: { session: ChatSessionView }) {
  if (session.archivedAt) {
    return <Archive className="size-4 shrink-0 text-muted-foreground" />;
  }
  const status = session.lastRun?.status ?? null;
  const running = status === "RUNNING" || status === "PENDING";
  return (
    <span
      className="grid size-4 shrink-0 place-items-center"
      data-testid={`session-state-${session.id}`}
      data-state={status ?? "none"}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          running && "animate-pulse bg-running",
          status === "FAILED" && "bg-danger",
          status === "DONE" && "bg-success",
          (status === null || status === "CANCELLED") && "bg-muted-foreground/50",
        )}
      />
    </span>
  );
}

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

function readWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function readFolded(): Record<string, boolean> {
  try {
    const stored = window.localStorage.getItem(FOLD_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Up to two initials from the account's name, or a neutral placeholder. */
function initialsOf(name: string | null): string {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${second}`.toUpperCase() || "—";
}

export const SIDEBAR_COLLAPSED_WIDTH = COLLAPSED_WIDTH;
