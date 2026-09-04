import { useEffect, useState } from "react";
import { Check, FileCode2, Loader2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
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
  ArtifactView,
  GitContextView,
  LoginProgressView,
  RunDetailView,
  VerificationResultView,
} from "@shared/ipc-contract";
import { subscribe } from "@/lib/bridge";
import {
  AgentIdentity,
  CheckRow,
  ProviderIcon,
  SectionLabel,
  StatBlock,
} from "./primitives";

/**
 * The dialogs, exactly as approved.
 *
 * Sizes, headers, column widths, the 420px diff body and the diff line
 * colouring are all the design's. The prototype fed them from `diffFiles`,
 * `evidence` and `team` sample objects; each one now reads the run's real
 * artifacts, git figures and verification results, and says plainly when the
 * application has nothing to show.
 */

function EmptyBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid place-items-center px-6 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function DiffDialog({
  open,
  onOpenChange,
  artifacts,
  git,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Diff artifacts the run recorded. The bytes live on disk. */
  artifacts: ArtifactView[];
  git: GitContextView | null;
}) {
  const diffs = artifacts.filter((a) => a.kind === "diff" || a.kind === "patch");
  const [active, setActive] = useState<string | null>(diffs[0]?.id ?? null);
  const file = diffs.find((f) => f.id === active) ?? diffs[0] ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm">Alterações do run</DialogTitle>
          <DialogDescription className="text-xs">
            {git?.isRepository ? (
              <>
                {git.changedFiles} arquivo(s) · <span className="text-success">+{git.additions}</span>{" "}
                <span className="text-danger">-{git.deletions}</span>
              </>
            ) : (
              "Nenhuma alteração registrada."
            )}
          </DialogDescription>
        </DialogHeader>
        {diffs.length === 0 ? (
          <EmptyBody>
            Nenhum diff foi arquivado para esta execução ainda.
            <br />
            Os diffs aparecem aqui quando um agente altera arquivos.
          </EmptyBody>
        ) : (
          <div className="flex h-[420px]">
            <div className="w-64 shrink-0 space-y-0.5 overflow-y-auto border-r border-border p-2">
              {diffs.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setActive(f.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    f.id === (file?.id ?? "") ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs">
                    {f.label ?? f.relativePath.split("/").pop()}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-auto">
              <div className="border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
                {file?.relativePath}
              </div>
              <EmptyBody>
                O conteúdo do diff está arquivado em disco e ainda não é lido pela interface.
              </EmptyBody>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function EvidenceDialog({
  open,
  onOpenChange,
  git,
  verifications,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  git: GitContextView | null;
  verifications: VerificationResultView[];
}) {
  const passed = verifications.filter((v) => v.passed).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Evidence</DialogTitle>
          <DialogDescription className="text-xs">
            Provas coletadas pelo sistema, não afirmações dos agentes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div>
            <SectionLabel>Git</SectionLabel>
            {git?.isRepository ? (
              <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <StatBlock
                  label="Branch"
                  value={<span className="font-mono text-xs">{git.branch ?? "—"}</span>}
                />
                <StatBlock
                  label="HEAD"
                  value={<span className="font-mono text-xs">{git.head ?? "—"}</span>}
                />
                <StatBlock label="Status" value={git.dirty ? "Alterações pendentes" : "Working tree limpo"} />
                <StatBlock
                  label="Files changed"
                  value={
                    <span className="font-mono text-xs">
                      {git.changedFiles} · <span className="text-success">+{git.additions}</span>{" "}
                      <span className="text-danger">-{git.deletions}</span>
                    </span>
                  }
                />
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {git?.problem ?? "Este projeto não é um repositório Git."}
              </p>
            )}
          </div>
          <div className="border-t border-border pt-4">
            <SectionLabel>Verifications</SectionLabel>
            {verifications.length > 0 ? (
              <>
                <div className="mt-2 grid grid-cols-3 gap-4">
                  <StatBlock label="Total" value={verifications.length} />
                  <StatBlock label="Passed" value={<span className="text-success">{passed}</span>} />
                  <StatBlock
                    label="Failed"
                    value={<span className="text-danger">{verifications.length - passed}</span>}
                  />
                </div>
                <div className="mt-4 grid gap-1.5 sm:grid-cols-2">
                  {verifications.map((v) => (
                    <CheckRow key={v.id} label={v.label} passed={v.passed} />
                  ))}
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                Nenhuma verificação foi executada nesta execução.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AgentDetailDialog({
  entry,
  onOpenChange,
  detail,
}: {
  entry: Extract<TimelineEntry, { kind: "agent" }> | null;
  onOpenChange: (v: boolean) => void;
  detail: RunDetailView | null;
}) {
  const invocation = detail?.invocations.find((i) => i.id === entry?.id) ?? null;

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
              <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
                <StatBlock label="Conta" value={entry.agent.account ?? "—"} />
                <StatBlock
                  label="Início"
                  value={invocation ? new Date(invocation.startedAt).toLocaleTimeString() : "—"}
                />
                <StatBlock label="Duração" value={entry.duration} />
                <StatBlock
                  label="Status"
                  value={
                    <span
                      className={cn(
                        invocation?.outcome === "completed" && "text-success",
                        invocation?.outcome === "failed" && "text-danger",
                      )}
                    >
                      {invocation?.outcome ?? "—"}
                    </span>
                  }
                />
              </div>
              <div className="border-t border-border pt-4">
                <SectionLabel>Instructions</SectionLabel>
                <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground/85">
                  {invocation?.task ?? "A instrução desta invocação não foi arquivada."}
                </pre>
              </div>
              <div>
                <SectionLabel>Result</SectionLabel>
                <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {entry.lines.length > 0 ? (
                    entry.lines.map((l) => <p key={l}>{l}</p>)
                  ) : (
                    <p>Nenhum resultado textual foi arquivado.</p>
                  )}
                </div>
              </div>
              <div className="border-t border-border pt-4">
                <SectionLabel>Files</SectionLabel>
                <div className="mt-2 space-y-1 font-mono text-xs text-foreground/85">
                  {(detail?.artifacts ?? []).map((a) => (
                    <div key={a.id} className="flex gap-3">
                      <span className="truncate">{a.relativePath}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{a.kind}</span>
                    </div>
                  ))}
                  {(detail?.artifacts ?? []).length === 0 && (
                    <p className="font-sans text-muted-foreground">
                      Nenhum arquivo foi registrado para esta execução.
                    </p>
                  )}
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

export function DestructiveActionDialog({
  open,
  onOpenChange,
  command,
  consequence,
  onAllow,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  command: string;
  consequence: string;
  onAllow: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm text-attention">
            Ação de alto impacto
          </DialogTitle>
          <DialogDescription>
            O Orquestrador deseja executar um comando destrutivo.
          </DialogDescription>
        </DialogHeader>
        <pre className="rounded-lg border border-attention/30 bg-attention/[0.07] p-3 font-mono text-xs text-attention">
          {command}
        </pre>
        <p className="text-sm text-muted-foreground">{consequence}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Não permitir
          </Button>
          <Button onClick={onAllow}>Permitir uma vez</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TeamDialog({
  open,
  onOpenChange,
  team,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  team: Agent[];
  onSave: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">Equipe deste projeto</DialogTitle>
          <DialogDescription className="text-xs">
            Cada função tem provider, conta, modelo e nível de raciocínio próprios.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {team.map((agent) => (
            <div
              key={agent.role}
              className="rounded-lg border border-border bg-surface-raised p-3"
            >
              <div className="flex items-center gap-2">
                <ProviderIcon provider={agent.provider} />
                <SectionLabel>{agent.role}</SectionLabel>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field
                  label="Provider"
                  value={agent.provider === "openai" ? "OpenAI" : agent.provider === "anthropic" ? "Anthropic" : agent.provider}
                />
                <Field label="Account" value={agent.account ?? "—"} />
                <Field label="Model" value={agent.model ?? "—"} />
                <Field label="Reasoning" value={agent.reasoning ?? "—"} />
              </div>
            </div>
          ))}
          {team.length === 0 && (
            <div className="rounded-lg border border-border bg-surface-raised p-3 text-sm text-muted-foreground">
              Nenhum agente foi configurado para este projeto ainda.
            </div>
          )}
          <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
            Preparado para Reviewer dedicado, Test Agent, Research Agent e Gemini (Image
            Generator).
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={onSave}>Salvar equipe</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </div>
      <Select defaultValue={value}>
        <SelectTrigger className="mt-1 h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={value}>{value}</SelectItem>
        </SelectContent>
      </Select>
    </div>
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
    "Trocar branch",
    "Configurar agentes",
    "Contas e integrações",
    "GitHub",
    "Configurações",
    "Gerar handoff da sessão",
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
 * The prototype offered "Simular sucesso" and "Simular erro" buttons and a
 * fixed ABCD-EFGH code. Both are gone: this follows the real
 * `accounts:loginProgress` events from `ClaudeAccountManager.connect`, and the
 * only way it reaches "connected" is the CLI actually reporting it.
 */
export function LoginDialog({
  open,
  onOpenChange,
  provider,
  accountId,
  onRetry,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  provider: string;
  accountId: string | null;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const [progress, setProgress] = useState<LoginProgressView | null>(null);

  useEffect(() => {
    if (!open) {
      setProgress(null);
      return;
    }
    return subscribe("accounts:loginProgress", (payload) => {
      if (!accountId || payload.accountId === accountId) setProgress(payload);
    });
  }, [open, accountId]);

  const phase = progress?.phase ?? "starting";
  const done = phase === "connected";
  const failed = phase === "failed" || phase === "cancelled";

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
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="size-2 animate-pulse rounded-full bg-running" />
              {progress?.message ?? "Aguardando autorização…"}
            </div>
            <div className="flex justify-center">
              <Loader2 className="size-5 animate-spin text-running" />
            </div>
          </div>
        )}

        {done && (
          <div className="flex items-center gap-2 text-sm text-success">
            <Check className="size-4" /> {provider} conectado com sucesso.
          </div>
        )}

        {failed && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/[0.07] p-3 text-sm text-danger">
              <X className="mt-0.5 size-4 shrink-0" />
              {progress?.message ?? "O login não foi concluído."}
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={onRetry}>
                Tentar novamente
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
