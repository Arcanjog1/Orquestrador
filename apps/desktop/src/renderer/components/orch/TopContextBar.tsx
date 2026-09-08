import { useState } from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  ExternalLink,
  FolderOpen,
  GitBranch,
  HardDrive,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Agent, RunState } from "@/lib/orchestrator-data";
import type {
  GitHubStatusView,
  PullRequestStatusView,
  WorkspaceBranchesView,
  WorkspaceView,
} from "@shared/ipc-contract";
import {
  AgentIdentity,
  ProviderIcon,
  SectionLabel,
  StatusPill,
  StatBlock,
} from "./primitives";

function Chip({
  children,
  className,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      className={cn(
        "inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 text-xs text-foreground/90 transition-colors hover:border-border-strong hover:bg-accent",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** "owner/repo" from a remote URL, or null when there is no remote. */
function repoOf(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const match = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl);
  return match?.[1] ?? null;
}

/**
 * The top context bar, exactly as approved.
 *
 * Every chip keeps its dimensions, popover width and content layout. The facts
 * are the workspace's own: the repository comes from its recorded remote and
 * the branch from the working copy git actually reports. A chip with nothing
 * behind it says so rather than showing a sample value.
 */
export function TopContextBar({
  state,
  iteration,
  onEditTeam,
  workspace,
  workspaces,
  team,
  onOpenExternal,
  onOpenWorkspace,
  onAddProject,
  onRenameWorkspace,
  onRemoveWorkspace,
  onOpenFolder,
  branches,
  onRefreshBranches,
  onCheckout,
  switching = null,
  github,
  pullRequest,
  onRefreshPullRequest,
  onOpenGitHubSettings,
  onFetch,
  onCreateBranch,
  onCommit,
  onPush,
  onPullRequest,
}: {
  state: RunState;
  iteration: number;
  onEditTeam: () => void;
  workspace: WorkspaceView | null;
  workspaces: readonly WorkspaceView[];
  team: Agent[];
  onOpenExternal: (url: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onAddProject: () => void;
  onRenameWorkspace: () => void;
  onRemoveWorkspace: () => void;
  onOpenFolder: () => void;
  /** What git reports for the working copy; null until read. */
  branches: WorkspaceBranchesView | null;
  onRefreshBranches: () => void;
  onCheckout: (branch: string) => void;
  /** The branch being switched to, while git works. */
  switching?: string | null;
  github: GitHubStatusView | null;
  /** Pull requests and checks for the current branch; null until read. */
  pullRequest: PullRequestStatusView | null;
  onRefreshPullRequest: () => void;
  onOpenGitHubSettings: () => void;
  onFetch: () => void;
  onCreateBranch: () => void;
  onCommit: () => void;
  onPush: () => void;
  onPullRequest: () => void;
}) {
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [query, setQuery] = useState("");

  const isCloud = workspace?.environment === "cloud";
  // A conversation project has no working copy anywhere, so the git chip and
  // its actions would be offering something that cannot happen.
  const isConversation = workspace?.environment === "conversation";
  const branch = workspace?.branch ?? workspace?.defaultBranch ?? "—";
  // A cloud project's repository is the one it was created for, named as
  // GitHub names it; a local project's is inferred from its remote.
  const repository = isCloud ? workspace?.repository ?? null : repoOf(workspace?.repositoryUrl ?? null);
  const filtered = workspaces.filter((w) =>
    w.name.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-chrome px-4">
      {/* Where this project's work runs. Not decorative: a person about to send
          a task needs to know whether it will touch their own disk. */}
      <Chip
        data-testid="environment-chip"
        // One word is not enough to act on. The tooltip says the consequence:
        // whether sending this task can change a file on this computer, and
        // whether closing the application ends it.
        title={
          isCloud
            ? "Nuvem: a execução acontece no coordenador conectado e continua com o aplicativo fechado. Nenhum arquivo deste computador é alterado."
            : isConversation
              ? "Conversa: os agentes analisam, planejam e revisam. Nenhum arquivo é alterado, em lugar nenhum. Associe uma pasta para alterar código."
              : `Local: o Codex e o Claude Code rodam neste computador e alteram arquivos em ${workspace?.localPath || "esta pasta"}. Fechar o aplicativo encerra a execução.`
        }
      >
        {isCloud ? (
          <Cloud className="size-3" />
        ) : isConversation ? (
          <MessageSquare className="size-3" />
        ) : (
          <HardDrive className="size-3" />
        )}
        {isCloud ? "Nuvem" : isConversation ? "Conversa" : "Local"}
      </Chip>
      {/* GitHub chip: who is signed in, this project's remote, and the git
          actions. Absent for a conversation project: there is no working copy
          to commit, push or open a pull request from, and offering the buttons
          would promise something the project cannot do. */}
      {!isConversation && (
      <Popover onOpenChange={(open) => open && onRefreshPullRequest()}>
        <PopoverTrigger asChild>
          <button data-testid="github-chip">
            <Chip>
              <ProviderIcon provider="github" className="size-3.5" />
              GitHub
              <span className="text-muted-foreground">
                · {github?.connected ? github.login : repository ? repository.split("/")[0] : "sem login"}
              </span>
              {pullRequest?.checks && pullRequest.checks.total > 0 && (
                <span
                  className={cn(
                    "size-2 rounded-full",
                    pullRequest.checks.failure > 0
                      ? "bg-danger"
                      : pullRequest.checks.completed === pullRequest.checks.total
                        ? "bg-success"
                        : "bg-running",
                  )}
                  aria-label="Estado dos checks"
                />
              )}
              <ChevronDown className="size-3 text-muted-foreground" />
            </Chip>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-3">
          <div className="flex items-center gap-2">
            <ProviderIcon provider="github" />
            <span className="text-sm font-semibold">GitHub</span>
            <span
              className={cn(
                "ml-auto inline-flex items-center gap-1 text-xs",
                github?.connected ? "text-success" : "text-muted-foreground",
              )}
            >
              {github?.connected ? (
                <>
                  <Check className="size-3" /> {github.login}
                </>
              ) : (
                <button onClick={onOpenGitHubSettings} className="text-primary hover:underline">
                  Conectar em Contas
                </button>
              )}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <StatBlock
              label="Repository"
              value={<span className="font-mono text-xs">{pullRequest?.repository ?? repository ?? "sem remoto"}</span>}
            />
            <StatBlock
              label="Branch"
              value={<span className="font-mono text-xs">{branch}</span>}
            />
          </div>
          {pullRequest && pullRequest.repository && (
            <div className="rounded-md border border-border bg-surface-raised p-2.5 text-xs">
              {pullRequest.pullRequests.length > 0 ? (
                pullRequest.pullRequests.map((pr) => (
                  <button
                    key={pr.number}
                    onClick={() => onOpenExternal(pr.htmlUrl)}
                    className="flex w-full items-center gap-2 text-left hover:underline"
                  >
                    <span className="font-mono text-primary">#{pr.number}</span>
                    <span className="truncate">{pr.title}</span>
                  </button>
                ))
              ) : (
                <span className="text-muted-foreground">
                  {github?.connected ? "Nenhum pull request aberto para esta branch." : "Conecte o GitHub para ver pull requests e checks."}
                </span>
              )}
              {pullRequest.checks && pullRequest.checks.total > 0 && (
                <div className="mt-1.5 text-muted-foreground">
                  Checks: {pullRequest.checks.success} ok · {pullRequest.checks.failure} falhas ·{" "}
                  {pullRequest.checks.total - pullRequest.checks.completed} em andamento
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {isCloud ? (
              <p className="text-xs text-muted-foreground" data-testid="cloud-git-note">
                Este projeto roda na nuvem: fetch, commit e push acontecem dentro do ambiente
                remoto, não neste computador.
              </p>
            ) : (
              <>
            <Button size="sm" variant="secondary" onClick={onFetch} disabled={!workspace} data-testid="git-fetch">
              Fetch
            </Button>
            <Button size="sm" variant="secondary" onClick={onCreateBranch} disabled={!workspace} data-testid="git-branch">
              Nova branch
            </Button>
            <Button size="sm" variant="secondary" onClick={onCommit} disabled={!workspace} data-testid="git-commit">
              Commit
            </Button>
            <Button size="sm" onClick={onPush} disabled={!workspace} data-testid="git-push">
              Push
            </Button>
              </>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={onPullRequest}
              disabled={!github?.connected || !(pullRequest?.repository ?? repository)}
              data-testid="git-pr"
            >
              Abrir PR
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!(pullRequest?.repository ?? repository)}
              onClick={() => {
                const target = pullRequest?.repository ?? repository;
                if (target) onOpenExternal(`https://github.com/${target}`);
              }}
            >
              <ExternalLink className="size-3.5" /> Abrir no GitHub
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      )}

      {/* Project chip */}
      <Popover>
        <PopoverTrigger asChild>
          <button data-testid="project-chip">
            <Chip>
              <span className="truncate">{workspace?.name ?? "Nenhum projeto"}</span>
              {/* The folder, next to the name.
                  A project's name is editable and never touches the disk, so
                  the name alone cannot answer "which folder am I about to
                  change?" - and that is the question worth answering before a
                  worker writes a file. Only the last two segments: the whole
                  path would push everything else off the bar, and the tail is
                  what distinguishes two folders that share a name. */}
              {workspace?.localPath ? (
                <span
                  className="truncate font-mono text-[11px] text-muted-foreground"
                  title={workspace.localPath}
                  data-testid="project-chip-path"
                >
                  {tailOf(workspace.localPath)}
                </span>
              ) : null}
              <ChevronDown className="size-3 text-muted-foreground" />
            </Chip>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Pesquisar projeto"
              className="h-7 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.map((w) => (
              <button
                key={w.id}
                onClick={() => onOpenWorkspace(w.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              >
                <Check
                  className={cn(
                    "size-3.5 text-primary",
                    w.id === workspace?.id ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">{w.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                  {w.branch ?? "—"}
                </span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                Nenhum projeto.
              </p>
            )}
          </div>
          {workspace && (
            <div className="border-t border-border p-1">
              <div className="px-2 pt-1 pb-0.5 text-[11px] text-muted-foreground">
                {workspace.name}
              </div>
              <button
                onClick={onRenameWorkspace}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
                data-testid="rename-workspace"
              >
                <Pencil className="size-3.5 text-muted-foreground" /> Renomear projeto
              </button>
              {!isCloud && (
                <button
                  onClick={onOpenFolder}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
                  data-testid="open-workspace-folder"
                >
                  <FolderOpen className="size-3.5 text-muted-foreground" /> Abrir pasta
                </button>
              )}
              <button
                onClick={onRemoveWorkspace}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-danger transition-colors hover:bg-accent"
                data-testid="remove-workspace"
              >
                <Trash2 className="size-3.5" /> Remover da lista
              </button>
            </div>
          )}
          <div className="border-t border-border p-1">
            <button
              onClick={onAddProject}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-primary transition-colors hover:bg-accent"
            >
              <Plus className="size-3.5" /> Adicionar projeto
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Branch chip: the branches git knows, and a switch that asks first.
          Controlled, so choosing a branch closes it: an open popover that
          survives the switch turns the next click on the chip into a close. */}
      <Popover
        open={branchesOpen}
        onOpenChange={(open) => {
          setBranchesOpen(open);
          if (open) onRefreshBranches();
        }}
      >
        <PopoverTrigger asChild>
          <button data-testid="branch-chip">
            <Chip>
              <GitBranch className="size-3.5 text-muted-foreground" />
              <span className="truncate font-mono">{branch}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </Chip>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <SectionLabel>Branch</SectionLabel>
            <button
              onClick={onRefreshBranches}
              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Reler branches"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto p-1" data-testid="branch-list">
            {!branches && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">Lendo o git…</p>
            )}
            {branches && !branches.isRepository && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                Esta pasta não é um repositório git, ou o Git ainda não está configurado.
              </p>
            )}
            {branches?.isRepository &&
              branches.local.map((name) => (
                <button
                  key={name}
                  onClick={() => {
                    setBranchesOpen(false);
                    if (name !== branches.current) onCheckout(name);
                  }}
                  disabled={switching !== null}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-accent disabled:opacity-60"
                  data-testid={`branch-${name}`}
                >
                  {switching === name ? (
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                  ) : (
                    <Check
                      className={cn(
                        "size-3.5 text-primary",
                        name === branches.current ? "opacity-100" : "opacity-0",
                      )}
                    />
                  )}
                  <span className="truncate">{name}</span>
                </button>
              ))}
            {branches?.isRepository && branches.remote.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-0.5 text-[11px] text-muted-foreground">Remotas</div>
                {branches.remote.map((name) => (
                  <button
                    key={name}
                    onClick={() => {
                      setBranchesOpen(false);
                      onCheckout(name);
                    }}
                    disabled={switching !== null}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
                    data-testid={`branch-${name}`}
                  >
                    <span className="size-3.5" />
                    <span className="truncate">{name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
          {branches?.isRepository && (
            <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              {branches.dirtyFiles > 0
                ? `${branches.dirtyFiles} alteração(ões) não commitada(s). Trocar de branch pedirá confirmação.`
                : "Árvore limpa. O Orquestrador nunca troca de branch sozinho."}
            </p>
          )}
        </PopoverContent>
      </Popover>

      {/* Orchestrator team chip */}
      <Popover>
        <PopoverTrigger asChild>
          <button data-testid="team-chip">
            <Chip className="border-primary/25 bg-primary/10">
              <Users className="size-3.5 text-primary" />
              Orquestrador
              <ChevronDown className="size-3 text-muted-foreground" />
            </Chip>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[22rem] space-y-3">
          <SectionLabel>Equipe de agentes</SectionLabel>
          <div className="space-y-2">
            {team.map((agent) => (
              <div
                key={agent.role}
                className="rounded-lg border border-border bg-surface-raised p-2.5"
              >
                <AgentIdentity agent={agent} />
                <div className="mt-1.5 text-xs text-muted-foreground">
                  Conta: {agent.account ?? "nenhuma"}
                </div>
              </div>
            ))}
            {team.length === 0 && (
              <p className="rounded-lg border border-border bg-surface-raised p-2.5 text-xs text-muted-foreground">
                Nenhum agente atribuído a este projeto ainda.
              </p>
            )}
          </div>
          <Button size="sm" className="w-full" onClick={onEditTeam} data-testid="edit-team">
            Editar equipe
          </Button>
        </PopoverContent>
      </Popover>

      <button
        onClick={onAddProject}
        className="grid size-7 place-items-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        aria-label="Adicionar projeto"
        data-testid="add-workspace"
      >
        <Plus className="size-3.5" />
      </button>

      <div className="ml-auto">
        <StatusPill state={state} iteration={iteration || undefined} />
      </div>
    </div>
  );
}


/**
 * The tail of a path: the last two segments, which is what tells two folders
 * apart without spending the whole bar on a path nobody reads in full. The
 * complete path is the element's `title`.
 */
function tailOf(localPath: string): string {
  const segments = localPath.split(/[\\/]/).filter((part) => part.length > 0);
  if (segments.length <= 2) return localPath;
  return `…${localPath.includes('\\') ? '\\' : '/'}${segments.slice(-2).join(localPath.includes('\\') ? '\\' : '/')}`;
}
