import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FolderOpen, GitBranch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, messageOf } from "@/lib/api";
import type { PreflightResultView, ProjectView } from "@shared/ipc-contract";

/**
 * Preparar o projeto antes de codar.
 *
 * O problema que esta tela resolve: conectar um repositório do GitHub cria a
 * **identidade** do projeto, não um checkout. Dava para conversar sobre o
 * repositório e não dava para simplesmente selecionar o projeto e começar a
 * alterar código — e foi assim que uma tarefa destinada a um repositório
 * acabou executando numa pasta da Área de Trabalho que só tinha um nome
 * parecido.
 *
 * O que ela mostra é medido, não presumido: o aplicativo pergunta ao Git o que
 * a pasta é e compara com o repositório que o projeto declara. Um nome parecido
 * não é prova de identidade, e nada aqui trata como se fosse.
 *
 * Nenhuma das duas ações é destrutiva. **Associar** apenas lê a pasta.
 * **Clonar** recusa um destino que já existe, em vez de mesclar ou limpar. Não
 * há checkout, pull nem reset, então alteração local nenhuma se perde — e o
 * projeto continua sendo o mesmo, com as mesmas conversas e o mesmo histórico.
 */
export function PrepareProjectDialog({
  project,
  onOpenChange,
  onPrepared,
}: {
  /** Null fecha o diálogo. */
  project: ProjectView | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (workspaceId: string) => void;
}) {
  const [state, setState] = useState<PreflightResultView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"associate" | "clone" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      setState(await api.project.preflight({ projectId: project.id }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load]);

  async function associate() {
    if (!project) return;
    setBusy("associate");
    setError(null);
    try {
      const chosen = await api.workspace.selectFolder();
      if (!chosen.path) return;
      const done = await api.project.prepare({
        projectId: project.id,
        mode: "associate",
        localPath: chosen.path,
      });
      setState(done.preflight);
      onPrepared(done.workspaceId);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function clone() {
    if (!project) return;
    setBusy("clone");
    setError(null);
    try {
      const chosen = await api.workspace.selectFolder();
      if (!chosen.path) return;
      const done = await api.project.prepare({
        projectId: project.id,
        mode: "clone",
        parentPath: chosen.path,
      });
      setState(done.preflight);
      onPrepared(done.workspaceId);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const ok = state !== null && !state.blocksCodeWork;

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="prepare-project-dialog">
        <DialogHeader>
          <DialogTitle>Preparar para codar</DialogTitle>
          <DialogDescription>
            {project?.name ?? ""} — o que o aplicativo mediu nesta pasta agora.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Verificando…
          </p>
        )}

        {state && (
          <div
            className="rounded-md border border-border/70 bg-muted/30 p-3 text-sm"
            data-testid="preflight-state"
            data-kind={state.kind}
            data-blocking={state.blocksCodeWork ? "true" : "false"}
          >
            <p className="flex items-center gap-2 font-medium">
              {ok ? (
                <CheckCircle2 className="size-4 text-success" />
              ) : (
                <AlertTriangle className="size-4 text-warning" />
              )}
              {state.title}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{state.detail}</p>
            {state.dirty && (
              <p className="mt-1 text-xs text-warning">
                A árvore tem alterações locais. Nada aqui sobrescreve isso.
              </p>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-danger" data-testid="prepare-error">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void associate()}
            disabled={busy !== null}
            data-testid="prepare-associate"
          >
            {busy === "associate" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FolderOpen className="size-4" />
            )}
            Associar pasta existente
          </Button>
          {state?.declaredRepositoryUrl && (
            <Button
              variant="outline"
              onClick={() => void clone()}
              disabled={busy !== null}
              data-testid="prepare-clone"
            >
              {busy === "clone" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <GitBranch className="size-4" />
              )}
              Clonar repositório
            </Button>
          )}
          <Button variant="ghost" onClick={() => void load()} disabled={busy !== null}>
            Verificar de novo
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          O Git usado é o que o aplicativo gerencia. Não é preciso abrir PowerShell, instalar Git
          nem configurar PATH. Clonar recusa um destino que já existe; associar só lê a pasta.
        </p>
      </DialogContent>
    </Dialog>
  );
}
