import { useEffect, useState } from "react";
import { Check, Cloud, Copy, ExternalLink, Github, HardDrive, Loader2, MessageSquare, X } from "lucide-react";
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
  GitHubBranchView,
  GitHubRepositoryView,
  ProjectView,
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
                  <>
                    <pre
                      className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-surface p-2 text-[11px] whitespace-pre-wrap break-all text-muted-foreground"
                      data-testid="login-failure-detail"
                    >
                      {progress.detail}
                    </pre>
                    <button
                      className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground underline"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(progress.detail ?? "")
                          .then(() => setCopied(true))
                          .catch(() => setCopied(false));
                      }}
                      data-testid="login-failure-copy"
                    >
                      <Copy className="size-3" /> {copied ? "Copiado" : "Copiar detalhes"}
                    </button>
                  </>
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

/**
 * Adds a project — in the three ways a person actually has one.
 *
 * | | What it needs | What runs | Where the code is |
 * |---|---|---|---|
 * | **Repositório** | a GitHub link | analysis, planning, review | on GitHub |
 * | **Pasta** | a folder on this computer | everything, files included | on this computer |
 * | **Vazio** | a name | nothing yet | nowhere yet |
 * | **Nuvem** | a coordinator + a repository | everything, remotely | in the remote workspace |
 *
 * Connecting a repository **does not clone it**. Reading a public repository
 * over the API is a different act from checking one out, and turning "add this
 * to my sidebar" into a silent write to somebody's disk would be the wrong
 * shape of thing. Cloning is offered, separately and by name, under Pasta.
 *
 * A project created any of these ways is one project. Selecting the same
 * folder again, or pasting the same repository in another of its spellings,
 * opens what is already there.
 */
