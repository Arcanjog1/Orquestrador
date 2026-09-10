/**
 * What the worker did, in a shape the supervisor can read.
 *
 * ## Why this exists
 *
 * The supervisor runs read-only. It cannot open a file, so after a delegation
 * its only way to find out what happened was to read a free-text answer and
 * guess - or to ask for a verification that might not exist. The application
 * already *had* the facts: the CLI's envelope, the process outcome, the
 * activity notes, the evidence it collected itself, the verifications it ran.
 * They were simply never assembled.
 *
 * ## The one rule this file is built around
 *
 * **A report is a declaration; evidence is a measurement.** They are kept in
 * separate fields, they are rendered under separate headings, and nothing here
 * ever promotes one into the other. The worker saying it created a file is
 * `declared`; the application opening the folder and seeing the file is
 * `evidence`. When the two disagree, both are reported and the disagreement is
 * named - because a report that quietly preferred either side would be worth
 * less than no report at all.
 *
 * Nothing is invented. A field the tool did not report is absent, and absent
 * is rendered as "não informado" rather than filled in with a plausible value.
 * There is no second invocation to ask the worker to write this: everything
 * here comes from the result that already came back.
 */

import type { GitEvidence, WorkerRecord } from '../core/types.js';

/** How the delegation ended, decided from facts rather than from the answer. */
export type WorkerReportStatus = 'completed' | 'partial' | 'blocked' | 'failed';

export interface ReportVerification {
  readonly label: string;
  readonly passed: boolean;
  /** Present when it did not pass: exit code, refusal, timeout. */
  readonly problem?: string;
}

export interface WorkerReportInput {
  readonly worker: WorkerRecord;
  /** The worker's own final text, exactly as it came back. */
  readonly answer: string;
  /** What the application measured, never what the worker said. */
  readonly evidence: GitEvidence | null;
  /**
   * The same measurement as the previous iteration left it.
   *
   * Without it the report can only speak about the run's baseline, so a
   * delegation that merely *read* four files reported all four as changed
   * again - the accumulated diff, presented as this invocation's work.
   */
  readonly previousEvidence: GitEvidence | null;
  /** Files this delegation asked the application to open, and only read. */
  readonly readFiles: readonly string[];
  /** Verifications and file checks the application ran this iteration. */
  readonly verifications: readonly ReportVerification[];
  /** Criteria this iteration still cannot prove. */
  readonly unproven: readonly string[];
  /** Criteria evidence settled as failed. */
  readonly failedCriteria: readonly string[];
  /** Authorisations this delegation is waiting on. */
  readonly awaitingApproval: readonly string[];
  readonly invocationId: string | null;
  readonly iteration: number;
  /** The Claude Code session the CLI reported, when it reported one. */
  readonly sessionId: string | null;
  /** The tool's own account of the failure, in its words. */
  readonly failureDetail: string | null;
  /** Tools the runtime says the worker was inside, oldest first. */
  readonly tools: readonly string[];
}

export interface WorkerReport {
  readonly status: WorkerReportStatus;
  /** One line, for the conversation. */
  readonly headline: string;
  /** The complete provider response. Compact rendering never truncates this field. */
  readonly declared: string;
  /**
   * What **this invocation** changed, measured against the iteration before it.
   *
   * Kept apart from the run's total on purpose: a delegation that only read
   * files must not report them as written, and one that changed a single file
   * must not inherit the three the previous round wrote.
   */
  readonly evidenceFiles: {
    readonly created: readonly string[];
    readonly modified: readonly string[];
    readonly deleted: readonly string[];
  };
  /** What the run has accumulated since its baseline. Context, not this turn. */
  readonly runTotalFiles: {
    readonly created: readonly string[];
    readonly modified: readonly string[];
    readonly deleted: readonly string[];
  };
  /** Files the application opened for this delegation and nothing wrote. */
  readonly readOnlyFiles: readonly string[];
  /** True when evidence was unavailable, so "nothing changed" means "unknown". */
  readonly evidenceUnavailable: boolean;
  readonly tools: readonly string[];
  readonly verifications: readonly ReportVerification[];
  readonly errors: readonly string[];
  readonly deniedTools: readonly string[];
  readonly awaitingApproval: readonly string[];
  readonly pending: readonly string[];
  /** What to do next, objectively. Never "try a stronger model" on a failure. */
  readonly recommendation: string;
  readonly invocationId: string | null;
  readonly iteration: number;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly sessionId: string | null;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly outcome: string;
  readonly mechanical: boolean;
}

