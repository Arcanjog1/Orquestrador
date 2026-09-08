import { useEffect, useState } from "react";
import { Github, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, messageOf } from "@/lib/api";
import type { ProjectView, WorkspaceView } from "@shared/ipc-contract";

/** Radix Select cannot hold an empty string; this stands for "no folder". */
const NONE = "__none__";

/**
 * A project's settings: its name, the folder its runs execute in, and the
 * repository it is.
 *
 * All three are optional and independent, which is the point. A project can be
 * a repository with no folder (it reads over the API and changes nothing), a
 * folder with no repository (a directory that is not a git checkout), both
 * (the ordinary case), or neither yet.
 *
 * Nothing here writes to disk or to GitHub. Changing the folder does not move
 * the conversations already filed under the project, and clearing the
 * repository disconnects it from the project — it does not delete anything on
 * GitHub.
 */
export function ProjectDialog({
  open,
  project,
  workspaces,
  defaultWorkspaceId,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  /** Null creates; a project edits it. */
  project: ProjectView | null;
  workspaces: readonly WorkspaceView[];
  /** Preselected folder for a new project (the one open now). */
  defaultWorkspaceId: string | null;
  onOpenChange: (v: boolean) => void;
  onSaved: (project: ProjectView) => void;
}) {
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string>(NONE);
  const [repository, setRepository] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setWorkspaceId(project ? (project.workspaceId ?? NONE) : (defaultWorkspaceId ?? NONE));
    setRepository(project?.repositoryUrl ?? project?.repositoryFullName ?? "");
    setError(null);
  }, [open, project, defaultWorkspaceId]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const linked = workspaceId === NONE ? null : workspaceId;
      const wantedRepository = repository.trim();
      let saved: ProjectView;
      if (project) {
        saved = await api.project.rename({ projectId: project.id, name: name.trim() });
        if ((project.workspaceId ?? null) !== linked) {
          saved = await api.project.setWorkspace({ projectId: project.id, workspaceId: linked });
        }
        // Only when it actually changed: re-sending the same repository would
        // pointlessly clear the default branch that was already read.
        //
        // `setRepository` is the whole check. It refuses a repository that
        // belongs to another project, with that project's name in the message,
        // so there is nothing to verify here first - and verifying by calling
        // `connectRepository` would have *created* a project as a side effect
        // of asking a question.
        const currentRepository = project.repositoryUrl ?? project.repositoryFullName ?? "";
        if (wantedRepository !== currentRepository) {
          saved = await api.project.setRepository({
            projectId: project.id,
            url: wantedRepository.length > 0 ? wantedRepository : null,
          });
        }
      } else {
        saved = await api.project.create({
          name: name.trim(),
          workspaceId: linked,
          ...(wantedRepository ? { repositoryUrl: wantedRepository } : {}),
        });
      }
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="project-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {project ? "Configurações do projeto" : "Novo projeto"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            O projeto é o repositório ou a pasta, e as conversas ficam dentro dele. Os dois campos
            abaixo são opcionais e independentes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save();
          }}
        >
          <label className="block">
            <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">Nome</div>
            <Input
              className="mt-1 h-8 text-xs"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex.: Orquestrador"
              autoFocus
              data-testid="project-name"
            />
          </label>

          <label className="block">
            <div className="flex items-center gap-1.5 text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
              <Github className="size-3" /> Repositório
            </div>
            <Input
              className="mt-1 h-8 font-mono text-xs"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              placeholder="https://github.com/dono/nome"
              data-testid="project-repository"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Nada é clonado. Deixe em branco para desassociar — o repositório continua no GitHub.
            </p>
          </label>

          <div>
            <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">Pasta</div>
            <Select value={workspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger className="mt-1 h-8 text-xs" data-testid="project-workspace">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Nenhuma pasta</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Sem pasta, o projeto analisa e planeja, mas não altera arquivo nenhum.
            </p>
          </div>

          {project?.defaultBranch !== undefined && project?.repositoryFullName && (
            <p className="text-[10px] text-muted-foreground" data-testid="project-branch">
              Branch padrão informada pelo GitHub:{" "}
              <span className="font-mono">{project.defaultBranch ?? "não informado"}</span>
              {project.analysedCommit && (
                <>
                  {" · "}último commit analisado:{" "}
                  <span className="font-mono">{project.analysedCommit.slice(0, 7)}</span>
                </>
              )}
            </p>
          )}

          {error && (
            <p className="text-xs text-danger" data-testid="project-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || !name.trim()} data-testid="project-save">
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {project ? "Salvar" : "Criar projeto"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
