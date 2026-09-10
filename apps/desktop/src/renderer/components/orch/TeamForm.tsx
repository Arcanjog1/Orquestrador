import { HeroPortrait } from './HeroPortrait';
import {roleDefinition,type PolicyLayer} from '@shared/agent-policy';
import {PolicyLayerFields} from './AgentPolicyFields';
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
  RuntimeStatusView,
  TeamMemberView,
  WorkerSelection,
  WorkspaceView,
} from "@shared/ipc-contract";

/**
 * The team of one project: who supervises, who executes, with which account -
 * and how each one's model is chosen.
 *
 *   Orchestrator  Provider fixed (OpenAI · Codex); account by name. Model and
 *                 reasoning are the Codex CLI's own default unless the person
 *                 pins them under "Configuração avançada" - there is no
 *                 reliable model catalogue to offer, so none is invented, and
 *                 the reasoning levels offered are the ones the installed
 *                 Codex build accepts.
 *   Worker        Provider fixed (Anthropic · Claude Code); account by name;
 *                 the model and reasoning are chosen by the AI Orchestrator
 *                 for each task ("Automático"), with a strategy to lean on.
 *                 "Configuração avançada" opens the manual override.
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

/** Every level the interface can name; a runtime narrows it (see `levelsFor`). */
const ALL_LEVELS: ReasoningLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** The automatic strategies, in the order the picker shows them. */
const STRATEGIES: WorkerSelection[] = ["auto", "speed", "quality"];

/** Radix Select cannot hold an empty string, so "default" stands in for it. */
const DEFAULT = "__default__";

interface MemberDraft {
  agentId?: string;
  accountId: string;
  model: string;
  reasoning: string;
  selection: WorkerSelection;
}

/**
 * The saved workers as drafts, in slot order.
 *
 * A project saved before teams could grow has one worker and reads back as a
 * list of one, so the form does not need to know which era it came from.
 */
function workerDraftsOf(
  workspace: WorkspaceView | null,
  byProvider: Record<ProviderName, AccountView[]>,
): MemberDraft[] {
  const saved = workspace?.team.workers ?? [];
  if (saved.length > 0) return saved.map((member) => draftOf(member, undefined));
  return [draftOf(workspace?.team.worker, byProvider.anthropic[0])];
}

function draftOf(member: TeamMemberView | undefined, fallback: AccountView | undefined): MemberDraft {
  return {
    agentId: member?.agentId ?? undefined,
    accountId: member?.accountId ?? fallback?.id ?? "",
    model: member?.model ?? "",
    reasoning: member?.reasoning ?? DEFAULT,
    selection: member?.selection ?? "auto",
  };
}