export function AddProjectDialog({
  open,
  onOpenChange,
  onAdded,
  githubConnected = false,
  cloudConnected = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: (workspaceId: string) => void;
  /** With a GitHub login the person picks from their repositories. */
  githubConnected?: boolean;
  /** With a coordinator connected, "Nuvem" is a real choice rather than a hint. */
  cloudConnected?: boolean;
}) {
  // "Repositório" is first: it is the way the person described wanting to
  // work — start from a repository, without cloning everything by hand first.
  const [mode, setMode] = useState<Mode>("repository");
  const [branches, setBranches] = useState<readonly GitHubBranchView[] | null>(null);
  const [branch, setBranch] = useState<string>("");
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [cloudRepo, setCloudRepo] = useState<GitHubRepositoryView | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<readonly GitHubRepositoryView[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repoQuery, setRepoQuery] = useState("");
  // What connecting a repository actually reported back, shown before the
  // dialog closes so the person sees the real branch rather than a promise.
  const [connected, setConnected] = useState<{
    project: ProjectView;
    created: boolean;
    metadataError: string | null;
  } | null>(null);

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

  // The chosen repository's branches, read from GitHub - a cloud project has
  // no working copy on this computer to read them from.
  useEffect(() => {
    if (mode !== "cloud" || !cloudRepo) {
      setBranches(null);
      setBranchesError(null);
      return;
    }
    let alive = true;
    setBranches(null);
    setBranchesError(null);
    setBranch(cloudRepo.defaultBranch);
    api.github
      .branches({ repository: cloudRepo.fullName })
      .then((list) => {
        if (!alive) return;
        setBranches(list);
        const preferred = list.find((b) => b.isDefault) ?? list[0];
        if (preferred) setBranch(preferred.name);
      })
      .catch((e: unknown) => alive && setBranchesError(messageOf(e)));
    return () => {
      alive = false;
    };
  }, [mode, cloudRepo]);

  useEffect(() => {
    if (!open) {
      setMode("repository");
      setCloudRepo(null);
      setBranch("");
      setUrl("");
      setName("");
      setConnected(null);
      setError(null);
    }
  }, [open]);

  const visibleRepos = (repos ?? [])
    .filter((r) => r.fullName.toLowerCase().includes(repoQuery.trim().toLowerCase()))
    .slice(0, 50);

  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : "Não foi possível adicionar o projeto.");

  /**
   * Opens the project, which is what makes it usable, and hands its workspace
   * back to the page. A project with no folder gets a conversation workspace:
   * real runs that read and reason, and touch no file.
   */
  const finish = async (projectId: string) => {
    const opened = await api.project.open({ projectId });
    onOpenChange(false);
    onAdded(opened.workspaceId);
  };

  /** Connects a repository. Reads its metadata; never clones it. */
  const connectRepository = async (repositoryUrl: string, suggestedName?: string) => {
    if (!repositoryUrl.trim()) return;
    setBusy("repository");
    setError(null);
    try {
      const result = await api.project.connectRepository({
        url: repositoryUrl.trim(),
        ...(suggestedName?.trim() ? { name: suggestedName.trim() } : {}),
      });
      setConnected(result);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  /** A project with nothing attached yet. The repository or folder comes later. */
  const createEmpty = async () => {
    if (!name.trim()) return;
    setBusy("empty");
    setError(null);
    try {
      const project = await api.project.create({ name: name.trim() });
      await finish(project.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const createCloud = async () => {
    if (!cloudRepo || !branch) return;
    setBusy("cloud");
    setError(null);
    try {
      const created = await api.workspace.createCloud({
        repository: cloudRepo.fullName,
        branch,
        name: cloudRepo.name,
        repositoryPrivate: cloudRepo.private,
      });
      onOpenChange(false);
      onAdded(created.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const pickFolder = async () => {
    setBusy("folder");
    setError(null);
    try {
      const { path } = await api.workspace.selectFolder();
      if (!path) return;
      // Open the folder's project, creating one only if it has none.
      //
      // This used to call `workspace.create`, which *refused* a folder it
      // already knew - so selecting a project again answered with an error,
      // and a folder spelled a different way became a second project. The
      // folder is the project; selecting it opens it.
      const opened = await api.workspace.openProject({ localPath: path });
      onOpenChange(false);
      onAdded(opened.workspace.id);
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
          <DialogDescription className="text-xs">{MODE_BLURB[mode]}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* How the project comes into being. Asked first, because it decides
              everything below it - a repository project never asks for a folder. */}
          <div className="grid grid-cols-4 gap-2" data-testid="environment-choice">
            {MODES.map((choice) => (
              <button
                key={choice}
                onClick={() => {
                  setMode(choice);
                  setConnected(null);
                  setError(null);
                }}
                disabled={busy !== null}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-[11px] transition-colors",
                  mode === choice
                    ? "border-primary/50 bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:border-primary/30",
                )}
                data-testid={`environment-${choice}`}
              >
                <ModeIcon mode={choice} />
                {MODE_LABEL[choice]}
              </button>
            ))}
          </div>

          {/* ---- Repository: connect, do not clone ---- */}
          {mode === "repository" && !connected && (
            <div className="space-y-3" data-testid="repository-project">
              <label className="block space-y-1.5">
                <span className="text-xs text-muted-foreground">Endereço do repositório</span>
                <Input
                  value={url}
                  autoFocus
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/dono/nome"
                  data-testid="repository-url"
                />
              </label>
              <Button
                className="w-full"
                disabled={busy !== null || url.trim().length === 0}
                onClick={() => void connectRepository(url)}
                data-testid="repository-connect"
              >
                {busy === "repository" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Conectar repositório"
                )}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                O repositório <strong>não</strong> é clonado. O aplicativo lê os arquivos pela API
                do GitHub — sem login para um repositório público — e usa a sua conexão do GitHub
                para os privados. Para alterar código, associe uma pasta depois.
              </p>
            </div>
          )}

          {/* What GitHub actually said, before anything is claimed about it. */}
          {mode === "repository" && connected && (
            <div className="space-y-3 rounded-lg border border-border p-3" data-testid="repository-connected">
              <div className="text-xs">
                {connected.created
                  ? `Projeto "${connected.project.name}" criado.`
                  : `Este repositório já era o projeto "${connected.project.name}". Abri esse.`}
              </div>
              <dl className="space-y-1 text-[11px]">
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">Repositório</dt>
                  <dd className="font-mono">{connected.project.repositoryFullName ?? "não informado"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">Branch padrão</dt>
                  <dd className="font-mono" data-testid="connected-default-branch">
                    {connected.project.defaultBranch ?? "não informado"}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">Visibilidade</dt>
                  <dd>
                    {connected.project.repositoryPrivate === null
                      ? "não informado"
                      : connected.project.repositoryPrivate
                        ? "privado"
                        : "público"}
                  </dd>
                </div>
              </dl>
              {connected.metadataError && (
                <p className="text-[11px] text-attention" data-testid="metadata-error">
                  O projeto foi criado, mas não consegui ler os dados do GitHub:{" "}
                  {connected.metadataError} A branch padrão fica como “não informado” até uma
                  próxima leitura — o aplicativo não vai supor que ela se chama <code>main</code>.
                </p>
              )}
              <Button
                className="w-full"
                onClick={() => void finish(connected.project.id)}
                data-testid="repository-open"
              >
                Abrir projeto
              </Button>
            </div>
          )}

          {/* ---- Empty: a name, and nothing else yet ---- */}
          {mode === "empty" && (
            <div className="space-y-3" data-testid="conversation-project">
              <label className="block space-y-1.5">
                <span className="text-xs text-muted-foreground">Nome do projeto</span>
                <Input
                  value={name}
                  autoFocus
                  placeholder="Arquitetura, Pesquisa, Planejamento…"
                  onChange={(e) => setName(e.target.value)}
                  data-testid="conversation-name"
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Para analisar, planejar, comparar e revisar. Associe um repositório ou uma pasta
                depois, pelo menu do projeto. Enquanto não houver pasta, nenhum arquivo é alterado
                — e o aplicativo não vai dizer que alterou.
              </p>
              <Button
                className="w-full"
                disabled={busy !== null || name.trim().length === 0}
                onClick={() => void createEmpty()}
                data-testid="conversation-create"
              >
                {busy === "empty" ? <Loader2 className="size-4 animate-spin" /> : "Criar projeto"}
              </Button>
            </div>
          )}

          {mode === "cloud" && !cloudConnected && (
            <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
              Conecte este computador a um coordenador em <strong>Configurações → Nuvem</strong> antes
              de criar um projeto de nuvem.
            </p>
          )}
          {mode === "cloud" && cloudConnected && !githubConnected && (
            <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
              Conecte o GitHub para escolher o repositório.
            </p>
          )}

          {mode === "folder" && (
            <button
              onClick={() => void pickFolder()}
              disabled={busy !== null}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground transition-colors",
                busy ? "opacity-60" : "hover:border-primary/40 hover:text-primary",
              )}
              data-testid="pick-folder"
            >
              {busy === "folder" && <Loader2 className="size-3.5 animate-spin" />}
              Selecionar pasta local
            </button>
          )}

          {githubConnected && mode !== "empty" && (
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
                      if (mode === "cloud") {
                        setCloudRepo(repo);
                        return;
                      }
                      setUrl(repo.cloneUrl);
                      setName(repo.name);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                      (mode === "cloud" ? cloudRepo?.fullName === repo.fullName : url === repo.cloneUrl) &&
                        "bg-accent",
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

          {mode === "cloud" && cloudRepo && (
            <div className="border-t border-border pt-4">
              <SectionLabel>Branch onde o trabalho começa</SectionLabel>
              {branchesError && <p className="mt-2 text-xs text-danger">{branchesError}</p>}
              {branches === null && !branchesError && (
                <p className="mt-2 text-xs text-muted-foreground">Lendo as branches…</p>
              )}
              {branches !== null && (
                <div className="mt-2 max-h-32 space-y-0.5 overflow-y-auto" data-testid="branch-list">
                  {branches.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      Este repositório não tem branches visíveis.
                    </p>
                  )}
                  {branches.map((b) => (
                    <button
                      key={b.name}
                      onClick={() => setBranch(b.name)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                        branch === b.name && "bg-accent",
                      )}
                      data-testid={`branch-${b.name}`}
                    >
                      <span className="truncate font-mono">{b.name}</span>
                      {b.isDefault && (
                        <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                          padrão
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <Button
                size="sm"
                className="mt-3 w-full"
                disabled={!cloudRepo || !branch || busy !== null || !cloudConnected}
                onClick={() => void createCloud()}
                data-testid="create-cloud-project"
              >
                {busy === "cloud" && <Loader2 className="size-3.5 animate-spin" />}
                Criar projeto na nuvem
              </Button>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Nenhuma pasta é criada neste computador. O repositório é clonado dentro do ambiente
                remoto quando a primeira tarefa começa.
              </p>
            </div>
          )}

          {mode === "repository" && !connected && githubConnected && url.trim() && (
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              disabled={busy !== null}
              onClick={() => void connectRepository(url, name)}
            >
              Conectar o repositório selecionado
            </Button>
          )}

          {mode === "folder" && (
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
          )}

          {error && <p className="text-xs text-danger" data-testid="add-project-error">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The four ways a project starts, in the order they are offered. */
const MODES = ["repository", "folder", "empty", "cloud"] as const;
type Mode = (typeof MODES)[number];
type Busy = "folder" | "clone" | "cloud" | "empty" | "repository" | null;

const MODE_LABEL: Record<Mode, string> = {
  repository: "Repositório",
  folder: "Pasta",
  empty: "Vazio",
  cloud: "Nuvem",
};

const MODE_BLURB: Record<Mode, string> = {
  repository:
    "O código fica no GitHub. O aplicativo lê os arquivos pela API oficial, sem clonar nada e sem login para repositórios públicos.",
  folder:
    "O Orquestrador trabalha dentro de uma pasta do seu computador. É o modo que altera arquivos de verdade.",
  empty:
    "Um projeto só com nome, para organizar conversas. Você associa o repositório ou a pasta quando quiser.",
  cloud:
    "O trabalho acontece em um ambiente isolado na nuvem. Nada é baixado para este computador, e a execução continua com o aplicativo fechado.",
};

function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === "cloud") return <Cloud className="size-3.5" />;
  if (mode === "repository") return <Github className="size-3.5" />;
  if (mode === "empty") return <MessageSquare className="size-3.5" />;
  return <HardDrive className="size-3.5" />;
}

/** The stages after which a sign-in attempt is over, one way or another. */
function isFinal(stage: string): boolean {
  return stage === "connected" || stage === "failed" || stage === "cancelled";
}