// Full provider response is retained; only renderWorkerReport bounds its preview.
const MAX_FILES = 40;

export function buildWorkerReport(input: WorkerReportInput): WorkerReport {
  const worker = input.worker;
  const declared = input.answer;
  const denied = [...(worker.deniedTools ?? [])];
  const evidence = input.evidence;
  const evidenceUnavailable = evidence === null || Boolean(evidence.evidenceProblem);

  // A new file shows up in both `addedFiles` and `changedFiles`, so listing
  // both verbatim reported one file as two - and "2 arquivos alterados" for a
  // single hello.txt is the kind of small wrongness that makes a reader stop
  // trusting the rest. Created and deleted win; modified is what is left.
  const runTotal = normalise(evidence);
  // This invocation's own work: what the run shows now, minus what it already
  // showed before this delegation ran. A file the previous iteration wrote and
  // this one only read is in the run's total and not in this one's.
  const before = normalise(input.previousEvidence);
  const evidenceFiles = {
    created: cap(runTotal.created.filter((file) => !before.created.includes(file))),
    modified: cap(
      runTotal.modified.filter(
        (file) => !before.modified.includes(file) && !before.created.includes(file),
      ),
    ),
    deleted: cap(runTotal.deleted.filter((file) => !before.deleted.includes(file))),
  };
  const touched = new Set([
    ...evidenceFiles.created,
    ...evidenceFiles.modified,
    ...evidenceFiles.deleted,
  ]);
  const readOnlyFiles = cap(input.readFiles.filter((file) => !touched.has(file)));

  const errors: string[] = [];
  if (input.failureDetail) errors.push(input.failureDetail);
  if (evidence?.evidenceProblem) errors.push(evidence.evidenceProblem);
  for (const check of input.verifications) {
    if (!check.passed && check.problem) errors.push(check.problem);
  }

  const cleanExit = worker.outcome === 'completed' && worker.exitCode === 0;
  const status = decideStatus({
    cleanExit,
    denied,
    awaitingApproval: input.awaitingApproval,
    verifications: input.verifications,
    unproven: input.unproven,
    failedCriteria: input.failedCriteria,
  });

  return {
    status,
    headline: headlineOf(status, worker, evidenceFiles),
    declared,
    evidenceFiles,
    runTotalFiles: { created: cap(runTotal.created), modified: cap(runTotal.modified), deleted: cap(runTotal.deleted) },
    readOnlyFiles,
    evidenceUnavailable,
    tools: [...input.tools],
    verifications: [...input.verifications],
    errors,
    deniedTools: denied,
    awaitingApproval: [...input.awaitingApproval],
    pending: [...input.unproven, ...input.failedCriteria],
    recommendation: recommend({
      status,
      worker,
      denied,
      awaitingApproval: input.awaitingApproval,
      unproven: input.unproven,
      failedCriteria: input.failedCriteria,
      failureDetail: input.failureDetail,
    }),
    invocationId: input.invocationId,
    iteration: input.iteration,
    model: worker.routing?.resolvedModel ?? null,
    reasoning: worker.routing?.resolvedReasoning ?? null,
    sessionId: input.sessionId,
    durationMs: worker.durationMs,
    exitCode: worker.exitCode,
    outcome: worker.outcome,
    mechanical: worker.mechanical ?? false,
  };
}

function decideStatus(input: {
  cleanExit: boolean;
  denied: readonly string[];
  awaitingApproval: readonly string[];
  verifications: readonly ReportVerification[];
  unproven: readonly string[];
  failedCriteria: readonly string[];
}): WorkerReportStatus {
  // A refusal is not a failure of the work; it is the work not being allowed
  // to happen. The two need different answers from the supervisor, so they get
  // different statuses.
  if (input.denied.length > 0 || input.awaitingApproval.length > 0) return 'blocked';
  if (!input.cleanExit) return 'failed';
  if (input.failedCriteria.length > 0) return 'partial';
  if (input.verifications.some((v) => !v.passed)) return 'partial';
  return 'completed';
}

