import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Agent } from "@/lib/orchestrator-data";
import type { TimelineEntry } from "@/lib/timeline";
import type { AccountProgressEvent, AgentView, WorkspaceView } from "@shared/ipc-contract";
import { api } from "@/lib/api";
import { AgentIdentity, ProviderIcon, SectionLabel, StatBlock } from "./primitives";

/**
 * The dialogs, exactly as approved.
 *
 * Sizes, headers and layout are the design's. The prototype fed them from
 * `diffFiles`, `evidence` and `team` sample objects; each one now reads what
 * the application actually holds, and says plainly when it holds nothing.
 */

function EmptyBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid place-items-center px-6 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function DiffDialog({
  open,
  onOpenChange,
  workspace,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: WorkspaceView | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm">Alterações do run</DialogTitle>
          <DialogDescription className="text-xs">
            {workspace?.localPath ?? "Nenhum projeto aberto."}
          </DialogDescription>
        </DialogHeader>
        <EmptyBody>
          O diff de cada iteração é coletado e arquivado pelo orquestrador, mas a
          interface ainda não lê esses arquivos do disco.
          <br />
          Use o Git do projeto para revisar as alterações.
        </EmptyBody>
      </DialogContent>
    </Dialog>
  );
}

export function EvidenceDialog({
  open,
  onOpenChange,
  workspace,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: WorkspaceView | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Evidence</DialogTitle>
          <DialogDescription className="text-xs">
            Provas coletadas pelo sistema, não afirmações dos agentes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div>
            <SectionLabel>Git</SectionLabel>
            <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <StatBlock
                label="Branch"
                value={<span className="font-mono text-xs">{workspace?.branch ?? "—"}</span>}
              />
              <StatBlock
                label="Branch padrão"
                value={
                  <span className="font-mono text-xs">{workspace?.defaultBranch ?? "—"}</span>
                }
              />
              <StatBlock
                label="Local"
                value={<span className="font-mono text-xs">{workspace?.localPath ?? "—"}</span>}
              />
            </div>
          </div>
          <div className="border-t border-border pt-4">
            <SectionLabel>Verifications</SectionLabel>
            <p className="mt-2 text-sm text-muted-foreground">
              O orquestrador executa apenas verificações cadastradas por id no workspace, e
              registra o resultado de cada uma. A interface ainda não lista esses
              registros por execução.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AgentDetailDialog({
  entry,
  onOpenChange,
}: {
  entry: Extract<TimelineEntry, { kind: "agent" }> | null;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={!!entry} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {entry && (
          <>
            <DialogHeader>
              <DialogTitle className="text-sm">Invocação do agente</DialogTitle>
              <DialogDescription className="text-xs">
                Instrução, resultado e evidências. Raciocínio interno não é exibido.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <AgentIdentity agent={entry.agent} />
              <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
                <StatBlock label="Conta" value={entry.agent.account ?? "—"} />
                <StatBlock label="Duração" value={entry.duration} />
              </div>
              <div className="border-t border-border pt-4">
                <SectionLabel>Result</SectionLabel>
                <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                  <p className="text-foreground/90">{entry.headline}</p>
                  {entry.lines.map((l) => (
                    <p key={l}>{l}</p>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function CancelDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Cancelar execução?</DialogTitle>
          <DialogDescription>
            As alterações já realizadas permanecerão no projeto.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Voltar
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Cancelar execução
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The team dialog.
 *
 * Assigns the ORCHESTRATOR and CODING_WORKER roles for this workspace, which is
 * a real operation - `workspace.setAgents` - and the one the run refuses to
 * start without.
 */
export function TeamDialog({
  open,
  onOpenChange,
  team,
  agents,
  workspace,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  team: Agent[];
  agents: readonly AgentView[];
  workspace: WorkspaceView | null;
  onSaved: () => void;
}) {
  const orchestrators = agents.filter((a) => a.role === "ORCHESTRATOR");
  const workers = agents.filter((a) => a.role === "CODING_WORKER");
  const [orchestratorId, setOrchestratorId] = useState<string>("");
  const [workerId, setWorkerId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setOrchestratorId(workspace?.orchestratorAgentId ?? orchestrators[0]?.id ?? "");
    setWorkerId(workspace?.workerAgentId ?? workers[0]?.id ?? "");
  }, [open, workspace, agents]);

  const save = async () => {
    if (!workspace || !orchestratorId || !workerId) return;
    setSaving(true);
    setError(null);
    try {
      await api.workspace.setAgents({
        workspaceId: workspace.id,
        orchestratorAgentId: orchestratorId,
        workerAgentId: workerId,
      });
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível salvar a equipe.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">Equipe deste projeto</DialogTitle>
          <DialogDescription className="text-xs">
            Cada função tem provider, conta, modelo e nível de raciocínio próprios.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {team.map((agent) => (
            <div
              key={agent.role}
              className="rounded-lg border border-border bg-surface-raised p-3"
            >
              <div className="flex items-center gap-2">
                <ProviderIcon provider={agent.provider} />
                <SectionLabel>{agent.role}</SectionLabel>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field
                  label="Provider"
                  value={agent.provider === "openai" ? "OpenAI" : "Anthropic"}
                />
                <Field label="Account" value={agent.account ?? "—"} />
              </div>
            </div>
          ))}

          <div className="rounded-lg border border-border bg-surface-raised p-3">
            <SectionLabel>Atribuir funções</SectionLabel>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Picker
                label="Orchestrator"
                value={orchestratorId}
                options={orchestrators}
                onChange={setOrchestratorId}
              />
              <Picker
                label="Coding worker"
                value={workerId}
                options={workers}
                onChange={setWorkerId}
              />
            </div>
            {agents.length === 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                Nenhum agente disponível. Conecte uma conta OpenAI e uma Anthropic em
                Contas e integrações.
              </p>
            )}
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
            Preparado para Reviewer dedicado, Test Agent, Research Agent e Gemini (Image
            Generator).
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving || !orchestratorId || !workerId}>
            {saving && <Loader2 className="size-3.5 animate-spin" />} Salvar equipe
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly AgentView[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="mt-1 h-8 text-xs">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs">
        {value}
      </div>
    </div>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  onAction,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAction: (action: string) => void;
}) {
  const items = [
    "Nova tarefa",
    "Trocar projeto",
    "Configurar agentes",
    "Contas e integrações",
    "Configurações",
    "Histórico de execuções",
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Paleta de comandos</DialogTitle>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Buscar comando…" />
          <CommandList>
            <CommandEmpty>Nenhum comando encontrado.</CommandEmpty>
            <CommandGroup heading="Ações">
              {items.map((i) => (
                <CommandItem
                  key={i}
                  onSelect={() => {
                    onAction(i);
                    onOpenChange(false);
                  }}
                >
                  {i}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The sign-in dialog.
 *
 * The prototype offered "Simular sucesso" / "Simular erro" buttons and a fixed
 * ABCD-EFGH code. Both are gone: this follows the real `account:progress`
 * events, and the code it shows is the one the CLI actually printed.
 */
export function LoginDialog({
  open,
  onOpenChange,
  provider,
  accountId,
  onRetry,
  onCancel,
  onOpenExternal,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  provider: string;
  accountId: string | null;
  onRetry: () => void;
  onCancel: () => void;
  onOpenExternal: (url: string) => void;
}) {
  const [progress, setProgress] = useState<AccountProgressEvent | null>(null);

  useEffect(() => {
    if (!open) {
      setProgress(null);
      return;
    }
    return api.events.accountProgress((event) => {
      if (!accountId || event.accountId === accountId) setProgress(event);
    });
  }, [open, accountId]);

  const stage = progress?.stage ?? "starting";
  const done = stage === "connected";
  const failed = stage === "failed" || stage === "cancelled";

  // A connected account closes the dialog by itself, after the confirmation
  // has been on screen long enough to be read. Failure stays open: it carries
  // the reason and the retry button.
  useEffect(() => {
    if (!open || !done) return;
    const timer = setTimeout(() => onOpenChange(false), 1500);
    return () => clearTimeout(timer);
  }, [open, done, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !done) onCancel();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {done ? `${provider} conectado` : `Conectando ${provider}…`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {failed
              ? "Não conseguimos concluir o login."
              : "Seu navegador foi aberto para autorizar o acesso."}
          </DialogDescription>
        </DialogHeader>

        {!done && !failed && (
          <div className="space-y-4 text-center">
            {progress?.code && (
              <div className="font-mono text-2xl tracking-[0.3em] text-primary">
                {progress.code}
              </div>
            )}
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="size-2 animate-pulse rounded-full bg-running" />
              {progress?.label ?? "Aguardando autorização…"}
            </div>
            {progress?.url && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onOpenExternal(progress.url!)}
              >
                <ExternalLink className="size-3.5" /> Abrir o navegador de novo
              </Button>
            )}
            {!progress?.url && <Loader2 className="mx-auto size-5 animate-spin text-running" />}
          </div>
        )}

        {done && (
          <div className="flex items-center gap-2 text-sm text-success">
            <Check className="size-4" /> {provider} conectado com sucesso.
          </div>
        )}

        {failed && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/[0.07] p-3 text-sm text-danger">
              <X className="mt-0.5 size-4 shrink-0" />
              {progress?.label ?? "O login não foi concluído."}
            </div>
            <Button size="sm" onClick={onRetry}>
              Tentar novamente
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Adds a project: pick a folder, or clone a repository. Both are real. */
export function AddProjectDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: (workspaceId: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"folder" | "clone" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : "Não foi possível adicionar o projeto.");

  const pickFolder = async () => {
    setBusy("folder");
    setError(null);
    try {
      const { path } = await api.workspace.selectFolder();
      if (!path) return;
      const created = await api.workspace.create({
        name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
        localPath: path,
      });
      onOpenChange(false);
      onAdded(created.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const clone = async () => {
    if (!url.trim()) return;
    setBusy("clone");
    setError(null);
    try {
      const { path } = await api.workspace.selectFolder();
      if (!path) return;
      const created = await api.workspace.clone({
        repositoryUrl: url.trim(),
        parentPath: path,
        name: name.trim() || (url.trim().split("/").pop() ?? "projeto").replace(/\.git$/, ""),
      });
      onOpenChange(false);
      onAdded(created.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Adicionar projeto</DialogTitle>
          <DialogDescription className="text-xs">
            O Orquestrador trabalha dentro de uma pasta do seu computador.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <button
            onClick={() => void pickFolder()}
            disabled={busy !== null}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground transition-colors",
              busy ? "opacity-60" : "hover:border-primary/40 hover:text-primary",
            )}
          >
            {busy === "folder" && <Loader2 className="size-3.5 animate-spin" />}
            Selecionar pasta local
          </button>

          <div className="border-t border-border pt-4">
            <SectionLabel>Ou clonar do GitHub</SectionLabel>
            <div className="mt-2 space-y-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/…"
              />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome da pasta (opcional)"
              />
              <Button
                size="sm"
                className="w-full"
                disabled={!url.trim() || busy !== null}
                onClick={() => void clone()}
              >
                {busy === "clone" && <Loader2 className="size-3.5 animate-spin" />} Escolher
                pasta e clonar
              </Button>
            </div>
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
