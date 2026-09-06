import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, X } from "lucide-react";
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
import type { AccountProgressEvent, AccountView, WorkspaceView } from "@shared/ipc-contract";
import { api } from "@/lib/api";
import { AgentIdentity, ProviderIcon, SectionLabel, StatBlock } from "./primitives";
import { TeamForm } from "./TeamForm";

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
 * Provider, account, model and reasoning per role, saved with
 * `workspace.setTeam` - the binding the run refuses to start without.
 */
export function TeamDialog({
  open,
  onOpenChange,
  accounts,
  workspace,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accounts: readonly AccountView[];
  workspace: WorkspaceView | null;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">Equipe deste projeto</DialogTitle>
          <DialogDescription className="text-xs">
            Cada função tem provider, conta, modelo e nível de raciocínio próprios. As
            escolhas ficam salvas neste projeto.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <TeamForm
            workspace={workspace}
            accounts={accounts}
            onCancel={() => onOpenChange(false)}
            onSaved={() => {
              onOpenChange(false);
              onSaved();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setProgress(null);
      setCopied(false);
      return;
    }
    return api.events.accountProgress((event) => {
      if (accountId && event.accountId !== accountId) return;
      setProgress((previous) => {
        // A sign-in that has ended carries no page and no code, and neither
        // is kept: the code belongs to that attempt only. While it is still
        // going, a report that says nothing about them does not take away
        // what an earlier one said - the page opened and the code to type
        // must stay on screen until the person is done with them.
        if (isFinal(event.stage)) return event;
        return {
          ...event,
          ...(event.url ?? previous?.url ? { url: event.url ?? previous?.url } : {}),
          ...(event.code ?? previous?.code ? { code: event.code ?? previous?.code } : {}),
        };
      });
    });
  }, [open, accountId]);

  const stage = progress?.stage ?? "starting";
  const done = stage === "connected";
  const failed = stage === "failed" || stage === "cancelled";
  const code = !done && !failed ? progress?.code : undefined;

  const copyCode = () => {
    if (!code) return;
    // The page's own clipboard API: no bridge, no Node, a user gesture.
    void navigator.clipboard
      ?.writeText(code)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

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
            {code && (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">Código do dispositivo</div>
                <div
                  data-testid="device-code"
                  className="select-all font-mono text-2xl tracking-[0.3em] text-primary"
                >
                  {code}
                </div>
                <Button size="sm" variant="secondary" data-testid="copy-device-code" onClick={copyCode}>
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Copiado" : "Copiar código"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Digite esse código na página aberta no navegador.
                </p>
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

/** The stages after which a sign-in attempt is over, one way or another. */
function isFinal(stage: string): boolean {
  return stage === "connected" || stage === "failed" || stage === "cancelled";
}
