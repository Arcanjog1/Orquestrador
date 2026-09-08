import { useCallback, useEffect, useState } from "react";
import { Loader2, Pin, PinOff, Plus, Trash2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import type { ProjectContextKind, ProjectContextView, ProjectView } from "@shared/ipc-contract";

/** The kinds, in the order they are offered and shown. */
const KINDS: ReadonlyArray<{ kind: ProjectContextKind; label: string; hint: string }> = [
  { kind: "objective", label: "Objetivo", hint: "O que este projeto é, em uma ou duas frases." },
  { kind: "rule", label: "Regra", hint: "Uma restrição que não se afrouxa. Vai em toda tarefa." },
  { kind: "architecture", label: "Arquitetura", hint: "Como as peças se encaixam." },
  { kind: "decision", label: "Decisão", hint: "Algo que já foi decidido, e por quê." },
  { kind: "state", label: "Estado", hint: "Onde o projeto está agora." },
  { kind: "evidence", label: "Evidência", hint: "Algo que foi verificado, com a fonte." },
];

const LABEL_OF = new Map(KINDS.map((k) => [k.kind, k.label]));

/**
 * O que o projeto sabe sobre si mesmo.
 *
 * Duas coisas que esta tela precisa deixar claras, porque as duas são fáceis de
 * errar em silêncio:
 *
 * **Nada aqui é prova.** Cada anotação é uma alegação, inclusive as que o
 * próprio aplicativo escreveu depois de uma execução. O DoneGate não lê esta
 * tabela, e um "estado" dizendo que um arquivo foi criado nunca substitui o
 * diff que mostra que foi. Por isso cada linha mostra a fonte, ou diz que não
 * tem nenhuma.
 *
 * **Nem tudo vai em todo prompt.** *Objetivo* e *regra* sempre viajam — uma
 * restrição descartada é uma restrição quebrada — e o que está fixado também.
 * O resto concorre por relevância à tarefa do momento. É seleção, não despejo.
 */
export function ProjectContextDialog({
  project,
  onOpenChange,
}: {
  /** Null closes the dialog. */
  project: ProjectView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [entries, setEntries] = useState<readonly ProjectContextView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<ProjectContextKind>("decision");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      setEntries(await api.project.listContext({ projectId: project.id }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    if (!project) {
      setEntries([]);
      setTitle("");
      setBody("");
      setError(null);
      return;
    }
    void load();
  }, [project, load]);

  const add = async () => {
    if (!project || !title.trim() || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.project.addContext({
        projectId: project.id,
        kind,
        title: title.trim(),
        body: body.trim(),
      });
      setTitle("");
      setBody("");
      await load();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (entry: ProjectContextView) => {
    try {
      await api.project.updateContext({ entryId: entry.id, pinned: !entry.pinned });
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const remove = async (entry: ProjectContextView) => {
    try {
      await api.project.removeContext({ entryId: entry.id });
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const always = (entry: ProjectContextView) =>
    entry.pinned || entry.kind === "rule" || entry.kind === "objective";

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="project-context-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Contexto de {project?.name ?? "projeto"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            O que os agentes sabem sobre este projeto. Objetivo, regras e itens fixados vão em
            toda tarefa; o resto entra por relevância. Nada aqui é evidência: é alegação, e o
            DoneGate não lê esta tela.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-64 space-y-2 overflow-y-auto" data-testid="context-entries">
          {loading && <p className="text-xs text-muted-foreground">Lendo…</p>}
          {!loading && entries.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Nada anotado ainda. O aplicativo escreve o estado da última execução sozinho; o
              resto é seu.
            </p>
          )}
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-md border border-border p-2"
              data-testid={`context-${entry.id}`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    "shrink-0 rounded px-1 text-[10px] uppercase",
                    always(entry) ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                  )}
                  title={always(entry) ? "Vai em toda tarefa" : "Entra por relevância"}
                >
                  {LABEL_OF.get(entry.kind) ?? entry.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{entry.title}</span>
                <button
                  onClick={() => void togglePin(entry)}
                  className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
                  aria-label={entry.pinned ? "Desafixar" : "Fixar"}
                  title={entry.pinned ? "Desafixar" : "Fixar: vai em toda tarefa"}
                  data-testid={`pin-${entry.id}`}
                >
                  {entry.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                </button>
                <button
                  onClick={() => void remove(entry)}
                  className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-danger"
                  aria-label="Apagar anotação"
                  data-testid={`remove-context-${entry.id}`}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                {entry.body}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {entry.sourceRef ? `fonte: ${entry.sourceRef}` : "escrito à mão, sem fonte"}
              </p>
            </div>
          ))}
        </div>

        <form
          className="space-y-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="flex gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as ProjectContextKind)}>
              <SelectTrigger className="h-8 w-36 text-xs" data-testid="context-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k.kind} value={k.kind}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="h-8 flex-1 text-xs"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Título"
              data-testid="context-title"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            {KINDS.find((k) => k.kind === kind)?.hint}
          </p>
          <textarea
            className="min-h-16 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="O conteúdo da anotação"
            data-testid="context-body"
          />
          {error && (
            <p className="text-xs text-danger" data-testid="context-error">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={busy || !title.trim() || !body.trim()}
              data-testid="context-add"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Adicionar
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
