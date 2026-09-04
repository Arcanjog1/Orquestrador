import { useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  GitBranch,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Agent, RunState } from "@/lib/orchestrator-data";
import type { WorkspaceView } from "@shared/ipc-contract";
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
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
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
}) {
  const [query, setQuery] = useState("");

  const branch = workspace?.branch ?? workspace?.defaultBranch ?? "—";
  const repository = repoOf(workspace?.repositoryUrl ?? null);
  const filtered = workspaces.filter((w) =>
    w.name.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-chrome px-4">
      {/* GitHub chip */}
      <Popover>
        <PopoverTrigger asChild>
          <button>
            <Chip>
              <ProviderIcon provider="github" className="size-3.5" />
              GitHub
              <span className="text-muted-foreground">
                · {repository ? repository.split("/")[0] : "sem remoto"}
              </span>
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
                repository ? "text-success" : "text-muted-foreground",
              )}
            >
              {repository ? (
                <>
                  <Check className="size-3" /> Remoto configurado
                </>
              ) : (
                "Sem remoto"
              )}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <StatBlock label="Conta" value={repository ? repository.split("/")[0] : "—"} />
            <StatBlock
              label="Branch"
              value={<span className="font-mono text-xs">{branch}</span>}
            />
          </div>
          <StatBlock
            label="Repository"
            value={<span className="font-mono text-xs">{repository ?? "—"}</span>}
          />
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button size="sm" variant="secondary" onClick={onAddProject}>
              Trocar repositório
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!repository}
              onClick={() => repository && onOpenExternal(`https://github.com/${repository}`)}
            >
              <ExternalLink className="size-3.5" /> Abrir no GitHub
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Project chip */}
      <Popover>
        <PopoverTrigger asChild>
          <button>
            <Chip>
              <span className="truncate">{workspace?.name ?? "Nenhum projeto"}</span>
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

      {/* Branch chip */}
      <Popover>
        <PopoverTrigger asChild>
          <button>
            <Chip>
              <GitBranch className="size-3.5 text-muted-foreground" />
              <span className="truncate font-mono">{branch}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </Chip>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-3">
          <SectionLabel>Branch</SectionLabel>
          <StatBlock
            label="Working copy"
            value={<span className="font-mono text-xs">{workspace?.branch ?? "—"}</span>}
          />
          <StatBlock
            label="Branch padrão"
            value={<span className="font-mono text-xs">{workspace?.defaultBranch ?? "—"}</span>}
          />
          <p className="text-xs text-muted-foreground">
            O Orquestrador nunca troca de branch sozinho. Faça o checkout no projeto e a
            barra acompanha.
          </p>
        </PopoverContent>
      </Popover>

      {/* Orchestrator team chip */}
      <Popover>
        <PopoverTrigger asChild>
          <button>
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
          <div className="rounded-lg border border-dashed border-border p-2.5 text-xs text-muted-foreground">
            Em breve: Reviewer dedicado, Test Agent, Research Agent e Gemini (Image
            Generator).
          </div>
          <Button size="sm" className="w-full" onClick={onEditTeam}>
            Editar equipe
          </Button>
        </PopoverContent>
      </Popover>

      <button
        onClick={onAddProject}
        className="grid size-7 place-items-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        aria-label="Adicionar projeto"
      >
        <Plus className="size-3.5" />
      </button>

      <div className="ml-auto">
        <StatusPill state={state} iteration={iteration || undefined} />
      </div>
    </div>
  );
}
