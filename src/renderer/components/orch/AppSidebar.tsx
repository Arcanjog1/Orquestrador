import {
  ChevronsLeft,
  ChevronsRight,
  Folder,
  History,
  Plug,
  Plus,
  Settings,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "@/router";
import type { ChatSessionView, WorkspaceView } from "@shared/ipc-contract";
import { SectionLabel } from "./primitives";

/**
 * The sidebar, exactly as approved.
 *
 * Widths (248 / 62), spacing, radii, hover and active treatments are the
 * design's. What changed is the content: `recentTasks` and `projects` were
 * sample arrays in the prototype and are now the workspace's real chat
 * sessions and the real registered projects, passed in by the workspace page.
 */
export function AppSidebar({
  collapsed,
  onToggle,
  onNewTask,
  sessions,
  workspaces,
  activeWorkspaceId,
  activeSessionId,
  onOpenSession,
  onOpenWorkspace,
  accountName,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onNewTask?: () => void;
  sessions: ChatSessionView[];
  workspaces: WorkspaceView[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  /** The default account's name, or null when none is connected yet. */
  accountName: string | null;
}) {
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
        {!collapsed && (
          <span className="truncate text-sm font-semibold">AI Orchestrator</span>
        )}
        <button
          onClick={onToggle}
          className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          aria-label={collapsed ? "Expandir sidebar" : "Recolher sidebar"}
        >
          {collapsed ? (
            <ChevronsRight className="size-4" />
          ) : (
            <ChevronsLeft className="size-4" />
          )}
        </button>
      </div>

      <div className="px-3">
        <button
          onClick={onNewTask}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border border-border-strong bg-sidebar-accent px-2.5 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10",
            collapsed && "justify-center px-0",
          )}
        >
          <Plus className="size-4 text-primary" />
          {!collapsed && "Nova tarefa"}
        </button>
      </div>

      <nav className="mt-5 flex-1 overflow-y-auto px-3 pb-3">
        {!collapsed && <SectionLabel>Recentes</SectionLabel>}
        <div className="mt-2 space-y-0.5">
          {sessions.map((t) => (
            <button
              key={t.id}
              onClick={() => onOpenSession(t.id)}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground",
                t.id === activeSessionId && "bg-sidebar-accent text-foreground",
                collapsed && "justify-center px-0",
              )}
              title={t.title}
            >
              <History className="size-4 shrink-0 text-muted-foreground" />
              {!collapsed && <span className="truncate">{t.title}</span>}
            </button>
          ))}
          {!collapsed && sessions.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma tarefa ainda.</p>
          )}
        </div>

        {!collapsed && (
          <div className="mt-6">
            <SectionLabel>Projetos</SectionLabel>
          </div>
        )}
        <div className={cn("space-y-0.5", collapsed ? "mt-4" : "mt-2")}>
          {workspaces.map((p) => (
            <button
              key={p.id}
              onClick={() => onOpenWorkspace(p.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-foreground",
                p.id === activeWorkspaceId && "bg-sidebar-accent text-foreground",
                collapsed && "justify-center px-0",
              )}
              title={p.displayName}
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              {!collapsed && <span className="truncate">{p.displayName}</span>}
            </button>
          ))}
          {!collapsed && workspaces.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhum projeto aberto.</p>
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
  if (parts.length === 0) return "—";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}
