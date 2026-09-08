/**
 * The diagnosis of one run, as a file a person can send (spec 3).
 *
 * The complaint this answers: a run failed, the screen said "provider-error,
 * exit 1", and there was no way to get anything more without opening a
 * terminal. Asking somebody to run PowerShell to find out why their desktop
 * application failed is not a diagnostic story, it is a dead end.
 *
 * So the application writes the file itself, into a folder it owns, and offers
 * to open that folder. No terminal, no dialog plumbing, no query to type.
 *
 * ## What it contains, and what it never does
 *
 * Everything the record holds about the run: steps with their details,
 * invocations with the tool's own failure text, the exchange between the
 * agents, and the verifications. Every field goes through the same redactor
 * the database already uses, and the whole document goes through it once more
 * on the way out — belt and braces, because this file is meant to be sent to
 * somebody.
 *
 * It never includes: a credential, a token, an `auth.json`, a cookie, or the
 * full prompt text. A prompt is the person's own writing and can contain
 * anything; what a diagnosis needs is the *shape* of the run, not its content.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../core.js';
import type { PermissionRequestView, RunDetailView } from '../../shared/ipc-contract.js';

/** A field the tool did not report. Said, never hidden and never invented. */
const UNKNOWN = 'não informado';

function say(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  return String(value);
}

/**
 * Renders the report.
 *
 * Markdown, because it has to be readable in a chat window, in an issue, and
 * in Notepad — which is where it will actually be opened.
 */
