/**
 * What the worker proposes, and what the application will actually do.
 *
 * ## The distinction this file exists to keep
 *
 * Without a checkout the worker cannot write a file. It can only *say* what
 * the file should become - and a sentence describing an edit is not an edit.
 * The failure this guards against is the oldest one in the product: a model
 * narrates a change, the narration is mistaken for the change, and the run
 * reports success over a repository nothing touched.
 *
 * So the worker's answer is parsed into a **proposal**, the proposal is
 * validated against the commit the worker was actually shown, and only then
 * does the application - never the model - perform documented API operations.
 * Anything that does not parse is not a change, and is reported as "the worker
 * described something; nothing was applied".
 *
 * ## The rules that do not bend
 *
 * - **Data only.** A proposal carries paths and contents. There is no command
 *   field, no script field, and nothing here is ever executed. A key this
 *   contract does not define is a refusal, not something to ignore.
 * - **The base commit must match.** A proposal written against a commit that
 *   is no longer the one in hand is refused, because "apply this to whatever
 *   is there now" is how one run silently overwrites another.
 * - **One proposal per answer.** Two blocks is an ambiguity, and picking one
 *   would be guessing which edit the person wanted.
 * - **A path is checked before it is trusted**, by the same rule the write
 *   layer uses, so a proposal cannot reach outside the repository.
 */

import { pathProblem, type RepositoryChange } from './repository-operations.js';

/** The fence the worker is asked to use. Deliberately not `json`. */
export const PROPOSAL_FENCE = 'orquestrador-changes';

export interface ChangeProposal {
  /** The commit the worker says it wrote against. */
  readonly baseCommit: string;
  readonly message: string;
  readonly changes: readonly RepositoryChange[];
}

export type ProposalResult =
  /** No block at all. The worker answered without proposing an edit. */
  | { readonly kind: 'none' }
  | { readonly kind: 'proposal'; readonly proposal: ChangeProposal }
  /** A block was there and could not be used. The reason is for the worker. */
  | { readonly kind: 'invalid'; readonly problem: string };

/** How many changes one answer may carry, before it is a checkout's job. */
const MAX_CHANGES = 100;
/** The whole block, so a runaway answer cannot become a memory problem. */
const MAX_BLOCK_BYTES = 2 * 1024 * 1024;

const ALLOWED_TOP_LEVEL = new Set(['baseCommit', 'message', 'changes']);
const ALLOWED_CHANGE_KEYS = new Set(['op', 'path', 'text', 'base64', 'executable']);

/**
 * Reads the worker's answer for a change proposal.
 *
 * `expectedBaseCommit` is the commit the application showed the worker. It is
 * compared, not trusted: the worker echoes it back, and a mismatch means the
 * proposal was written against a different state of the repository.
 */