export function TeamForm({
  workspace,
  accounts,
  runtimes = [],
  onSaved,
  onCancel,
  submitLabel = "Salvar equipe",
}: {
  workspace: WorkspaceView | null;
  accounts: readonly AccountView[];
  /** The runtime diagnostic, so the reasoning picker offers what the build takes. */
  runtimes?: readonly RuntimeStatusView[];
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

  // One orchestrator, and a list of workers. A team of one is the same shape
  // with one entry, so a project that never adds a second worker looks and
  // behaves exactly as it did.
  const [orchestrator, setOrchestrator] = useState<MemberDraft>(() =>
    draftOf(workspace?.team.orchestrator, byProvider.openai[0]),
  );
  const [workers, setWorkers] = useState<MemberDraft[]>(() => workerDraftsOf(workspace, byProvider));
  const [agents, setAgents] = useState<import('@shared/ipc-contract').ManagedAgentView[]>([]);
  useEffect(() => { void api.agents.manage().then(list=>setAgents([...list])).catch(()=>undefined); }, [accounts]);
  const [projectPolicy,setProjectPolicy]=useState<PolicyLayer>({});
  useEffect(()=>{if(workspace)void api.agents.projectPolicy({workspaceId:workspace.id}).then(setProjectPolicy).catch(()=>undefined);},[workspace?.id]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The runtime diagnostic, read here when the caller has none: the
  // reasoning picker must offer what the installed build takes.
  const [diagnosed, setDiagnosed] = useState<readonly RuntimeStatusView[]>([]);
  useEffect(() => {
    if (runtimes.length > 0) return;
    let cancelled = false;
    void api.runtime
      .diagnose()
      .then((view) => {
        if (!cancelled) setDiagnosed(view.runtimes);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runtimes.length]);
  const known = runtimes.length > 0 ? runtimes : diagnosed;

  // Re-seed when the project or the accounts change under the form.
  useEffect(() => {
    setOrchestrator(draftOf(workspace?.team.orchestrator, byProvider.openai[0]));
    setWorkers(workerDraftsOf(workspace, byProvider));
    setError(null);
  }, [workspace?.id, workspace?.team, byProvider]);

  // Distinct agents may share a connection: each retains its own session.
  // Reject reusing the same agent (or the same legacy default) in two slots.
  const duplicate = (() => {
    const used = new Set<string>();
    for (const worker of workers) {
      if (!worker.accountId) continue;
      if (used.has(worker.agentId || worker.accountId)) return true;
      used.add(worker.agentId || worker.accountId);
    }
    return false;
  })();

  const complete =
    orchestrator.accountId !== "" &&
    workers.length > 0 &&
    workers.every((w) => w.accountId !== "") &&
    !duplicate;

  const updateWorker = (index: number, patch: Partial<MemberDraft>) =>
    setWorkers((prev) => prev.map((w, i) => (i === index ? { ...w, ...patch } : w)));

  /** The next unused Anthropic connection, so adding a worker suggests one. */
  const addWorker = () => {
    const used = new Set(workers.map((w) => w.accountId));
    const free = byProvider.anthropic.find((a) => !used.has(a.id));
    setWorkers((prev) => [...prev, draftOf(undefined, free)]);
  };

  // What happens to the work when a run ends. Only a cloud project asks: a
  // local one has a working copy the person commits and pushes themselves.
  const [publish, setPublish] = useState({
    enabled: workspace?.publish?.enabled ?? true,
    pullRequest: workspace?.publish?.pullRequest ?? false,
  });
  useEffect(() => {
    setPublish({
      enabled: workspace?.publish?.enabled ?? true,
      pullRequest: workspace?.publish?.pullRequest ?? false,
    });
  }, [workspace?.id, workspace?.publish?.enabled, workspace?.publish?.pullRequest]);

  const toInput = (draft: MemberDraft) => ({
    accountId: draft.accountId,
    ...(draft.agentId ? {agentId:draft.agentId} : {}),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.reasoning !== DEFAULT ? { reasoning: draft.reasoning as ReasoningLevel } : {}),
    selection: draft.selection,
  });

  const save = async () => {
    if (!workspace || !complete) return;
    setSaving(true);
    setError(null);
    try {
      await api.workspace.setTeam({
        workspaceId: workspace.id,
        orchestrator: toInput(orchestrator),
        // Slot 0 twice: `worker` for callers that read one, `workers` for the
        // whole team. The main process prefers the list when it is there.
        worker: toInput(workers[0]!),
        workers: workers.map(toInput),
      });
      if (workspace.environment === "cloud") {
        await api.workspace.setPublish({ workspaceId: workspace.id, ...publish });
      }
      await api.agents.saveProjectPolicy({workspaceId:workspace.id,policy:projectPolicy});
      onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  /**
   * The reasoning levels a role may pin: what the installed runtime accepts
   * when the diagnostic says, every named level otherwise. A saved level the
   * runtime no longer takes stays selectable so the person sees it - the
   * run replaces it and says so.
   */
  const levelsFor = (role: TeamMemberView["role"], saved: string): string[] => {
    const runtime = known.find((r) => r.runtimeId === (role === "ORCHESTRATOR" ? "codex" : "claude-code"));
    const offered: string[] = runtime?.reasoningLevels
      ? ALL_LEVELS.filter((l) => runtime.reasoningLevels!.includes(l))
      : [...ALL_LEVELS];
    return saved !== DEFAULT && !offered.includes(saved) ? [...offered, saved] : offered;
  };

  // One row per team member: the orchestrator, then each worker in order.
  // Building the list here rather than branching inside the render keeps the
  // member card one piece of markup for every role.
  const rows: Array<{
    key: string;
    spec: (typeof ROLES)[number];
    draft: MemberDraft;
    prefix: string;
    index: number;
    update: (patch: Partial<MemberDraft>) => void;
    remove: (() => void) | null;
  }> = [
    {
      key: "orchestrator",
      spec: ROLES[0]!,
      draft: orchestrator,
      prefix: "orchestrator",
      index: 0,
      update: (patch) => setOrchestrator((prev) => ({ ...prev, ...patch })),
      remove: null,
    },
    ...workers.map((draft, index) => ({
      key: `worker-${index}`,
      spec: ROLES[1]!,
      draft,
      // Slot 0 keeps the original test ids, so every existing assertion about
      // "the worker" still points at the first one.
      prefix: index === 0 ? "worker" : `worker-${index + 1}`,
      index,
      update: (patch: Partial<MemberDraft>) => updateWorker(index, patch),
      // The last worker cannot be removed: a team with no worker cannot run.
      remove: workers.length > 1 ? () => setWorkers((prev) => prev.filter((_, i) => i !== index)) : null,
    })),
  ];

  return (
    <div className="space-y-3" data-testid="team-form">
      <details className="border rounded p-3"><summary>Políticas deste projeto</summary><p className="text-xs text-muted-foreground my-2">Restrições adicionais aos padrões globais e à configuração individual.</p><PolicyLayerFields value={projectPolicy} onChange={setProjectPolicy}/></details>
      {rows.map(({ key, spec, draft, prefix, index, update: updateRow, remove }) => {
        const options = accounts.filter(account=>agents.some(a=>a.accountId===account.id&&a.enabled&&roleDefinition(a.role)?.lane===(spec.role==='ORCHESTRATOR'?'supervisor':'delegate')));
        const provider=accounts.find(a=>a.id===draft.accountId)?.provider??spec.provider;
        const isWorker = spec.role === "CODING_WORKER";
        const manual = draft.selection === "manual";
        const update = (_role: TeamMemberView["role"], patch: Partial<MemberDraft>) =>
          updateRow(patch);
        const runtime = known.find((r) => r.runtimeId === (provider==='openai' ? "codex" : "claude-code"));
        return (
          <div
            key={key}
            className="rounded-lg border border-border bg-surface-raised p-3"
            data-testid={`team-${prefix}`}
          >
            <div className="flex items-center gap-2">
              <HeroPortrait role={agents.find(a=>a.id===draft.agentId)?.role??spec.role} /><ProviderIcon provider={provider==='openai'?'openai':'anthropic'} />
              <SectionLabel>
                {isWorker && workers.length > 1 ? `${spec.title} ${index + 1}` : spec.title}
              </SectionLabel>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {provider==='openai'?'OpenAI':'Anthropic'} · {provider==='openai'?'Codex':'Claude Code'}
                {runtime?.version ? ` ${runtime.version}` : ""}
              </span>
              {remove && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 text-[11px] text-muted-foreground"
                  onClick={remove}
                  data-testid={`team-${prefix}-remove`}
                >
                  Remover
                </Button>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Labeled label="Provider">
                <div className="mt-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs">
                  {provider==='openai'?'OpenAI':'Anthropic'}
                </div>
              </Labeled>
              <Labeled label="Account">
                {options.length === 0 ? (
                  <div
                    className="mt-1 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground"
                    data-testid={`team-${prefix}-account-empty`}
                  >
                    Nenhuma conta {provider==='openai'?'OpenAI':'Anthropic'}. Adicione em Contas e integrações.
                  </div>
                ) : (
                  <Select
                    value={draft.accountId}
                    onValueChange={(accountId) => update(spec.role, { accountId, agentId:agents.find(a=>a.enabled&&a.accountId===accountId&&roleDefinition(a.role)?.lane===(spec.role==='ORCHESTRATOR'?'supervisor':'delegate'))?.id })}
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

              <Labeled label="Agente">
                <select aria-label={`Agente ${prefix}`} data-testid={`team-${prefix}-agent`} className="w-full rounded border border-border bg-surface p-2 text-xs"
                  value={draft.agentId ?? ''} onChange={e=>updateRow({agentId:e.target.value || undefined})}>
                  <option value="">Agente padrão da conta</option>
                  {agents.filter(a=>a.enabled && a.accountId===draft.accountId && roleDefinition(a.role)?.lane===(spec.role==='ORCHESTRATOR'?'supervisor':'delegate')).map(a=><option key={a.id} value={a.id}>{a.name} · {roleDefinition(a.role)?.label}</option>)}
                </select>
              </Labeled>
              {/* Orchestrator, CLI default: two read-only cells that say so. */}
              {!isWorker && !manual && (
                <>
                  <Labeled label="Model">
                    <div
                      className="mt-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
                      data-testid="team-orchestrator-model-default"
                    >
                      Padrão do Codex CLI
                    </div>
                  </Labeled>
                  <Labeled label="Reasoning">
                    <div
                      className="mt-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
                      data-testid="team-orchestrator-reasoning-default"
                    >
                      Padrão do Codex CLI
                    </div>
                  </Labeled>
                </>
              )}

              {/* Worker, automatic: selection and strategy. */}
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

              {/* Either role, manual: the pinned model and level. */}
              {manual && (
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
                        {levelsFor(spec.role, draft.reasoning).map((level) => (
                          <SelectItem key={level} value={level} data-testid={`team-${prefix}-level-${level}`}>
                            {reasoningLabel(level) ?? level}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Labeled>
                </>
              )}
            </div>

            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              {manual ? (
                <>
                  <span data-testid={`team-${prefix}-manual-hint`}>
                    {isWorker
                      ? "Seleção manual: o modelo e o nível acima são enviados exatamente como digitados."
                      : "Modelo e nível fixos para o orquestrador, enviados ao Codex CLI exatamente como digitados."}{" "}
                    Um nível que a versão instalada não suporta é substituído, e a execução avisa.
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6 shrink-0 text-[11px]"
                    onClick={() => update(spec.role, { selection: "auto" })}
                    data-testid={`team-${prefix}-automatic`}
                  >
                    {isWorker ? "Voltar para automático" : "Voltar para o padrão do CLI"}
                  </Button>
                </>
              ) : (
                <>
                  <span data-testid={`team-${prefix}-auto-hint`}>
                    {isWorker
                      ? "O AI Orchestrator escolhe o modelo e o nível de raciocínio para cada tarefa."
                      : "O Codex CLI usa o modelo e o nível configurados na própria conta. Fixe um em Configuração avançada se quiser."}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6 shrink-0 text-[11px]"
                    onClick={() => update(spec.role, { selection: "manual" })}
                    data-testid={`team-${prefix}-advanced`}
                  >
                    Configuração avançada
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={addWorker}
          disabled={workers.length >= 8}
          data-testid="team-add-worker"
        >
          + Adicionar worker
        </Button>
        <span className="text-[11px] text-muted-foreground">
          Cada worker é uma conexão diferente. O orquestrador delega a um deles por vez,
          nomeando qual.
        </span>
      </div>

      {duplicate && (
        <p className="text-xs text-destructive" data-testid="team-duplicate-warning">
          Dois workers estão usando a mesma conexão. Escolha uma conexão diferente para cada
          um — a mesma conexão seria o mesmo worker com dois nomes.
        </p>
      )}

      {workspace?.environment === "cloud" && (
        <div className="rounded-lg border border-border p-3" data-testid="publish-choice">
          <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
            Resultado
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            O ambiente de nuvem é descartável: o que não for enviado some junto com ele.
          </p>
          <label className="mt-3 flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={publish.enabled}
              onChange={(e) =>
                setPublish((p) => ({
                  enabled: e.target.checked,
                  // Um PR sem branch publicada não existe.
                  pullRequest: e.target.checked ? p.pullRequest : false,
                }))
              }
              data-testid="publish-enabled"
            />
            <span>
              <span className="text-foreground">Enviar o resultado para uma branch</span>
              <span className="block text-muted-foreground">
                Uma branch por execução, criada no repositório. Nada é sobrescrito.
              </span>
            </span>
          </label>
          <label className="mt-2 flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={publish.pullRequest}
              disabled={!publish.enabled}
              onChange={(e) => setPublish((p) => ({ ...p, pullRequest: e.target.checked }))}
              data-testid="publish-pull-request"
            />
            <span>
              <span className="text-foreground">Abrir um pull request</span>
              <span className="block text-muted-foreground">
                Só um por execução. Se já existir, nenhum outro é aberto.
              </span>
            </span>
          </label>
        </div>
      )}

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
