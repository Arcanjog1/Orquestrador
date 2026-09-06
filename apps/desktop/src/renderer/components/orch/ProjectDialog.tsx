import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
 * Creates or edits a project: its name, and the folder its new conversations
 * work in. A project is not a folder - linking one is optional, and changing
 * it never moves the conversations already filed under the project.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setWorkspaceId(project ? (project.workspaceId ?? NONE) : (defaultWorkspaceId ?? NONE));
    setError(null);
  }, [open, project, defaultWorkspaceId]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const linked = workspaceId === NONE ? null : workspaceId;
      let saved: ProjectView;
      if (project) {
        saved = await api.project.rename({ projectId: project.id, name: name.trim() });
        if ((project.workspaceId ?? null) !== linked) {
          saved = await api.project.setWorkspace({ projectId: project.id, workspaceId: linked });
        }
      } else {
        saved = await api.project.create({ name: name.trim(), workspaceId: linked });
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
          <DialogTitle className="text-sm">{project ? "Editar projeto" : "Novo projeto"}</DialogTitle>
          <DialogDescription className="text-xs">
            Um projeto organiza conversas. A pasta é opcional: as conversas novas do projeto
            trabalham nela por padrão.
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
              placeholder="ex.: Revit"
              autoFocus
              data-testid="project-name"
            />
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
          </div>
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
