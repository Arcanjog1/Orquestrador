/**
 * The vocabulary the interface draws with.
 *
 * Types, run-state labels and tones come from the approved design and are kept
 * exactly as they were: `runStateMeta` decides every colour, icon and hint in
 * the status pill, the activity panel and the composer.
 *
 * What the prototype also had here - projects, accounts, branches, run history,
 * evidence, diffs - was sample content. None of it survives: every one of those
 * facts now comes from the main process, and where the application does not
 * have one, the interface renders an empty state rather than a placeholder.
 */

export type Provider = "openai" | "anthropic" | "github" | "gemini";

export type AgentRole = "ORCHESTRATOR" | "CODING WORKER" | "REVIEW" | "IMAGE GENERATOR";

export type RunState =
  | "IDLE"
  | "PLANNING"
  | "DELEGATING"
  | "WORKER_RUNNING"
  | "COLLECTING_EVIDENCE"
  | "VERIFYING"
  | "REVIEWING"
  | "RETRYING"
  | "PAUSING"
  | "PAUSED"
  | "NEEDS_HUMAN"
  | "DONE"
  | "CANCELLED"
  | "FAILED";

export type StatusTone = "neutral" | "running" | "success" | "attention" | "danger" | "muted";

export const runStateMeta: Record<
  RunState,
  { label: string; tone: StatusTone; hint: string }
> = {
  IDLE: { label: "Aguardando", tone: "neutral", hint: "Nenhuma execução ativa" },
  PLANNING: { label: "Planejando", tone: "running", hint: "Orchestrator analisando o objetivo" },
  DELEGATING: { label: "Delegando", tone: "running", hint: "Enviando instrução ao worker" },
  WORKER_RUNNING: { label: "Executando", tone: "running", hint: "Coding Worker trabalhando" },
  COLLECTING_EVIDENCE: { label: "Coletando evidências", tone: "running", hint: "Lendo git e artefatos" },
  VERIFYING: { label: "Verificando", tone: "running", hint: "Rodando checagens" },
  REVIEWING: { label: "Revisando", tone: "running", hint: "Orchestrator avaliando evidências" },
  RETRYING: { label: "Nova iteração", tone: "running", hint: "Gerando nova instrução" },
  PAUSING: { label: "Pausando", tone: "attention", hint: "Finalizando operação segura" },
  PAUSED: { label: "Pausado", tone: "attention", hint: "Execução pausada pelo usuário" },
  NEEDS_HUMAN: { label: "Revisão necessária", tone: "attention", hint: "Decisão humana requerida" },
  DONE: { label: "Concluído", tone: "success", hint: "Verificado pelo Done Gate" },
  CANCELLED: { label: "Cancelado", tone: "muted", hint: "Execução interrompida pelo usuário" },
  FAILED: { label: "Falhou", tone: "danger", hint: "Blocker impossível de resolver" },
};

/**
 * An agent as the interface shows it.
 *
 * `model` and `reasoning` are nullable on purpose: the prototype could promise
 * "GPT-X · Alto" for every card, the real application cannot. A card with no
 * recorded model shows no model badge at all.
 */
export type Agent = {
  role: string;
  provider: Provider;
  agent: string;
  account: string | null;
  model: string | null;
  reasoning: string | null;
};

/** The reasoning level as the interface names it; the CLIs take the key. */
export function reasoningLabel(level: string | null | undefined): string | null {
  switch (level) {
    case "low":
      return "Baixo";
    case "medium":
      return "Médio";
    case "high":
      return "Alto";
    case "xhigh":
      return "Extra alto";
    case "max":
      return "Máximo";
    default:
      return null;
  }
}

/** How the worker's model is chosen, as the interface names it. */
export function selectionLabel(selection: string | null | undefined): string {
  switch (selection) {
    case "speed":
      return "Priorizar velocidade";
    case "quality":
      return "Priorizar qualidade";
    case "manual":
      return "Manual";
    default:
      return "Automático";
  }
}

/** The selection mode recorded on one invocation (`auto` | `manual` | `fixed`). */
export function selectionModeLabel(mode: string | null | undefined): string | null {
  switch (mode) {
    case "auto":
      return "Automático";
    case "manual":
      return "Manual";
    case "fixed":
      return "Fixo";
    default:
      return null;
  }
}

export const suggestions = [
  "Corrigir um bug",
  "Implementar recurso",
  "Revisar projeto",
  "Executar testes",
];
