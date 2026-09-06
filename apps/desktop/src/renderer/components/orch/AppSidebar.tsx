import { useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Folder,
  FolderInput,
  FolderKanban,
  History,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
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
import type { ChatSessionView, ProjectView, WorkspaceView } from "@shared/ipc-contract";
import { SectionLabel } from "./primitives";

/** What the tree can do to one conversation. */
export interface SessionActions {
  rename: (session: ChatSessionView) => void;
  archive: (session: ChatSessionView, archived: boolean) => void;
  remove: (session: ChatSessionView) => void;
  /** Files the conversation under a project, or under none. */
  move: (session: ChatSessionView, projectId: string | null) => void;
}

/** What the tree can do to one project. */
export interface ProjectActions {
  create: () => void;
  rename: (project: ProjectView) => void;
  linkWorkspace: (project: ProjectView) => void;
  remove: (project: ProjectView) => void;
  /** A conversation born inside the project. */
  newSession: (project: ProjectView | null) => void;
}

/** The id the "Sem projeto" group uses in the collapse state. */
const NO_PROJECT = "__none__";

/**
 * The sidebar.
 *
 * Widths (248 / 62), spacing, radii, hover and active treatments are the
 * design's. The content is real and organised by **project**: every project
 * is a row the person created (a real entity, with its conversations filed
 * under it), then "Sem projeto" for the rest, and "Recentes" across all of
 * them. A search narrows the tree and says which project each hit is in.
 * The folders the agents work in ("Pastas") stay reachable below.
 */
export function AppSidebar({
  collapsed,
  onToggle,
  onNewTask,
  sessions,
  projects,
  workspaces,
  activeWorkspaceId,
  activeSessionId,
  onOpenSession,
  onOpenWorkspace,
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
  /** Every conversation, of every project and folder. */
  sessions: readonly ChatSessionView[];
  projects: readonly ProjectView[];
  workspaces: readonly WorkspaceView[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
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
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const searching = (search ?? "").trim().length > 0;

  const groups = useMemo(() => {
    const byProject = new Map<string, ChatSessionView[]>();
    for (const session of sessions) {
      const key = session.projectId ?? NO_PROJECT;
      const list = byProject.get(key) ?? [];
      list.push(session);
      byProject.set(key, list);
    }
    return {
      projects: projects.map((project) => ({ project, sessions: byProject.get(project.id) ?? [] })),
      loose: byProject.get(NO_PROJECT) ?? [],
    };
  }, [sessions, projects]);

  const recents = useMemo(() => sessions.filter((s) => !s.archivedAt).slice(0, 5), [sessions]);

  const toggleFold = (key: string) => setFolded((prev) => ({ ...prev, [key]: !prev[key] }));

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
        {t.archivedAt ? (
          <Archive className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <History className="size-4 shrink-0 text-muted-foreground" />
        )}
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
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onClick={() => sessionActions.rename(t)} data-testid={`rename-session-${t.id}`}>
              <Pencil className="size-3.5" /> Renomear
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid={`move-session-${t.id}`}>
                <FolderInput className="size-3.5" /> Mover para projeto
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                {projects.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    disabled={project.id === t.projectId}
                    onClick={() => sessionActions.move(t, project.id)}
                    data-testid={`move-session-${t.id}-to-${project.id}`}
                  >
                    <FolderKanban className="size-3.5" /> {project.name}
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

  const renderGroup = (
    key: string,
    title: string,
    list: readonly ChatSessionView[],
    project: ProjectView | null,
  ) => {
    const open = searching || !folded[key];
    return (
      <div key={key} className="mt-1" data-testid={project ? `project-${project.id}` : "project-none"}>
        <div
          className={cn(
            "group flex items-center gap-1 rounded-md pr-1 text-xs font-medium text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground",
            menuFor === key && "bg-sidebar-accent text-foreground",
          )}
        >
          <button
            onClick={() => toggleFold(key)}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left"
            data-testid={project ? `toggle-project-${project.id}` : "toggle-project-none"}
            title={project?.workspaceName ? `Pasta: ${project.workspaceName}` : undefined}
          >
            {open ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <FolderKanban className="size-3.5 shrink-0 text-primary/80" />
            <span className="truncate">{title}</span>
            <span className="ml-auto pl-1 text-[10px] text-muted-foreground">{list.length}</span>
          </button>
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
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuItem onClick={() => projectActions.rename(project)} data-testid={`rename-project-${project.id}`}>
                  <Pencil className="size-3.5" /> Renomear
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => projectActions.linkWorkspace(project)} data-testid={`link-project-${project.id}`}>
                  <Folder className="size-3.5" />
                  {project.workspaceName ? `Pasta: ${project.workspaceName}` : "Vincular a uma pasta"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => projectActions.remove(project)}
                  className="text-danger focus:text-danger"
                  data-testid={`delete-project-${project.id}`}
                >
                  <Trash2 className="size-3.5" /> Excluir projeto
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {open && (
          <div className="ml-3 space-y-0.5 border-l border-sidebar-border pl-1">
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
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-[62px]" : "w-[248px]",
      )}
    >
      <div className="flex h-14 items-center gap-2 px-3">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/15">
          <Sparkles className="size-4 text-primary" />
        </div>
        {!collapsed && <span className="truncate text-sm font-semibold">AI Orchestrator</span>}
        <button
          onClick={onToggle}
          className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          aria-label={collapsed ? "Expandir sidebar" : "Recolher sidebar"}
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
        >
          <Plus className="size-4 text-primary" />
          {!collapsed && "Nova tarefa"}
        </button>
      </div>

      <nav className="mt-5 flex-1 overflow-y-auto px-3 pb-3">
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

        {/* Search: one flat list across projects, each hit naming its project. */}
        {!collapsed && searching && (
          <div className="mt-3" data-testid="search-results">
            <SectionLabel>Resultados</SectionLabel>
            <div className="mt-2 space-y-0.5" data-testid="session-list">
              {sessions.map((t) => renderSession(t, true))}
              {sessions.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma conversa com esse título.</p>
              )}
            </div>
          </div>
        )}

        {!collapsed && !searching && (
          <>
            {recents.length > 0 && (
              <div className="mt-3">
                <SectionLabel>Recentes</SectionLabel>
                <div className="mt-2 space-y-0.5" data-testid="recent-list">
                  {recents.map((t) => renderSession(t, true))}
                </div>
              </div>
            )}

            <div className="mt-5 flex items-center justify-between">
              <SectionLabel>Projetos</SectionLabel>
              <div className="flex items-center gap-2">
                {onShowArchived && (
                  <button
                    onClick={() => onShowArchived(!showArchived)}
                    className={cn(
                      "text-[11px] text-muted-foreground transition-colors hover:text-foreground",
                      showArchived && "text-primary",
                    )}
                    data-testid="toggle-archived"
                  >
                    {showArchived ? "Ocultar arquivadas" : "Arquivadas"}
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
              {groups.projects.map(({ project, sessions: list }) => renderGroup(project.id, project.name, list, project))}
              {renderGroup(NO_PROJECT, "Sem projeto", groups.loose, null)}
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
          </>
        )}

        {!collapsed && (
          <div className="mt-6">
            <SectionLabel>Pastas</SectionLabel>
          </div>
        )}
        <div className={cn("space-y-0.5", collapsed ? "mt-4" : "mt-2")} data-testid="workspace-list">
          {workspaces.map((p) => (
            <button
              key={p.id}
              onClick={() => onOpenWorkspace(p.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground",
                p.id === activeWorkspaceId && "bg-sidebar-accent text-foreground",
                collapsed && "justify-center px-0",
              )}
              title={p.localPath}
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              {!collapsed && <span className="truncate">{p.name}</span>}
            </button>
          ))}
          {!collapsed && workspaces.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma pasta aberta.</p>
          )}
        </div>
      </nav>

      <div className="space-y-0.5 border-t border-sidebar-border p-3">
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
    </aside>
  );
}

/** Up to two initials from the account's name, or a neutral placeholder. */
function initialsOf(name: string | null): string {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${second}`.toUpperCase() || "—";
}
