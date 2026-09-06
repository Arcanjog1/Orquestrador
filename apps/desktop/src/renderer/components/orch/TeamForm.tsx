import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, messageOf } from "@/lib/api";
import { reasoningLabel, selectionLabel } from "@/lib/orchestrator-data";
import { ProviderIcon, SectionLabel } from "./primitives";
import type {
  AccountView,
  ProviderName,
  ReasoningLevel,
  TeamMemberView,
  WorkerSelection,
  WorkspaceView,
} from "@shared/ipc-contract";

/**
 * The team of one project: who supervises, who executes, with which account -
 * and how each one's model is chosen.
 *
 *   Orchestrator  Provider fixed (OpenAI · Codex); account by name; model and
 *                 reasoning are the person's fixed choice, blank meaning the
 *                 CLI's default.
 *   Worker        Provider fixed (Anthropic · Claude Code); account by name;
 *                 the model and reasoning are chosen by the AI Orchestrator
 *                 for each task ("Automático"), with a strategy to lean on.
 *                 "Configuração avançada" opens the manual override: a model
 *                 and a level typed by the person, sent exactly.
 *
 * Saving is `workspace.setTeam`, which is what the loop reads on its next run
 * and what a restart shows again.
 */

const ROLES: ReadonlyArray<{
  role: TeamMemberView["role"];
  title: string;
  provider: ProviderName;
  providerLabel: string;
  agentLabel: string;
  modelHint: string;
}> = [
  {
    role: "ORCHESTRATOR",
    title: "Orchestrator",
    provider: "openai",
    providerLabel: "OpenAI",
    agentLabel: "Codex",
    modelHint: "ex.: gpt-5.1-codex",
  },
  {
    role: "CODING_WORKER",
    title: "Coding worker",
    provider: "anthropic",
    providerLabel: "Anthropic",
    agentLabel: "Claude Code",
    modelHint: "ex.: claude-opus-5",
  },
];

/**
 * Levels a person can pick by name. Each is checked against the installed
 * CLI before it is sent; one the CLI does not support is replaced by the
 * strongest it does, and the run says so.
 */
const LEVELS: ReasoningLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** The automatic strategies, in the order the picker shows them. */
const STRATEGIES: WorkerSelection[] = ["auto", "speed", "quality"];

/** Radix Select cannot hold an empty string, so "default" stands in for it. */
const DEFAULT = "__default__";

interface MemberDraft {
  accountId: string;
  model: string;
  reasoning: string;
  selection: WorkerSelection;
}

function draftOf(member: TeamMemberView | undefined, fallback: AccountView | undefined): MemberDraft {
  return {
    accountId: member?.accountId ?? fallback?.id ?? "",
    model: member?.model ?? "",
    reasoning: member?.reasoning ?? DEFAULT,
    selection: member?.selection ?? "auto",
  };
}

