import { useState } from "react";
import {
  ArrowUp,
  Ban,
  Loader2,
  Mic,
  Paperclip,
  Pause,
  Play,
  Plus,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { runStateMeta, type Agent, type RunState } from "@/lib/orchestrator-data";
import { ProviderIcon } from "./primitives";

const modes = ["Automático", "Planejar", "Perguntar", "Executar"] as const;

export function Composer({
  state,
  onSubmit,
  onPause,
  onResume,
  onCancel,
  orchestrator,
  disabled = false,
}: {
  state: RunState;
  onSubmit: (text: string) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  /** The registered ORCHESTRATOR agent, or null when none is configured. */
  orchestrator: Agent | null;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<(typeof modes)[number]>("Automático");

  const running = !["IDLE", "DONE", "CANCELLED", "FAILED", "PAUSED", "NEEDS_HUMAN"].includes(
    state,
  );

  if (running || state === "PAUSED") {
    return (
      <div className="shrink-0 border-t border-border bg-chrome px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
          {state === "PAUSED" ? (
            <Pause className="size-4 text-attention" />
          ) : (
            <Loader2 className="size-4 animate-spin text-running" />
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {state === "PAUSED"
                ? "Execução pausada"
                : "Executando automaticamente…"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {runStateMeta[state].hint} · nenhuma ação sua é necessária
            </div>
          </div>
          <div className="ml-auto flex shrink-0 gap-2">
            {state === "PAUSED" ? (
              <Button size="sm" onClick={onResume}>
                <Play className="size-3.5" /> Continuar
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={onPause}>
                <Pause className="size-3.5" /> Pausar
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:text-danger"
              onClick={onCancel}
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
                  mode === "Automático"
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border bg-surface-raised text-foreground/85",
                )}
              >
                <Zap className="size-3.5" />
                {mode}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuLabel>Modo de execução</DropdownMenuLabel>
              {modes.map((m) => (
                <DropdownMenuItem key={m} onClick={() => setMode(m)}>
                  {m}
                  {m === "Automático" && (
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      principal
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <button className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <Plus className="size-4" />
          </button>
          <button className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <Paperclip className="size-4" />
          </button>
          <button className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <Mic className="size-4" />
          </button>

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