export function readChangeProposal(answer: string, expectedBaseCommit: string): ProposalResult {
  const blocks = findBlocks(answer);
  if (blocks.length === 0) return { kind: 'none' };
  if (blocks.length > 1) {
    return {
      kind: 'invalid',
      problem:
        `A resposta trouxe ${blocks.length} blocos \`${PROPOSAL_FENCE}\`. Envie um só: escolher ` +
        'entre dois seria adivinhar qual alteração era a boa. Nada foi aplicado.',
    };
  }
  const raw = blocks[0]!;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BLOCK_BYTES) {
    return {
      kind: 'invalid',
      problem: `O bloco de alterações passou de ${MAX_BLOCK_BYTES} bytes. Divida a tarefa. Nada foi aplicado.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: 'invalid',
      problem:
        `O bloco \`${PROPOSAL_FENCE}\` não é JSON válido (${(error as Error).message}). ` +
        'Nada foi aplicado.',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', problem: 'O bloco de alterações precisa ser um objeto JSON. Nada foi aplicado.' };
  }

  const row = parsed as Record<string, unknown>;
  const unknown = Object.keys(row).filter((key) => !ALLOWED_TOP_LEVEL.has(key));
  if (unknown.length > 0) {
    // Refused rather than ignored: a field this contract does not define is
    // either a misunderstanding or an attempt to widen it, and both deserve
    // an answer instead of silence.
    return {
      kind: 'invalid',
      problem:
        `O bloco de alterações trouxe campos que este contrato não define: ${unknown.join(', ')}. ` +
        `Use apenas ${[...ALLOWED_TOP_LEVEL].join(', ')}. Nada foi aplicado.`,
    };
  }

  const baseCommit = typeof row.baseCommit === 'string' ? row.baseCommit.trim() : '';
  if (baseCommit.length === 0) {
    return {
      kind: 'invalid',
      problem: 'O bloco de alterações não trouxe "baseCommit". Nada foi aplicado.',
    };
  }
  if (!sameCommit(baseCommit, expectedBaseCommit)) {
    return {
      kind: 'invalid',
      problem:
        `A alteração foi escrita contra ${baseCommit.slice(0, 12)}, e o commit em mãos é ` +
        `${expectedBaseCommit.slice(0, 12)}. Releia os arquivos neste commit e proponha de novo. ` +
        'Nada foi aplicado.',
    };
  }

  const message = typeof row.message === 'string' ? row.message.trim() : '';
  if (message.length === 0) {
    return {
      kind: 'invalid',
      problem: 'O bloco de alterações não trouxe uma mensagem de commit. Nada foi aplicado.',
    };
  }

  if (!Array.isArray(row.changes) || row.changes.length === 0) {
    return {
      kind: 'invalid',
      problem:
        'O bloco de alterações não trouxe nenhuma alteração. Se não havia o que mudar, diga isso ' +
        'no texto e não envie o bloco.',
    };
  }
  if (row.changes.length > MAX_CHANGES) {
    return {
      kind: 'invalid',
      problem: `São ${row.changes.length} alterações, e o limite é ${MAX_CHANGES}. Nada foi aplicado.`,
    };
  }

  const changes: RepositoryChange[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of row.changes.entries()) {
    const problem = readChange(entry, index, seen);
    if (typeof problem === 'string') return { kind: 'invalid', problem: `${problem} Nada foi aplicado.` };
    changes.push(problem);
  }

  return {
    kind: 'proposal',
    proposal: { baseCommit: expectedBaseCommit, message: message.slice(0, 500), changes },
  };
}

/** One change, or the sentence explaining why it is not one. */
function readChange(entry: unknown, index: number, seen: Set<string>): RepositoryChange | string {
  const where = `A alteração ${index + 1}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${where} não é um objeto.`;
  }
  const row = entry as Record<string, unknown>;
  const unknown = Object.keys(row).filter((key) => !ALLOWED_CHANGE_KEYS.has(key));
  if (unknown.length > 0) {
    return `${where} trouxe campos que este contrato não define: ${unknown.join(', ')}.`;
  }
  const op = row.op;
  if (op !== 'write' && op !== 'delete') {
    return `${where} pede a operação "${String(op)}", que não existe. Use "write" ou "delete".`;
  }
  if (typeof row.path !== 'string') return `${where} não trouxe um caminho.`;
  const bad = pathProblem(row.path);
  if (bad) return `${where}: ${bad}`;
  if (seen.has(row.path)) return `${where} repete o caminho "${row.path}".`;
  seen.add(row.path);

  if (op === 'delete') {
    if (row.text !== undefined || row.base64 !== undefined) {
      return `${where} remove "${row.path}" e ainda envia conteúdo. Uma das duas coisas está errada.`;
    }
    return { op: 'delete', path: row.path };
  }

  const hasText = typeof row.text === 'string';
  const hasBase64 = typeof row.base64 === 'string';
  if (hasText && hasBase64) return `${where} trouxe "text" e "base64" ao mesmo tempo.`;
  if (!hasText && !hasBase64) {
    return (
      `${where} não trouxe conteúdo. Para esvaziar um arquivo, envie "text": ""; para removê-lo, ` +
      'use a operação "delete".'
    );
  }
  if (hasBase64 && !isBase64(row.base64 as string)) {
    return `${where} enviou "base64" que não é base64 válido.`;
  }
  if (row.executable !== undefined && typeof row.executable !== 'boolean') {
    return `${where} enviou "executable" que não é booleano.`;
  }
  return {
    op: 'write',
    path: row.path,
    ...(hasText ? { text: row.text as string } : { base64: row.base64 as string }),
    ...(row.executable === true ? { executable: true } : {}),
  };
}

