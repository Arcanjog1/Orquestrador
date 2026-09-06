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
import type {
  AccountProgressEvent,
  AccountView,
  GitHubRepositoryView,
  WorkspaceView,
} from "@shared/ipc-contract";
import { api, messageOf } from "@/lib/api";
import { AgentIdentity, ProviderIcon, SectionLabel, StatBlock } from "./primitives";
import { TeamForm } from "./TeamForm";

/**
 * The dialogs, exactly as approved.
 *
 * Sizes, headers and layout are the design's. The prototype fed them from
 * `diffFiles`, `evidence` and `team` sample objects; each one now reads what
 * the application actually holds, and says plainly when it holds nothing.
 */

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

/**
 * Renames one thing - a conversation, a project. The caller does the save,
 * so the dialog is the same for both and never decides which channel to call.
 */
export function RenameDialog({
  open,
  title,
  description,
  value,
  onOpenChange,
  onSave,
  testid = "rename",
}: {
  open: boolean;
  title: string;
  description: string;
  value: string;
  onOpenChange: (v: boolean) => void;
  onSave: (next: string) => Promise<void>;
  testid?: string;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(value);
      setError(null);
    }
  }, [open, value]);

  const save = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.trim());
      onOpenChange(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          maxLength={200}
          autoFocus
          data-testid={`${testid}-title`}
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || !draft.trim()}
            data-testid={`${testid}-save`}
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />} Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Renames a conversation; saving is `chat.renameSession`. */
export function RenameSessionDialog({
  session,
  onOpenChange,
  onRenamed,
}: {
  session: { id: string; title: string } | null;
  onOpenChange: (v: boolean) => void;
  onRenamed: () => void;
}) {
  return (
    <RenameDialog
      open={session !== null}
      title="Renomear conversa"
      description="O novo título aparece em Recentes e no histórico."
      value={session?.title ?? ""}
      onOpenChange={onOpenChange}
      testid="rename-session"
      onSave={async (title) => {
        if (!session) return;
        await api.chat.renameSession({ sessionId: session.id, title });
        onRenamed();
      }}
    />
  );
}

/**
 * A yes/no for something that cannot be undone. The caller does the work in
 * `onConfirm`, so the dialog itself never touches the bridge.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Voltar
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy} data-testid="confirm">
            {busy && <Loader2 className="size-3.5 animate-spin" />} {confirmLabel}
          </Button>
        </DialogFooter>
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
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    if (!open) {
      setProgress(null);
      setCopied(false);
      setShowDetail(false);
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
            <div
              className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/[0.07] p-3 text-sm text-danger"
              data-testid="login-failure"
            >
              <X className="mt-0.5 size-4 shrink-0" />
              <span>{progress?.label ?? "O login não foi concluído."}</span>
            </div>
            {progress?.detail && (
              <div>
                <button
                  className="text-xs text-muted-foreground underline"
                  onClick={() => setShowDetail((v) => !v)}
                  data-testid="login-failure-details"
                >
                  {showDetail ? "Ocultar detalhes" : "Detalhes"}
                </button>
                {showDetail && (
                  <pre
                    className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-surface p-2 text-[11px] whitespace-pre-wrap break-all text-muted-foreground"
                    data-testid="login-failure-detail"
                  >
                    {progress.detail}
                  </pre>
                )}
              </div>
            )}
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
  githubConnected = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: (workspaceId: string) => void;
  /** With a GitHub login the person picks from their repositories. */
  githubConnected?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"folder" | "clone" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<readonly GitHubRepositoryView[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repoQuery, setRepoQuery] = useState("");

  // The person's repositories, read once per opening, private ones included.
  useEffect(() => {
    if (!open || !githubConnected) {
      setRepos(null);
      setReposError(null);
      setRepoQuery("");
      return;
    }
    let alive = true;
    api.github
      .repositories()
      .then((list) => alive && setRepos(list))
      .catch((e: unknown) => alive && setReposError(messageOf(e)));
    return () => {
      alive = false;
    };
  }, [open, githubConnected]);

  const visibleRepos = (repos ?? [])
    .filter((r) => r.fullName.toLowerCase().includes(repoQuery.trim().toLowerCase()))
    .slice(0, 50);

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

          {githubConnected && (
            <div className="border-t border-border pt-4">
              <SectionLabel>Seus repositórios no GitHub</SectionLabel>
              <Input
                value={repoQuery}
                onChange={(e) => setRepoQuery(e.target.value)}
                placeholder="Buscar repositório"
                className="mt-2 h-8 text-xs"
                data-testid="repo-search"
              />
              <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto" data-testid="repo-list">
                {repos === null && !reposError && (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">Lendo seus repositórios…</p>
                )}
                {reposError && <p className="px-2 py-1.5 text-xs text-danger">{reposError}</p>}
                {repos !== null && visibleRepos.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhum repositório encontrado.</p>
                )}
                {visibleRepos.map((repo) => (
                  <button
                    key={repo.fullName}
                    onClick={() => {
                      setUrl(repo.cloneUrl);
                      setName(repo.name);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                      url === repo.cloneUrl && "bg-accent",
                    )}
                    data-testid={`repo-${repo.fullName}`}
                  >
                    <span className="truncate font-mono">{repo.fullName}</span>
                    {repo.private && (
                      <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                        privado
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-border pt-4">
            <SectionLabel>{githubConnected ? "Ou informe a URL" : "Ou clonar do GitHub"}</SectionLabel>
            <div className="mt-2 space-y-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/…"
                data-testid="clone-url"
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
