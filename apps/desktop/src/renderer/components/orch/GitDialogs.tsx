import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { api, messageOf } from "@/lib/api";
import type { GitOperationResult, PullRequestView, WorkspaceView } from "@shared/ipc-contract";

/**
 * The three git actions that need a word from the person: a commit message,
 * a branch name, a pull-request title. Each runs the real command through
 * the bridge and reports what git said.
 */

function useSubmit<T>(run: () => Promise<T>, onDone: (result: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await run());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit, setError };
}

export function CommitDialog({
  open,
  onOpenChange,
  workspace,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: WorkspaceView;
  onDone: (result: GitOperationResult) => void;
}) {
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (open) setMessage("");
  }, [open]);
  const { busy, error, submit } = useSubmit(
    () => api.workspace.commit({ workspaceId: workspace.id, message: message.trim() }),
    (result) => {
      onOpenChange(false);
      onDone(result);
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Criar commit</DialogTitle>
          <DialogDescription className="text-xs">
            Todas as alterações do projeto entram neste commit, na branch{" "}
            <span className="font-mono">{workspace.branch ?? "atual"}</span>.
          </DialogDescription>
        </DialogHeader>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          placeholder="Mensagem do commit"
          className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary/40"
          data-testid="commit-message"
          autoFocus
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !message.trim()} data-testid="commit-save">
            {busy && <Loader2 className="size-3.5 animate-spin" />} Commit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreateBranchDialog({
  open,
  onOpenChange,
  workspace,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: WorkspaceView;
  onDone: (result: GitOperationResult) => void;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  const { busy, error, submit } = useSubmit(
    () => api.workspace.createBranch({ workspaceId: workspace.id, name: name.trim() }),
    (result) => {
      onOpenChange(false);
      onDone(result);
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Nova branch</DialogTitle>
          <DialogDescription className="text-xs">
            Criada a partir de <span className="font-mono">{workspace.branch ?? "HEAD"}</span> e
            ativada em seguida.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="feature/minha-mudanca"
          className="font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) void submit();
          }}
          data-testid="branch-name"
          autoFocus
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !name.trim()} data-testid="branch-create">
            {busy && <Loader2 className="size-3.5 animate-spin" />} Criar branch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PullRequestDialog({
  open,
  onOpenChange,
  workspace,
  base,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: WorkspaceView;
  /** The branch the pull request targets, when the project knows it. */
  base: string | null;
  onDone: (pr: PullRequestView) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [target, setTarget] = useState("");
  useEffect(() => {
    if (open) {
      setTitle("");
      setBody("");
      setTarget(base ?? "");
    }
  }, [open, base]);
  const { busy, error, submit } = useSubmit(
    () =>
      api.github.createPullRequest({
        workspaceId: workspace.id,
        title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(target.trim() ? { base: target.trim() } : {}),
      }),
    (pr) => {
      onOpenChange(false);
      onDone(pr);
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Abrir pull request</DialogTitle>
          <DialogDescription className="text-xs">
            De <span className="font-mono">{workspace.branch ?? "?"}</span> para a branch base. Faça
            o push antes: o GitHub só vê o que foi enviado.
          </DialogDescription>
        </DialogHeader>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título" data-testid="pr-title" autoFocus />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder="Descrição (opcional)"
          className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary/40"
        />
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="Branch base (ex.: main)"
          className="font-mono text-xs"
          data-testid="pr-base"
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !title.trim()} data-testid="pr-create">
            {busy && <Loader2 className="size-3.5 animate-spin" />} Abrir pull request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