/**
 * Every fenced proposal block in an answer.
 *
 * Written as a scan rather than one regular expression because a worker's
 * answer can contain a code block *about* the change as well as the change,
 * and a greedy match across both would silently join them.
 */
function findBlocks(answer: string): string[] {
  const blocks: string[] = [];
  const open = new RegExp(`^[ \\t]*\`\`\`${PROPOSAL_FENCE}[ \\t]*$`);
  const close = /^[ \t]*```[ \t]*$/;
  const lines = answer.split(/\r?\n/);
  let current: string[] | null = null;
  for (const line of lines) {
    if (current === null) {
      if (open.test(line)) current = [];
      continue;
    }
    if (close.test(line)) {
      blocks.push(current.join('\n'));
      current = null;
      continue;
    }
    current.push(line);
  }
  // An unterminated block is not a proposal: half a JSON document is not an
  // edit, and guessing where it ended is exactly the kind of repair that turns
  // a truncated answer into a wrong commit.
  return blocks;
}

/** True when two shas name the same commit, allowing an abbreviated one. */
function sameCommit(given: string, expected: string): boolean {
  const a = given.toLowerCase();
  const b = expected.toLowerCase();
  if (a === b) return true;
  // Git itself accepts an unambiguous prefix, and a worker copying from a
  // prompt often copies the short form. Seven is git's own minimum.
  return a.length >= 7 && b.startsWith(a);
}

function isBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(value)) return false;
  const compact = value.replace(/[\r\n]/g, '');
  return compact.length % 4 === 0;
}

/**
 * What the worker is told about proposing changes, in its own prompt.
 *
 * Kept beside the parser on purpose: an instruction that drifts from the thing
 * that reads it is how a contract quietly stops being one.
 */
export function proposalInstructions(input: {
  fullName: string;
  branch: string;
  commitSha: string;
}): string {
  return [
    'CHANGING FILES IN THIS PROJECT (read this before you try to edit anything):',
    `This project has no checkout on this computer. The repository is ${input.fullName}, you are`,
    `working on the branch ${input.branch}, at commit ${input.commitSha}.`,
    'You cannot write files here, and you must not say that you did. Instead, propose the change',
    'and the application will perform it through the GitHub API and verify the result itself.',
    '',
    `Put the proposal in ONE fenced block marked \`${PROPOSAL_FENCE}\`, containing only JSON:`,
    '',
    '```' + PROPOSAL_FENCE,
    '{',
    `  "baseCommit": "${input.commitSha}",`,
    '  "message": "uma linha dizendo o que muda",',
    '  "changes": [',
    '    { "op": "write",  "path": "caminho/relativo.md", "text": "o conteúdo COMPLETO do arquivo" },',
    '    { "op": "delete", "path": "outro/arquivo.txt" }',
    '  ]',
    '}',
    '```',
    '',
    'Rules, all of them enforced by the application:',
    '- "text" is the WHOLE new content of the file, not a patch and not an excerpt.',
    '- A file that is not text goes in "base64" instead of "text".',
    '- Paths are relative to the repository root. No "..", no absolute paths, no backslashes.',
    '- "baseCommit" must be the commit above. If you worked from anything else, say so instead.',
    '- One block per answer. There is no command field and nothing is executed.',
    '- If nothing needs changing, send no block and say so in your answer.',
    'Explain your reasoning in normal text outside the block; the block is read by a program.',
  ].join('\n');
}