function headlineOf(
  status: WorkerReportStatus,
  worker: WorkerRecord,
  files: WorkerReport['evidenceFiles'],
): string {
  const touched = files.created.length + files.modified.length + files.deleted.length;
  const where = touched > 0 ? `${touched} arquivo(s) alterado(s)` : 'nenhum arquivo alterado';
  const seconds = (worker.durationMs / 1000).toFixed(1);
  switch (status) {
    case 'completed':
      return `Concluído em ${seconds}s — ${where}.`;
    case 'partial':
      return `Parcial em ${seconds}s — ${where}, há critério não atendido.`;
    case 'blocked':
      return `Bloqueado em ${seconds}s — faltou autorização.`;
    case 'failed':
      return `Falhou em ${seconds}s — ${where}.`;
  }
}

function recommend(input: {
  status: WorkerReportStatus;
  worker: WorkerRecord;
  denied: readonly string[];
  awaitingApproval: readonly string[];
  unproven: readonly string[];
  failedCriteria: readonly string[];
  failureDetail: string | null;
}): string {
  switch (input.status) {
    case 'blocked': {
      const what = [...input.denied, ...input.awaitingApproval].join(', ');
      return (
        `Autorize ${what || 'a ferramenta recusada'} na tela de permissões, ou responda ` +
        '"blocked" explicando o que falta. Repetir a mesma delegação não muda nada, e ' +
        'nenhum modelo recebe uma permissão que foi negada.'
      );
    }
    case 'failed':
      return input.worker.mechanical
        ? `Falha mecânica${input.failureDetail ? ` (${input.failureDetail})` : ''}: binário, ` +
            'login, cota, rede, permissão ou ambiente. NÃO aumente o modelo — nenhum ' +
            'modelo desfaz isto. Corrija a causa ou responda "blocked".'
        : `A delegação terminou mal${input.failureDetail ? ` (${input.failureDetail})` : ''}. ` +
            'Delegue apenas a correção necessária, com o erro acima como contexto.';
    case 'partial': {
      const missing = [...input.failedCriteria, ...input.unproven].slice(0, 3);
      return missing.length > 0
        ? `Falta comprovar: ${missing.map((c) => `"${c}"`).join('; ')}. Peça uma verificação ` +
            'direta de arquivo ou uma verificação registrada; não redelegue o que já está feito.'
        : 'Falta prova de que o objetivo foi atingido. Peça uma verificação antes de concluir.';
    }
    case 'completed':
      if (input.unproven.length) return 'Implementação concluída. Verificação global pendente: o aplicativo deve coletar a prova faltante.';
      return (
        'Nada pendente nesta delegação. Se todos os critérios estão comprovados, conclua ' +
        'em vez de delegar de novo.'
      );
  }
}

/**
 * Git's own lists, with the double-counting removed.
 *
 * A new file appears in both `addedFiles` and `changedFiles`, so listing both
 * verbatim reported one file as two - and "2 arquivos alterados" for a single
 * hello.txt is the kind of small wrongness that makes a reader stop trusting
 * the rest.
 */
function normalise(evidence: GitEvidence | null): {
  created: string[];
  modified: string[];
  deleted: string[];
} {
  const created = [...(evidence?.addedFiles ?? [])];
  const deleted = [...(evidence?.deletedFiles ?? [])];
  const named = new Set([...created, ...deleted]);
  return {
    created,
    modified: [...(evidence?.changedFiles ?? [])].filter((file) => !named.has(file)),
    deleted,
  };
}

function cap(list: readonly string[]): string[] {
  return list.length > MAX_FILES
    ? [...list.slice(0, MAX_FILES), `… e mais ${list.length - MAX_FILES}`]
    : [...list];
}

const STATUS_LABEL: Record<WorkerReportStatus, string> = {
  completed: 'CONCLUÍDO',
  partial: 'PARCIAL',
  blocked: 'BLOQUEADO',
  failed: 'FALHOU',
};

/**
 * The report as the conversation shows it.
 *
 * Two headings, and the split between them is the point: what the worker
 * *said* is one section, what the application *measured* is another. Nobody
 * reading this can mistake a claim for a check.
 */
