import { Fragment, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api, messageOf } from "@/lib/api";
import { SectionLabel, StatBlock } from "./primitives";
import { reasoningLabel, selectionModeLabel } from "@/lib/orchestrator-data";
import type {
  PermissionRequestView,
  RunDetailView,
  RunStepView,
  WorkspaceChangesView,
  WorkspaceView,
} from "@shared/ipc-contract";

/**
 * The three windows onto what really happened.
 *
 *   DiffDialog      - the working copy now, read with git (`workspace.changes`).
 *   EvidenceDialog  - the same git facts beside the run's verification results.
 *   RunDetailDialog - every step the loop recorded, with the diagnostics a
 *                     failing one left (CLI outcome, exit code, excerpts).
 *
 * None of them holds sample data: each says "nothing" when there is nothing.
 */

function useChanges(workspaceId: string | null, open: boolean) {
  const [changes, setChanges] = useState<WorkspaceChangesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || !workspaceId) return;
    let alive = true;
    setLoading(true);
    api.workspace
      .changes({ workspaceId })
      .then((c) => {
        if (alive) {
          setChanges(c);
          setError(null);
        }
      })
      .catch((e: unknown) => alive && setError(messageOf(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [workspaceId, open]);
  return { changes, error, loading };
}

function useRunDetail(runId: string | null) {
  const [detail, setDetail] = useState<RunDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!runId) {
      setDetail(null);
      return;
    }
    let alive = true;
    api.run
      .detail({ runId })
      .then((d) => alive && setDetail(d))
      .catch((e: unknown) => alive && setError(messageOf(e)));
    return () => {
      alive = false;
    };
  }, [runId]);
  return { detail, error };
}