export function renderDiagnostics(
  detail: RunDetailView,
  generatedAt = new Date(),
  /**
   * What this run asked a person to authorise. Optional so every existing
   * caller keeps working; absent means none were asked, which is the truth
   * for a run that never hit a refused tool.
   */
  permissions: readonly PermissionRequestView[] = [],
): string {
  const lines: string[] = [];
  const run = detail.run;

  lines.push('# Diagnóstico da execução');
  lines.push('');
  lines.push(`Gerado em ${generatedAt.toISOString()}`);
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Execução | \`${say(run.id)}\` |`);
  lines.push(`| Estado | ${say(run.status)} |`);
  lines.push(`| Iterações | ${say(run.iterations)} |`);
  lines.push(`| Objetivo | ${say(run.objective)} |`);
  lines.push(`| Resumo | ${say(run.summary)} |`);
  lines.push(`| Baseline | ${say(detail.baseline.branch)} @ ${say(detail.baseline.commit)}` +
    `${detail.baseline.dirty ? ' (árvore suja)' : ''} |`);
  lines.push('');

  lines.push('## Invocações');
  lines.push('');
  if (detail.invocations.length === 0) {
    lines.push('_Nenhuma invocação foi registrada._');
  }
  for (const invocation of detail.invocations) {
    lines.push(`### it. ${invocation.iteration} · ${invocation.role}` +
      `${invocation.workerId ? ` · ${invocation.workerId}` : ''}`);
    lines.push('');
    lines.push('| campo | valor |');
    lines.push('|---|---|');
    lines.push(`| outcome | ${say(invocation.outcome)} |`);
    lines.push(`| exitCode | ${say(invocation.exitCode)} |`);
    lines.push(`| signal | ${say(invocation.signal)} |`);
    lines.push(`| failureKind | ${say(invocation.failureKind)} |`);
    // The one that matters most: the tool's own words, which the
    // classification used to replace rather than accompany.
    lines.push(`| failureDetail | ${say(invocation.failureDetail)} |`);
    lines.push(`| provider | ${say(invocation.providerId)} · ${say(invocation.connectionKind)} |`);
    lines.push(`| modelo | ${say(invocation.model)} |`);
    lines.push(`| raciocínio | ${say(invocation.reasoning)} |`);
    lines.push(`| roteamento | ${say(invocation.requestedCapability)}/${say(invocation.requestedReasoning)}` +
      ` → ${say(invocation.selectionMode)} |`);
    lines.push(`| motivo do roteamento | ${say(invocation.selectionReason)} |`);
    lines.push(`| executável | ${say(invocation.executable)} |`);
    lines.push(`| versão do CLI | ${say(invocation.cliVersion)} |`);
    lines.push(`| pasta de trabalho | ${say(invocation.workingDirectory)} |`);
    lines.push(`| início | ${say(invocation.startedAt)} |`);
    lines.push(`| fim | ${say(invocation.finishedAt)} |`);
    lines.push(`| duração | ${invocation.durationMs === null ? UNKNOWN : `${invocation.durationMs} ms`} |`);
    lines.push(`| última atividade | ${say(invocation.lastActivityAt)} |`);
    lines.push(`| ferramenta em execução | ${say(invocation.currentTool)} |`);
    lines.push(`| limite de silêncio | ${invocation.idleTimeoutMs === null ? UNKNOWN : `${invocation.idleTimeoutMs} ms`} |`);
    lines.push('');
    if (invocation.stderrExcerpt) {
      lines.push('```');
      lines.push(invocation.stderrExcerpt);
      lines.push('```');
      lines.push('');
    } else {
      lines.push(`_stderr: ${UNKNOWN}_`);
      lines.push('');
    }
  }

  // Where the time went, largest first. This section is the answer to "por que
  // uma tarefa pequena demora tanto?" - and it is measurement, not a theory:
  // each number is the wall clock between two recorded steps.
  lines.push('## Onde o tempo foi');
  lines.push('');
  const byPhase = new Map<string, { ms: number; count: number }>();
  let measured = 0;
  for (const step of detail.steps) {
    if (step.durationMs === null) continue;
    const entry = byPhase.get(step.phase) ?? { ms: 0, count: 0 };
    entry.ms += step.durationMs;
    entry.count += 1;
    byPhase.set(step.phase, entry);
    measured += step.durationMs;
  }
  if (byPhase.size === 0) {
    lines.push(`_Sem medição: esta execução é anterior à contagem por etapa._`);
  } else {
    lines.push('| fase | tempo | vezes | % do medido |');
    lines.push('|---|---|---|---|');
    const rows = [...byPhase.entries()].sort((a, b) => b[1].ms - a[1].ms);
    for (const [phase, entry] of rows) {
      const share = measured > 0 ? Math.round((entry.ms / measured) * 100) : 0;
      lines.push(`| ${phase} | ${formatMs(entry.ms)} | ${entry.count} | ${share}% |`);
    }
    lines.push(`| **total medido** | **${formatMs(measured)}** | | |`);
  }
  lines.push('');

  lines.push('## Etapas');
  lines.push('');
  for (const step of detail.steps) {
    const took = step.durationMs === null ? '' : ` _(${formatMs(step.durationMs)})_`;
    lines.push(
      `- **it. ${step.iteration} · ${step.phase} · ${step.status}**${took} — ${say(step.summary)}`,
    );
    if (step.detail) {
      lines.push('  ```');
      for (const line of step.detail.split('\n')) lines.push(`  ${line}`);
      lines.push('  ```');
    }
  }
  lines.push('');

  // The authorisations this run asked for. In the export because the run this
  // work exists for is one somebody would export: "which tool was refused, and
  // what did I answer" is the question, and it must not need the app open.
  lines.push('## Autorizações');
  lines.push('');
  if (permissions.length === 0) {
    lines.push('_Nenhuma autorização foi pedida nesta execução._');
  } else {
    lines.push('| estado | ferramenta | comando | escopo autorizado |');
    lines.push('|---|---|---|---|');
    for (const request of permissions) {
      lines.push(
        `| ${request.status} | ${say(request.toolName)} | ${say(request.command)} | ` +
          `${say(request.approvedRule)} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Verificações');
  lines.push('');
  if (detail.verifications.length === 0) lines.push('_Nenhuma verificação foi executada._');
  for (const verification of detail.verifications) {
    lines.push(`- it. ${verification.iteration} · ${verification.passed ? 'PASS' : 'FAIL'} · ` +
      `\`${say(verification.command)}\` · saída ${say(verification.exitCode)}`);
  }
  lines.push('');

  lines.push('## Sessões do provider');
  lines.push('');
  if (detail.providerSessions.length === 0) lines.push('_Nenhuma sessão registrada._');
  for (const session of detail.providerSessions) {
    lines.push(`- ${say(session.connectionName)} · ${say(session.adapterId)} · ` +
      `\`${say(session.providerSessionId)}\` · ${say(session.workingDirectory)}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('Nada neste arquivo é credencial, token ou prompt completo. Os campos');
  lines.push('passaram pelo redator de segredos do aplicativo. Um campo que a');
  lines.push(`ferramenta não informou aparece como "${UNKNOWN}", nunca inventado.`);

  // Once more over the whole document. The fields were redacted on the way
  // into the database; this catches anything a future field forgets to.
  return redact(lines.join('\n'));
}

/**
 * Writes the report and says where it went.
 *
 * Into the application's own artifacts folder, which it already owns and
 * already creates — no folder picker, and nothing for the person to choose
 * before they can see why their run failed.
 */
export function writeDiagnostics(
  detail: RunDetailView,
  artifactsRoot: string,
  now = new Date(),
  permissions: readonly PermissionRequestView[] = [],
): { path: string; directory: string } {
  const directory = join(artifactsRoot, 'diagnostics');
  mkdirSync(directory, { recursive: true });
  // The run id is generated by this application and is safe in a filename;
  // the timestamp keeps two exports of the same run apart.
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const path = join(directory, `diagnostico-${detail.run.id}-${stamp}.md`);
  writeFileSync(path, renderDiagnostics(detail, now, permissions), 'utf8');
  return { path, directory };
}

/** Milliseconds as something a person reads: `1,4 s`, `2 min 06 s`, `840 ms`. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
}
