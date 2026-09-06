import { useState, type RefObject } from "react";
import { ArrowUp, Ban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runStateMeta, type Agent, type RunState } from "@/lib/orchestrator-data";
import { ProviderIcon } from "./primitives";

/**
 * The composer: one text box, one send button, and - while a run goes - a
 * status line with a real Cancel.
 *
 * The prototype also drew an execution-mode picker, attachment, microphone and
 * "Pausar" controls. None of those had anything behind them; the loop has no
 * pause and takes no attachments. A control that does nothing is worse than
 * none, so they are gone until there is something for them to do.
 */
export function Composer({
  state,
  onSubmit,
  onCancel,
  orchestrator,
  disabled = false,
  inputRef,
}: {
  state: RunState;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  /** The registered ORCHESTRATOR agent, or null when none is configured. */
  orchestrator: Agent | null;
  disabled?: boolean;
  /** Lets the page focus the box, e.g. from "Dar instrução". */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState("");

  const running = !["IDLE", "DONE", "CANCELLED", "FAILED", "PAUSED", "NEEDS_HUMAN"].includes(
    state,
  );

  if (running) {
    return (
      <div className="shrink-0 border-t border-border bg-chrome px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
          <Loader2 className="size-4 animate-spin text-running" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">Executando automaticamente…</div>
            <div className="truncate text-xs text-muted-foreground">
              {runStateMeta[state].hint} · nenhuma ação sua é necessária
            </div>
          </div>
          <div className="ml-auto flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:text-danger"
              onClick={onCancel}
              data-testid="cancel-run"
            >
              <Ban className="size-3.5" /> Cancelar
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-border bg-chrome px-6 py-4">
      <div className="mx-auto max-w-3xl rounded-xl border border-border bg-surface focus-within:border-primary/40">
        <textarea
          ref={inputRef}
          data-testid="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !disabled) {
              onSubmit(text);
              setText("");
            }
          }}
          rows={2}
          placeholder="Descreva uma tarefa ou faça uma pergunta"
          className="w-full resize-none bg-transparent px-4 pt-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-2 px-3 pb-2.5">
          <div className="ml-auto flex items-center gap-2">
            {orchestrator && (
              <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:inline-flex">
                <ProviderIcon provider={orchestrator.provider} className="size-3" />
                {[orchestrator.agent, orchestrator.model, orchestrator.reasoning]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
            <Button
              size="icon"
              className="size-7 rounded-md"
              disabled={!text.trim() || disabled}
              onClick={() => {
                onSubmit(text);
                setText("");
              }}
              aria-label="Executar tarefa"
              data-testid="composer-send"
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-[11px] text-muted-foreground">
        Ctrl+Enter executa · Ctrl+K abre a paleta de comandos · Ctrl+N nova tarefa
      </p>
    </div>
  );
}