export function renderWorkerReport(report: WorkerReport): string {
  const lines: string[] = [`[${STATUS_LABEL[report.status]}] ${report.headline}`];

  lines.push('', 'O QUE O WORKER RELATOU (declaração, não prova):');
  lines.push(report.declared ? indent(report.declared.slice(0, 1200)) : '  (não informado)');

  lines.push('', 'O QUE O APLICATIVO MEDIU (evidência):');
  if (report.evidenceUnavailable) {
    lines.push('  evidência indisponível — "nada mudou" aqui significa "não deu para observar"');
  }
  lines.push('  NESTA DELEGAÇÃO:');
  lines.push(`    criados:     ${report.evidenceFiles.created.join(', ') || '(nenhum)'}`);
  lines.push(`    modificados: ${report.evidenceFiles.modified.join(', ') || '(nenhum)'}`);
  lines.push(`    removidos:   ${report.evidenceFiles.deleted.join(', ') || '(nenhum)'}`);
  if (report.readOnlyFiles.length > 0) {
    lines.push(`    apenas lidos: ${report.readOnlyFiles.join(', ')}`);
  }
  if (differsFromRun(report)) {
    lines.push('  ACUMULADO NA EXECUÇÃO (desde o início, não é o trabalho desta delegação):');
    lines.push(`    criados:     ${report.runTotalFiles.created.join(', ') || '(nenhum)'}`);
    lines.push(`    modificados: ${report.runTotalFiles.modified.join(', ') || '(nenhum)'}`);
    lines.push(`    removidos:   ${report.runTotalFiles.deleted.join(', ') || '(nenhum)'}`);
  }
  if (report.verifications.length > 0) {
    lines.push('  verificações:');
    for (const check of report.verifications) {
      lines.push(
        `    ${check.passed ? 'PASSOU' : 'FALHOU'}: ${check.label}${check.problem ? ` — ${check.problem}` : ''}`,
      );
    }
  }

  // Named only when it happens, and named as a disagreement rather than
  // resolved in favour of either side.
  if (disagrees(report)) {
    lines.push(
      '',
      'DIVERGÊNCIA: o relato descreve alteração de arquivo e a evidência não mostra nenhuma.',
      'A evidência decide. O relato fica registrado como o que foi dito, não como o que houve.',
    );
  }

  if (report.deniedTools.length > 0 || report.awaitingApproval.length > 0) {
    lines.push('', 'AUTORIZAÇÕES:');
    for (const tool of report.deniedTools) lines.push(`  recusada: ${tool}`);
    for (const tool of report.awaitingApproval) lines.push(`  aguardando você: ${tool}`);
  }

  if (report.errors.length > 0) {
    lines.push('', 'ERROS:');
    for (const error of report.errors) lines.push(`  ${error}`);
  }

  if (report.pending.length > 0) {
    lines.push('', 'PENDÊNCIAS:');
    for (const item of report.pending) lines.push(`  ${item}`);
  }

  lines.push('', `PRÓXIMO PASSO: ${report.recommendation}`);
  lines.push(
    '',
    'INVOCAÇÃO:',
    `  id: ${report.invocationId ?? 'não informado'} · iteração ${report.iteration}`,
    `  modelo: ${report.model ?? 'não informado'} · raciocínio: ${report.reasoning ?? 'não informado'}`,
    `  sessão do Claude: ${report.sessionId ?? 'não informada'}`,
    `  saída: ${report.outcome}${report.exitCode !== null ? ` (exit ${report.exitCode})` : ''} · ${(report.durationMs / 1000).toFixed(1)}s`,
    ...(report.tools.length > 0 ? [`  ferramentas: ${report.tools.join(', ')}`] : []),
  );
  return lines.join('\n');
}

/**
 * True when the worker described changing a file and nothing was observed to
 * change - and evidence was actually available to say so.
 *
 * Deliberately conservative: the words are only a hint, so this never decides
 * anything on its own. It exists so the supervisor is *told* the two do not
 * line up, instead of reading a confident summary next to an empty diff.
 */
/** True when the run has more than this delegation did, so both are worth showing. */
function differsFromRun(report: WorkerReport): boolean {
  const count = (files: WorkerReport['evidenceFiles']): number =>
    files.created.length + files.modified.length + files.deleted.length;
  return count(report.runTotalFiles) !== count(report.evidenceFiles);
}

function disagrees(report: WorkerReport): boolean {
  if (report.evidenceUnavailable) return false;
  const touched =
    report.evidenceFiles.created.length +
    report.evidenceFiles.modified.length +
    report.evidenceFiles.deleted.length;
  if (touched > 0) return false;
  return /\b(criei|escrevi|adicionei|alterei|modifiquei|atualizei|created|wrote|added|updated|modified)\b/i.test(
    report.declared,
  );
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n');
}
