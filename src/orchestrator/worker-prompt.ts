import { fileContext, type FileDelivery } from './file-context.js';
import type { FileReadResult } from '../verification/file-check.js';
/**
 * The instruction a worker actually receives.
 *
 * ## What was wrong
 *
 * Three times in one run the worker reported that its instruction said
 * *"confira os critérios abaixo"* or *"revise os quatro critérios abaixo"* -
 * and that **no list followed**. It was right. The delegation prompt was:
 *
 *     `${toolPolicyPreamble(...)}\n\n${task}`
 *
 * and `task` is the free text the supervisor wrote. The decision's
 * `acceptanceCriteria` were recorded in the ledger, shown in the interface and
 * checked by the gate - and never sent to the worker at all. The supervisor
 * wrote a pointer; nothing on this side ever resolved it.
 *
 * ## The rule
 *
 * A referenced list travels, or the reference is corrected. Those are the only
 * two outcomes. What is never acceptable is a prompt that points at something
 * that is not in it - the worker then either invents the criteria or spends
 * the delegation saying it cannot see them, and both happened.
 *
 * The criteria sent are **this decision's**, not the run's whole ledger: a
 * worker asked to create one file has no use for the criteria of a task it is
 * not doing, and a prompt that carries them invites it to work on the wrong
 * thing.
 */

/** Ways a supervisor points at a list it expects to be appended. */
const POINTS_AT_A_LIST =
  /\b(crit[ée]rios?|requisitos?|itens?|lista|criteria|requirements?)\b[^.\n]{0,60}\b(abaixo|a seguir|seguintes?|listad[oa]s?|below|following|listed)\b|\b(abaixo|a seguir|below|following)\b[^.\n]{0,40}\b(crit[ée]rios?|requisitos?|criteria|requirements?)\b/i;

export interface WorkerPromptInput {
  /** The tool policy, which always leads. */
  readonly preamble: string;
  /** What the supervisor asked for, in its own words. */
  readonly task: string;
  /** The acceptance criteria of *this* decision. */
  readonly criteria: readonly string[];
  readonly fileReads?: readonly FileReadResult[];
}

export interface WorkerPrompt {
  readonly text: string;
  readonly deliveries: readonly FileDelivery[];
  /** True when criteria were appended. */
  readonly criteriaSent: number;
  /**
   * True when the task pointed at a list and there was none to send.
   *
   * Recorded rather than hidden: it is a defect in the *supervisor's* wording,
   * and a run where it keeps happening is a run going in circles.
   */
  readonly danglingReference: boolean;
}

export function buildWorkerPrompt(input: WorkerPromptInput): WorkerPrompt {
  const task = input.task.trim();
  const criteria = input.criteria.map((c) => c.trim()).filter((c) => c.length > 0);
  const parts = [input.preamble.trim(), task].filter((part) => part.length > 0);

  const carried = fileContext(input.fileReads ?? [], 'WORKER');
  if (carried.text) parts.push(carried.text);

  if (criteria.length > 0) {
    parts.push(
      [
        'CRITÉRIOS DE ACEITE DESTA TAREFA (os que o supervisor definiu para esta delegação):',
        ...criteria.map((criterion, index) => `  ${index + 1}. ${criterion}`),
        '',
        'Estes são os critérios a que a instrução acima se refere. Não invente outros, e diga',
        'no seu relatório quais você tratou e quais não.',
      ].join('\n'),
    );
    return { deliveries: carried.deliveries, text: parts.join('\n\n'), criteriaSent: criteria.length, danglingReference: false };
  }

  const dangling = POINTS_AT_A_LIST.test(task);
  if (dangling) {
    // The pointer is corrected in the prompt itself. Inventing a list here
    // would be worse than the defect: the worker would be checked against
    // criteria nobody set.
    parts.push(
      [
        'OBSERVAÇÃO DO APLICATIVO: a instrução acima menciona uma lista de critérios, e',
        'nenhuma foi enviada com esta delegação - o supervisor não definiu critérios para',
        'ela. Não tente adivinhar quais seriam. Trabalhe pelo texto da tarefa e registre no',
        'seu relatório que a lista referida não chegou.',
      ].join('\n'),
    );
  }
  return { deliveries: carried.deliveries, text: parts.join('\n\n'), criteriaSent: 0, danglingReference: dangling };
}