export function DiffDialog({
  open,
  onOpenChange,
  workspace,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: WorkspaceView | null;
}) {
  const { changes, error, loading } = useChanges(workspace?.id ?? null, open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm">Alterações no projeto</DialogTitle>
          <DialogDescription className="text-xs">
            {workspace
              ? `${workspace.localPath} · em relação ao último commit${changes?.head ? ` (${changes.head.slice(0, 7)})` : ""}`
              : "Nenhum projeto aberto."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto" data-testid="diff-body">
          {loading && !changes && (
            <p className="px-4 py-6 text-sm text-muted-foreground">Lendo o git…</p>
          )}
          {error && <p className="px-4 py-6 text-sm text-danger">{error}</p>}
          {changes && !changes.isRepository && (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              Esta pasta não é um repositório git, ou o Git ainda não está configurado.
            </p>
          )}
          {changes?.isRepository && changes.files.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              Nenhuma alteração pendente. O projeto está igual ao último commit.
            </p>
          )}
          {changes?.isRepository && changes.files.length > 0 && (
            <>
              <div className="border-b border-border px-4 py-3">
                <SectionLabel>{changes.files.length} arquivo(s)</SectionLabel>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                  {changes.files.map((f) => (
                    <li key={f.path} className="flex items-center gap-2 text-xs">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] uppercase",
                          f.status === "novo" || f.status === "adicionado"
                            ? "bg-success/15 text-success"
                            : f.status === "removido"
                              ? "bg-danger/15 text-danger"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {f.status}
                      </span>
                      <span className="truncate font-mono">{f.path}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <pre className="overflow-x-auto px-4 py-3 font-mono text-[11px] leading-5">
                {changes.diff.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={cn(
                      line.startsWith("+") && !line.startsWith("+++") && "bg-success/10 text-success",
                      line.startsWith("-") && !line.startsWith("---") && "bg-danger/10 text-danger",
                      line.startsWith("@@") && "text-primary",
                      line.startsWith("diff ") && "mt-2 font-semibold text-foreground",
                    )}
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
              {changes.truncated && (
                <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                  O diff foi truncado para leitura; o restante está no git do projeto.
                </p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function EvidenceDialog({
  open,
  onOpenChange,
  workspace,
  runId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: WorkspaceView | null;
  runId: string | null;
}) {
  const { changes } = useChanges(workspace?.id ?? null, open);
  const { detail } = useRunDetail(open ? runId : null);
  const verifications = detail?.verifications ?? [];
  const sessions = detail?.providerSessions ?? [];
  const evidenceSteps = (detail?.steps ?? []).filter((s) => s.phase === "evidence");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Evidence</DialogTitle>
          <DialogDescription className="text-xs">
            Provas coletadas pelo sistema, não afirmações dos agentes.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-5 overflow-y-auto" data-testid="evidence-body">
          <div>
            <SectionLabel>Git · agora</SectionLabel>
            <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <StatBlock
                label="Branch"
                value={<span className="font-mono text-xs">{changes?.branch ?? workspace?.branch ?? "—"}</span>}
              />
              <StatBlock
                label="HEAD"
                value={<span className="font-mono text-xs">{changes?.head?.slice(0, 12) ?? "—"}</span>}
              />
              <StatBlock
                label="Arquivos alterados"
                value={changes ? (changes.isRepository ? String(changes.files.length) : "sem git") : "—"}
              />
            </div>
            {changes?.diffStat && (
              <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-surface-raised p-2 font-mono text-[11px] leading-5 text-muted-foreground">
                {changes.diffStat.trim()}
              </pre>
            )}
          </div>

          {detail && (
            <div className="border-t border-border pt-4">
              <SectionLabel>Baseline da execução</SectionLabel>
              <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <StatBlock
                  label="Branch"
                  value={<span className="font-mono text-xs">{detail.baseline.branch ?? "—"}</span>}
                />
                <StatBlock
                  label="Commit"
                  value={<span className="font-mono text-xs">{detail.baseline.commit?.slice(0, 12) ?? "—"}</span>}
                />
                <StatBlock label="Árvore suja" value={detail.baseline.dirty ? "sim" : "não"} />
              </div>
              {evidenceSteps.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {evidenceSteps.map((s) => (
                    <li key={s.id}>
                      Iteração {s.iteration}: {s.summary}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="border-t border-border pt-4">
            <SectionLabel>Verifications</SectionLabel>
            {!runId && (
              <p className="mt-2 text-sm text-muted-foreground">
                Nenhuma execução selecionada nesta conversa.
              </p>
            )}
            {runId && detail && verifications.length === 0 && (
              <p className="mt-2 text-sm text-muted-foreground">
                Nenhuma verificação foi executada nesta execução.
              </p>
            )}
            {verifications.length > 0 && (
              <ul className="mt-2 space-y-1">
                {verifications.map((v, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 font-semibold",
                        v.passed ? "bg-success/15 text-success" : "bg-danger/15 text-danger",
                      )}
                    >
                      {v.passed ? "PASS" : v.refused ? "REFUSED" : `FAIL${v.exitCode !== null ? ` (${v.exitCode})` : ""}`}
                    </span>
                    <span className="text-muted-foreground">it. {v.iteration}</span>
                    <span className="truncate font-mono">{v.command}</span>
                    {v.durationMs !== null && (
                      <span className="ml-auto shrink-0 font-mono text-muted-foreground">
                        {(v.durationMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* The provider's own sessions.
              Worth its own block because of a confusing gap: a session created
              by `claude -p` is deliberately kept out of Claude Code's own
              session picker and out of `claude --continue`, so a person sees
              the usage on their account, finds nothing in the picker, and
              concludes the application is not really using Claude Code. It is.
              The id is the only handle there is, so showing it is the fix. */}
          {sessions.length > 0 && (
            <div className="border-t border-border pt-4">
              <SectionLabel>Sessões do Claude Code</SectionLabel>
              <p className="mt-2 text-xs text-muted-foreground">
                Uma sessão iniciada em modo não interativo não aparece no seletor do
                Claude Code nem no Claude Desktop — cada um mantém seu próprio
                histórico. Ela existe e é retomável pelo id:
              </p>
              <ul className="mt-2 space-y-2">
                {sessions.map((session) => (
                  <li key={`${session.connectionId}-${session.providerSessionId}`}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-semibold">{session.connectionName ?? "Conexão"}</span>
                      <span className="text-muted-foreground">{session.adapterId}</span>
                    </div>
                    <div
                      className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                      title={session.workingDirectory}
                    >
                      {session.workingDirectory}
                    </div>
                    <button
                      type="button"
                      data-testid="copy-resume-command"
                      onClick={() => void navigator.clipboard?.writeText(session.resumeCommand)}
                      title="Copiar"
                      className="mt-1 w-full truncate rounded-md border border-border bg-surface-raised px-2 py-1 text-left font-mono text-[11px] transition-colors hover:bg-accent"
                    >
                      {session.resumeCommand}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const PHASE_LABEL: Record<string, string> = {
  readiness: "Prontidão",
  baseline: "Baseline",
  orchestrator: "Orquestrador",
  worker: "Trabalhador",
  evidence: "Evidência",
  verification: "Verificação",
  "done-gate": "Done Gate",
  limit: "Limite de iterações",
  interrupted: "Interrompida",
  error: "Erro",
  cancelled: "Cancelada",
  blocked: "Revisão humana",
  workspace: "Pasta do projeto",
  delegation: "Delegação",
  budget: "Limite de gasto",
};

/**
 * The diagnostic keys worth showing, in the words a person reads.
 *
 * The raw keys are English and terse because they are written for the record;
 * a person opening "Detalhes" after a run stopped needs them in Portuguese and
 * in an order that answers "what was refused, and where".
 */
const DETAIL_LABEL: Record<string, string> = {
  failure: "Falha",
  deniedTools: "Ferramentas recusadas",
  workingDirectory: "Pasta de trabalho",
  executable: "Executável",
  exitCode: "Código de saída",
  outcome: "Resultado",
  attempt: "Tentativa",
  workerId: "Worker",
  continuedSession: "Continuou a sessão",
  stderrExcerpt: "Saída de erro",
  stdoutExcerpt: "Saída",
  parseError: "Problema de formato",
  durationMs: "Duração (ms)",
  mechanical: "Falha mecânica",
  modelUnavailable: "Modelo indisponível",
  error: "Erro",
};

function parseDetail(step: RunStepView): Record<string, unknown> | null {
  if (!step.detail) return null;
  try {
    const parsed: unknown = JSON.parse(step.detail);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return { raw: step.detail };
  }
}

/** The vendor's name, as a person recognises it. */
function providerLabel(providerId: string): string {
  return providerId === "openai" ? "OpenAI" : providerId === "anthropic" ? "Anthropic" : providerId;
}

/** A classified provider failure, in words rather than a code. */
function failureLabel(kind: string): string {
  const labels: Record<string, string> = {
    // The five this product learned to tell apart. Naming them in Portuguese
    // matters more here than anywhere else: "tool-permission-denied" on screen
    // is the difference between a person knowing to authorise something and a
    // person concluding the application is broken.
    "tool-permission-denied": "uma ferramenta necessária foi recusada",
    "approval-required": "faltou uma aprovação que ninguém pôde dar",
    "empty-response": "o worker executou e não devolveu nada",
    "workspace-invalid": "a pasta do projeto não pôde ser usada",
    "evidence-unavailable": "não foi possível observar a pasta",
    "insufficient-credit": "conta sem saldo ou fora da cota",
    authentication: "credencial não aceita",
    permission: "sem permissão para o que foi pedido",
    "rate-limit": "limite de requisições do provider",
    timeout: "o provider não respondeu a tempo",
    // Deliberately not the same sentence as `timeout`. "Demorou demais" and
    // "parou de dar sinal" call for opposite reactions, and telling them apart
    // is the whole reason this kind exists.
    "no-activity": "o worker ficou sem dar sinal e foi interrompido",
    network: "não foi possível falar com o provider",
    "invalid-request": "o provider recusou o formato da chamada",
    "model-unavailable": "modelo indisponível para esta conta",
    schema: "resposta em formato inesperado",
    "provider-error": "erro do provider",
    cancelled: "cancelada",
    "budget-exceeded": "limite desta execução atingido",
  };
  return labels[kind] ?? kind;
}

/**
 * What one invocation consumed.
 *
 * The rule this function exists for: a figure the provider did not report is
 * "não informado", never zero. An invocation that spent an unknown amount must
 * not read like one that spent nothing.
 */
function usageLine(inv: {
  billing: string | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}): string {
  const parts: string[] = [];
  if (inv.billing === "subscription") parts.push("assinatura");
  else if (inv.billing === "api-metered") parts.push("cobrança por uso");

  const tokens = inv.totalTokens ?? ((inv.inputTokens ?? 0) + (inv.outputTokens ?? 0) || null);
  parts.push(tokens === null ? "tokens não informados" : `${tokens.toLocaleString("pt-BR")} tokens`);

  if (inv.billing === "api-metered") {
    parts.push(
      inv.costUsd === null
        ? "custo não informado"
        : `US$ ${inv.costUsd.toFixed(inv.costUsd < 1 ? 4 : 2)} (estimado)`,
    );
  } else if (inv.costUsd !== null) {
    parts.push(`US$ ${inv.costUsd.toFixed(4)} (informado pelo CLI)`);
  }
  return parts.join(" · ");
}

export function RunDetailDialog({
  runId,
  onOpenChange,
}: {
  runId: string | null;
  onOpenChange: (v: boolean) => void;
}) {
  const { detail, error } = useRunDetail(runId);
  // Where the last export went, so the person can open the folder rather than
  // be told a path they would have to type somewhere.
  const [exported, setExported] = useState<{ path: string; directory: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  useEffect(() => setExported(null), [runId]);

  // What this run asked a person to authorise, and how it ended. Read here
  // rather than pushed, so reopening the dialog shows the current answer.
  const [permissions, setPermissions] = useState<readonly PermissionRequestView[]>([]);
  useEffect(() => {
    if (!runId) {
      setPermissions([]);
      return;
    }
    let alive = true;
    api.permission
      .forRun({ runId })
      .then((list) => alive && setPermissions(list))
      .catch(() => alive && setPermissions([]));
    return () => {
      alive = false;
    };
  }, [runId]);
  // A step is worth showing when it carries diagnostics and did not simply
  // succeed. `changed` is the evidence step's success, and `degraded` is a
  // baseline that could not use git - which is exactly the case a person
  // needs to see, so it is included rather than filtered out as noise.
  const failing =
    detail?.steps.filter(
      (s) => s.detail && s.status !== "ok" && s.status !== "changed" && s.status !== "passed",
    ) ?? [];
  return (
    <Dialog open={runId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Detalhes da execução</DialogTitle>
          <DialogDescription className="text-xs">
            {detail
              ? `${detail.run.status} · ${detail.run.iterations} iteração(ões) · ${detail.invocations.length} invocação(ões)`
              : "Lendo o registro da execução…"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto" data-testid="run-detail-body">
          {error && <p className="text-sm text-danger">{error}</p>}
          {!detail && !error && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {/* The export.
              Offered whenever there is a record at all, not only on failure:
              a run that "worked" but produced nothing is exactly the case
              somebody needs to send to another person. The application writes
              the file into a folder it owns - no PowerShell, no picker. */}
          {detail && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="export-diagnostics"
                disabled={exporting}
                onClick={() => {
                  if (!runId) return;
                  setExporting(true);
                  void api.run
                    .exportDiagnostics({ runId })
                    .then(setExported)
                    .catch((e: unknown) => setExported({ path: messageOf(e), directory: "" }))
                    .finally(() => setExporting(false));
                }}
                className="rounded-md border border-border bg-surface-raised px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-60"
              >
                {exporting ? "Gerando…" : "Exportar diagnóstico"}
              </button>
              {exported?.directory && (
                <button
                  type="button"
                  data-testid="open-diagnostics-folder"
                  onClick={() => void api.app.openExternal({ url: `file://${exported.directory}` })}
                  className="rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent"
                >
                  Abrir pasta
                </button>
              )}
              {exported && (
                <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={exported.path}>
                  {exported.path}
                </span>
              )}
            </div>
          )}

          {detail?.run.summary && (
            <div className="rounded-lg border border-border bg-surface-raised p-3">
              <SectionLabel>Resultado</SectionLabel>
              <p className="mt-1 text-sm text-foreground/90" data-testid="run-detail-summary">
                {detail.run.summary}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Objetivo: {detail.run.objective}</p>
            </div>
          )}

          {permissions.length > 0 && (
            <div data-testid="run-permissions">
              <SectionLabel>Autorizações</SectionLabel>
              <div className="mt-2 space-y-1.5">
                {permissions.map((request) => (
                  <div
                    key={request.id}
                    className="rounded-lg border border-border p-2.5 text-xs"
                    data-testid={`run-permission-${request.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "shrink-0 rounded px-1 text-[10px] uppercase",
                          PERMISSION_TONE[request.status],
                        )}
                      >
                        {PERMISSION_LABEL[request.status]}
                      </span>
                      <span className="font-mono">{request.toolName}</span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">
                      {request.command ?? "comando não informado"}
                    </p>
                    {request.status === "approved" && request.approvedRule && (
                      <p className="mt-1 text-[10px] text-success">
                        Autorizado apenas: <span className="font-mono">{request.approvedRule}</span>
                      </p>
                    )}
                    {request.status === "denied" && (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Você recusou. Nada foi autorizado e nada foi executado.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {failing.length > 0 && (
            <div>
              <SectionLabel>Diagnóstico</SectionLabel>
              {failing.map((step) => {
                const data = parseDetail(step);
                return (
                  <div key={step.id} className="mt-2 rounded-lg border border-danger/30 bg-danger/[0.05] p-3">
                    <div className="text-xs font-semibold text-danger">
                      {PHASE_LABEL[step.phase] ?? step.phase} · {step.status} · iteração {step.iteration}
                    </div>
                    {step.summary && (
                      <>
                        {/* What this text is, said before it is shown.
                            A `worker` step's summary is the *task that was
                            sent*, not what came back - and printed bare under
                            "Diagnóstico" it reads as the worker's own answer,
                            which is the one thing it must never be mistaken
                            for. What the worker actually produced is on its
                            invocation, below. */}
                        {step.phase === "worker" && (
                          <div className="mt-1 text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                            Tarefa enviada ao worker — não é a resposta dele
                          </div>
                        )}
                        <p className="mt-1 text-sm text-foreground/90">{step.summary}</p>
                      </>
                    )}
                    {data && (
                      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                        {Object.entries(data).map(([key, value]) => (
                          <div key={key} className="contents">
                            <dt className="text-muted-foreground">{DETAIL_LABEL[key] ?? key}</dt>
                            <dd className="overflow-x-auto font-mono whitespace-pre-wrap">
                              {key === "failure" && typeof value === "string"
                                ? failureLabel(value)
                                : Array.isArray(value)
                                  ? value.join(", ")
                                  : typeof value === "string"
                                    ? value
                                    : JSON.stringify(value)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {detail && (
            <div>
              <SectionLabel>Etapas</SectionLabel>
              <ul className="mt-2 space-y-1">
                {detail.steps.map((s) => (
                  <li key={s.id} className="flex items-baseline gap-2 text-xs">
                    <span className="w-6 shrink-0 font-mono text-muted-foreground">{s.iteration}</span>
                    <span className="w-28 shrink-0 text-muted-foreground">{PHASE_LABEL[s.phase] ?? s.phase}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 py-0.5 text-[10px] uppercase",
                        s.status === "ok" || s.status === "passed" || s.status === "accepted"
                          ? "bg-success/15 text-success"
                          : s.status === "running" || s.status === "collected"
                            ? "bg-muted text-muted-foreground"
                            : "bg-danger/15 text-danger",
                      )}
                    >
                      {s.status}
                    </span>
                    <span className="min-w-0 truncate">{s.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail && detail.invocations.length > 0 && (
            <div>
              <SectionLabel>Invocações</SectionLabel>
              <ul className="mt-2 space-y-1">
                {detail.invocations.map((inv) => (
                  <li key={inv.id} className="text-xs" data-testid="invocation-row">
                    <span className="font-mono text-muted-foreground">it. {inv.iteration}</span>{" "}
                    <span className="font-semibold">
                      {inv.role === "ORCHESTRATOR" ? "Orquestrador" : (inv.workerId ?? "Worker")}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      {/* Who answered and how it was reached: a person needs to
                          know whether this invocation was on their plan or on a
                          metered key, and no other line says so. */}
                      {inv.providerId ? `${providerLabel(inv.providerId)} · ` : ""}
                      {inv.connectionKind === "api"
                        ? "API "
                        : inv.connectionKind === "cli"
                          ? "ferramenta oficial "
                          : ""}
                      {inv.outcome}
                      {inv.exitCode !== null ? ` · código ${inv.exitCode}` : ""}
                      {inv.durationMs !== null ? ` · ${(inv.durationMs / 1000).toFixed(1)}s` : ""}
                    </span>
                    {inv.failureKind && (
                      <p className="mt-0.5 text-danger" data-testid="invocation-failure">
                        Falha: {failureLabel(inv.failureKind)}
                        {/* The tool's own words, next to our classification.
                            "erro do provider" is true and useless on its own;
                            `subtype=error_max_turns` is what a person can act
                            on. This is the field whose absence made a failed
                            run unexplainable. */}
                        {inv.failureDetail ? (
                          <span className="font-mono text-[11px]"> · {inv.failureDetail}</span>
                        ) : null}
                      </p>
                    )}
                    {/* Everything the tool reported about how it ran. A field
                        it did not report says "não informado" rather than
                        being hidden, because "we never asked" and "it did not
                        answer" are different facts and both are worth seeing. */}
                    {(inv.failureKind || inv.stderrExcerpt) && (
                      <dl
                        className="mt-1 grid gap-x-3 gap-y-0.5 text-[11px] sm:grid-cols-[auto_1fr]"
                        data-testid="invocation-diagnostics"
                      >
                        {(
                          [
                            ['Executável', inv.executable],
                            ['Versão do CLI', inv.cliVersion],
                            ['Pasta de trabalho', inv.workingDirectory],
                            ['Sinal', inv.signal],
                            ['Última atividade', inv.lastActivityAt],
                            ['Ferramenta', inv.currentTool],
                            [
                              'Limite de silêncio',
                              inv.idleTimeoutMs === null
                                ? null
                                : `${Math.round(inv.idleTimeoutMs / 1000)}s`,
                            ],
                            ['Início', inv.startedAt],
                            ['Fim', inv.finishedAt],
                          ] as ReadonlyArray<readonly [string, string | null]>
                        ).map(([label, value]) => (
                          <Fragment key={label}>
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className={cn("truncate font-mono", value === null && "text-muted-foreground/60")}>
                              {value ?? "não informado"}
                            </dd>
                          </Fragment>
                        ))}
                      </dl>
                    )}
                    {inv.stderrExcerpt && (
                      <pre
                        className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-raised p-2 font-mono text-[11px] text-foreground/80"
                        data-testid="invocation-stderr"
                      >
                        {inv.stderrExcerpt}
                      </pre>
                    )}
                    <p className="mt-0.5 text-muted-foreground" data-testid="invocation-usage">
                      {usageLine(inv)}
                    </p>
                    {inv.task && <p className="mt-0.5 truncate text-muted-foreground">{inv.task}</p>}
                    {inv.selectionMode && (
                      <p className="mt-0.5 text-muted-foreground" data-testid="invocation-routing">
                        Enviado ao runtime: modelo <span className="font-mono">{inv.model ?? "padrão do CLI"}</span>
                        {" · "}Raciocínio {reasoningLabel(inv.reasoning) ?? inv.reasoning ?? "padrão do CLI"}
                        {" · "}Seleção {selectionModeLabel(inv.selectionMode) ?? inv.selectionMode}
                        {inv.fallbackUsed ? " (com fallback)" : ""}
                        {inv.requestedCapability
                          ? ` · Pedido ${inv.requestedCapability}/${inv.requestedReasoning ?? "-"}`
                          : ""}
                        <span className="block" data-testid="invocation-actual">{observationLine(inv.routingObservation)}</span>
                        {inv.selectionReason && (
                          <span className="block truncate" title={inv.selectionReason}>
                            Motivo: {inv.selectionReason}
                          </span>
                        )}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The four states an authorisation can be in, named rather than coloured.
 *
 * "Aguardando você" and "Você recusou" are opposite situations that a single
 * NEEDS_HUMAN run status cannot tell apart, and telling them apart is what
 * section 5 is about: one of them wants something from the person and the
 * other is a decision they already made.
 */
const PERMISSION_LABEL: Record<PermissionRequestView["status"], string> = {
  pending: "aguardando você",
  approved: "autorizado",
  denied: "você recusou",
  superseded: "substituído",
};

const PERMISSION_TONE: Record<PermissionRequestView["status"], string> = {
  pending: "bg-attention/15 text-attention",
  approved: "bg-success/15 text-success",
  denied: "bg-muted text-muted-foreground",
  superseded: "bg-muted text-muted-foreground",
};

function observationLine(raw: string | null | undefined): string {
  try {
    const o=JSON.parse(raw??'{}');
    return `Teto: ${o.ceiling??'não registrado'} · Após limite: ${o.capped??'não registrado'} · Efetivo informado pelo provedor: ${o.actualModel??'não informado'} / ${o.actualReasoning??'não informado'}`;
  } catch { return 'Modelo e raciocínio efetivos: não informados pelo provedor'; }
}