export function TeamForm({
  workspace,
  accounts,
  onSaved,
  onCancel,
  submitLabel = "Salvar equipe",
}: {
  workspace: WorkspaceView | null;
  accounts: readonly AccountView[];
  onSaved: () => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const byProvider = useMemo(() => {
    const out: Record<ProviderName, AccountView[]> = { openai: [], anthropic: [] };
    for (const account of accounts) {
      if (account.provider === "openai" || account.provider === "anthropic") {
        out[account.provider].push(account);
      }
    }
    // A connected account first, so the default pick is the one that works.
    for (const list of Object.values(out)) {
      list.sort((a, b) => Number(b.state === "connected") - Number(a.state === "connected"));
    }
    return out;
  }, [accounts]);

  const [drafts, setDrafts] = useState<Record<TeamMemberView["role"], MemberDraft>>(() => ({
    ORCHESTRATOR: draftOf(workspace?.team.orchestrator, byProvider.openai[0]),
    CODING_WORKER: draftOf(workspace?.team.worker, byProvider.anthropic[0]),
  }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed when the project or the accounts change under the form.
  useEffect(() => {
    setDrafts({
      ORCHESTRATOR: draftOf(workspace?.team.orchestrator, byProvider.openai[0]),
      CODING_WORKER: draftOf(workspace?.team.worker, byProvider.anthropic[0]),
    });
    setError(null);
  }, [workspace?.id, workspace?.team, byProvider]);

  const complete = drafts.ORCHESTRATOR.accountId !== "" && drafts.CODING_WORKER.accountId !== "";

  const update = (role: TeamMemberView["role"], patch: Partial<MemberDraft>) =>
    setDrafts((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }));

  const toInput = (role: TeamMemberView["role"], draft: MemberDraft) => ({
    accountId: draft.accountId,
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.reasoning !== DEFAULT ? { reasoning: draft.reasoning as ReasoningLevel } : {}),
    ...(role === "CODING_WORKER" ? { selection: draft.selection } : {}),
  });

  const save = async () => {
    if (!workspace || !complete) return;
    setSaving(true);
    setError(null);
    try {
      await api.workspace.setTeam({
        workspaceId: workspace.id,
        orchestrator: toInput("ORCHESTRATOR", drafts.ORCHESTRATOR),
        worker: toInput("CODING_WORKER", drafts.CODING_WORKER),
      });
      onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="team-form">
      {ROLES.map((spec) => {
        const options = byProvider[spec.provider];
        const draft = drafts[spec.role];
        const prefix = spec.role === "ORCHESTRATOR" ? "orchestrator" : "worker";
        const isWorker = spec.role === "CODING_WORKER";
        const manual = isWorker && draft.selection === "manual";
        return (
          <div
            key={spec.role}
            className="rounded-lg border border-border bg-surface-raised p-3"
            data-testid={`team-${prefix}`}
          >
            <div className="flex items-center gap-2">
              <ProviderIcon provider={spec.provider} />
              <SectionLabel>{spec.title}</SectionLabel>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {spec.providerLabel} · {spec.agentLabel}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Labeled label="Provider">
                <div className="mt-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs">
                  {spec.providerLabel}
                </div>
              </Labeled>
              <Labeled label="Account">
                {options.length === 0 ? (
                  <div
                    className="mt-1 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground"
                    data-testid={`team-${prefix}-account-empty`}
                  >
                    Nenhuma conta {spec.providerLabel}. Adicione em Contas e integrações.
                  </div>
                ) : (
                  <Select
                    value={draft.accountId}
                    onValueChange={(accountId) => update(spec.role, { accountId })}
                  >
                    <SelectTrigger
                      className="mt-1 h-8 text-xs"
                      data-testid={`team-${prefix}-account`}
                    >
                      <SelectValue placeholder="Escolha a conta" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name}
                          <span className="ml-1.5 text-muted-foreground">
                            · {account.state === "connected" ? "Conectada" : "Não conectada"}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Labeled>

              {isWorker && !manual && (
                <>
                  <Labeled label="Seleção">
                    <div
                      className="mt-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
                      data-testid="team-worker-selection"
                    >
                      Automático
                    </div>
                  </Labeled>
                  <Labeled label="Estratégia">
                    <Select
                      value={draft.selection}
                      onValueChange={(selection) =>
                        update(spec.role, { selection: selection as WorkerSelection })
                      }
                    >
                      <SelectTrigger className="mt-1 h-8 text-xs" data-testid="team-worker-strategy">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STRATEGIES.map((strategy) => (
                          <SelectItem key={strategy} value={strategy}>
                            {strategy === "auto" ? "Balanceado" : selectionLabel(strategy)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Labeled>
                </>
              )}

              {(!isWorker || manual) && (
                <>
                  <Labeled label="Model">
                    <Input
                      className="mt-1 h-8 font-mono text-xs"
                      placeholder={`padrão do CLI (${spec.modelHint})`}
                      value={draft.model}
                      onChange={(e) => update(spec.role, { model: e.target.value })}
                      data-testid={`team-${prefix}-model`}
                    />
                  </Labeled>
                  <Labeled label="Reasoning">
                    <Select
                      value={draft.reasoning}
                      onValueChange={(reasoning) => update(spec.role, { reasoning })}
                    >
                      <SelectTrigger
                        className="mt-1 h-8 text-xs"
                        data-testid={`team-${prefix}-reasoning`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT}>Padrão do CLI</SelectItem>
                        {LEVELS.map((level) => (
                          <SelectItem key={level} value={level}>
                            {reasoningLabel(level)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Labeled>
                </>
              )}
            </div>

            {isWorker && (
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                {manual ? (
                  <>
                    <span data-testid="team-worker-manual-hint">
                      Seleção manual: o modelo e o nível acima são enviados exatamente como
                      digitados. Um nível que a versão instalada não suporta é substituído, e a
                      execução avisa.
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 shrink-0 text-[11px]"
                      onClick={() => update(spec.role, { selection: "auto" })}
                      data-testid="team-worker-automatic"
                    >
                      Voltar para automático
                    </Button>
                  </>
                ) : (
                  <>
                    <span data-testid="team-worker-auto-hint">
                      O AI Orchestrator escolhe o modelo e o nível de raciocínio para cada tarefa.
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 shrink-0 text-[11px]"
                      onClick={() => update(spec.role, { selection: "manual" })}
                      data-testid="team-worker-advanced"
                    >
                      Configuração avançada
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}

      {error && (
        <p className="text-xs text-danger" data-testid="team-error">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        )}
        <Button
          onClick={() => void save()}
          disabled={saving || !workspace || !complete}
          data-testid="team-save"
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />} {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">{label}</div>
      {children}
    </div>
  );
}
