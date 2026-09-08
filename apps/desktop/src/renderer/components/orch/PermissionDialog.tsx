import { useState } from "react";
import { AlertTriangle, Loader2, ShieldCheck, ShieldX, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { messageOf } from "@/lib/api";
import { api } from "@/lib/api";
import type { PermissionRequestView } from "@shared/ipc-contract";

/** What the interface writes where the CLI reported nothing. */
const UNKNOWN = "não informado";

/**
 * "O Claude Code quer fazer isto. Você autoriza?"
 *
 * The dialog the failed run needed and did not have. It said the person should
 * authorise the operation and gave them nothing to authorise; this shows the
 * operation and two buttons.
 *
 * Three rules it exists to enforce.
 *
 * **Nothing is invented.** Every field is what the CLI reported, and a field
 * it did not report says *não informado*. A request whose command the CLI
 * never named cannot be approved as a command, and the dialog says so instead
 * of offering a wider rule that would look equivalent.
 *
 * **An approval is for one scope.** The options come from the main process,
 * which recomputes them; a renderer cannot approve something the dialog did
 * not display. A shell is never offered as a bare tool — that would authorise
 * every command in the project for ever, which is exactly what the person said
 * they did not want.
 *
 * **A refusal is an answer.** It is recorded, respected, and the run stays
 * where it is. Nothing retries behind it.
 */
export function PermissionDialog({
  request,
  onOpenChange,
  onDecided,
}: {
  /** Null closes the dialog. */
  request: PermissionRequestView | null;
  onOpenChange: (open: boolean) => void;
  onDecided: (request: PermissionRequestView) => void;
}) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const scopes = request?.scopes ?? [];
  const rule = chosen ?? scopes[0]?.rule ?? null;

  const decide = async (action: "approve" | "deny") => {
    if (!request) return;
    setBusy(action);
    setError(null);
    try {
      const decided =
        action === "approve" && rule
          ? await api.permission.approve({ requestId: request.id, rule })
          : await api.permission.deny({ requestId: request.id });
      onDecided(decided);
      onOpenChange(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="permission-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Terminal className="size-4 text-attention" />
            Autorizar uma operação
          </DialogTitle>
          <DialogDescription className="text-xs">
            O worker pediu uma ferramenta que não está pré-aprovada. Nada foi executado. Você
            autoriza apenas o escopo escolhido abaixo, e apenas neste projeto.
          </DialogDescription>
        </DialogHeader>

        {request && (
          <div className="space-y-3">
            <dl className="space-y-1.5 rounded-md border border-border p-3 text-xs">
              <Row label="Agente" value={request.agentName ?? request.agentId} />
              <Row label="Conta" value={request.accountName ?? request.accountId} />
              <Row label="Ferramenta" value={request.toolName} mono />
              <Row label="Comando" value={request.command} mono wrap />
              <Row label="Argumentos" value={request.arguments} mono wrap />
              <Row label="Pasta de trabalho" value={request.workingDirectory} mono wrap />
              <Row label="Projeto" value={request.workspaceName} />
              {/* The worker's own words for what it wanted, when it sent them,
                  are folded into `reason` by the main process. The command
                  says what; this says why. */}
              <Row label="Motivo" value={request.reason} wrap />
            </dl>

            {scopes.length > 0 ? (
              <div className="space-y-1.5" data-testid="permission-scopes">
                <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
                  O que você está autorizando
                </div>
                {scopes.map((scope) => (
                  <button
                    key={scope.rule}
                    onClick={() => setChosen(scope.rule)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                      rule === scope.rule
                        ? "border-primary/50 bg-accent"
                        : "border-border hover:border-primary/30",
                    )}
                    data-testid={`scope-${scope.rule}`}
                  >
                    <span className="text-xs font-medium">{scope.label}</span>
                    <span className="font-mono text-[10px] text-primary">{scope.rule}</span>
                    <span className="text-[10px] text-muted-foreground">{scope.detail}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p
                className="flex gap-2 rounded-md border border-attention/40 bg-attention/5 px-3 py-2 text-[11px] text-attention"
                data-testid="permission-no-scope"
              >
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                <span>
                  O Claude Code não informou qual comando queria executar, então não há nada
                  específico para autorizar. Autorizar <code>{request.toolName}</code> por inteiro
                  liberaria qualquer comando neste projeto, e isso não é oferecido aqui. Peça a
                  tarefa novamente pedindo o comando exato, ou recuse.
                </span>
              </p>
            )}

            <p className="text-[10px] text-muted-foreground">
              Uma autorização vale só para este projeto e só para a regra acima. Ela não roda nada
              agora: a tarefa precisa ser delegada de novo, e o aplicativo continua a mesma sessão
              do Claude Code para não perder o contexto.
            </p>

            {error && (
              <p className="text-xs text-danger" data-testid="permission-error">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void decide("deny")}
                data-testid="permission-deny"
              >
                {busy === "deny" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ShieldX className="size-3.5" />
                )}
                Recusar
              </Button>
              <Button
                disabled={busy !== null || rule === null}
                onClick={() => void decide("approve")}
                data-testid="permission-approve"
              >
                {busy === "approve" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="size-3.5" />
                )}
                Autorizar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  mono,
  wrap,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  wrap?: boolean;
}) {
  const missing = value === null || value === undefined || value.trim().length === 0;
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 flex-1",
          mono && !missing && "font-mono",
          wrap ? "break-all whitespace-pre-wrap" : "truncate",
          missing && "text-muted-foreground italic",
        )}
      >
        {missing ? UNKNOWN : value}
      </dd>
    </div>
  );
}
