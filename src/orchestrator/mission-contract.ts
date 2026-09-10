import { createHash } from 'node:crypto';
import type { Decision } from '../core/types.js';
import type { FileCheckRequest } from '../verification/file-check.js';
import { classifyObjective, normalizeObjective } from './objective-intent.js';

export interface ExactLiteral {
  readonly path: string;
  readonly expectedContent: string;
  readonly expectedBytes: string;
  readonly expectedByteLength: number;
  readonly expectedHash: string;
  readonly trailingNewline: boolean;
  readonly trailingNewlinePolicy: 'required' | 'forbidden';
}
export interface MissionContract {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly exactLiterals: readonly ExactLiteral[];
  readonly filePaths: readonly string[];
}

/** Parse only delimited literal instructions. Ambiguous prose stays with the
 * planner; it must never become invented expected bytes. Framing newlines are
 * stripped only under an explicit no-final-newline instruction. */
export function createMissionContract(objective: string): MissionContract {
  const paths = classifyObjective(objective).targets;
  const noNewline = /\b(?:sem|without|no)\s+(?:uma?\s+)?(?:newline|new\s*line|quebra de linha)(?:\s+(?:extra|adicional))?(?:\s+(?:no\s+)?final)?/i.test(normalizeObjective(objective));
  const marker = /(?:conte[uú]do\s+exato|exact\s+content|contendo\s+exatamente|containing\s+exactly)\s*:\s*/i.exec(objective);
  let content: string | undefined;
  if (marker && paths.length === 1) {
    const tail = objective.slice(marker.index + marker[0].length);
    const fenced = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/.exec(tail);
    const quoted = /^`([^`]+)`|^"([^"\r\n]*)"/.exec(tail);
    if (fenced) content = fenced[1];
    else if (quoted) content = quoted[1] ?? quoted[2];
    else if (noNewline) content = tail.split(/\r?\n[ \t]*\r?\n|\r?\n(?:SEM|sem|without|Without|No)\b/)[0];
  }
  if (content !== undefined && noNewline) content = content.replace(/(?:\r?\n)+$/, '');
  const exactLiterals: ExactLiteral[] = content === undefined ? [] : [literal(paths[0]!, content)];
  return Object.freeze({ objective, acceptanceCriteria: Object.freeze(exactLiterals.map(l => `Exact bytes: ${l.path} (${l.expectedByteLength} bytes, sha256 ${l.expectedHash})`)),
    exactLiterals: Object.freeze(exactLiterals), filePaths: Object.freeze([...paths]) });
}

function literal(path: string, expectedContent: string): ExactLiteral {
  const bytes = Buffer.from(expectedContent, 'utf8');
  const trailingNewline = expectedContent.endsWith('\n');
  return Object.freeze({ path, expectedContent, expectedBytes: bytes.toString('hex'), expectedByteLength: bytes.length,
    expectedHash: createHash('sha256').update(bytes).digest('hex'), trailingNewline,
    trailingNewlinePolicy: trailingNewline ? 'required' : 'forbidden' });
}

export function contractChecks(contract: MissionContract): FileCheckRequest[] {
  return contract.exactLiterals.map((l, i) => ({path: l.path, expectText: l.expectedContent,
    expectSizeBytes: l.expectedByteLength, forbidTrailingNewline: !l.trailingNewline,
    criteria: [contract.acceptanceCriteria[i]!] }));
}

/** Pin the first check per path as well as the user-owned bytes. Later model
 * decisions may add criteria, never rewrite an existing expectation. */
export function preserveChecks(requests: readonly FileCheckRequest[], pinned: Map<string, FileCheckRequest>): FileCheckRequest[] {
  return requests.map(request => {
    const original = pinned.get(request.path);
    const criteria = [...new Set([...(original?.criteria ?? []), ...(request.criteria ?? [])])];
    const check = Object.freeze({ ...(original ?? request), criteria: Object.freeze(criteria) });
    pinned.set(request.path, check);
    return check;
  });
}

export function preserveDecision(decision: Decision, contract: MissionContract, pinned: Map<string, FileCheckRequest>): Decision {
  const requested = [...decision.fileChecks];
  if (decision.action !== 'delegate') for (const check of pinned.values()) if (!requested.some(r => r.path === check.path)) requested.push(check);
  for (const check of contractChecks(contract)) if (!requested.some(r => r.path === check.path)) requested.push(check);
  const fileChecks = preserveChecks(requested, pinned);
  const task = (value: string) => contract.exactLiterals.length
    ? `Execute a especificação canônica abaixo. A expectativa de bytes é imutável em toda tentativa.\n${JSON.stringify(contract)}\nNão reconstrua o literal a partir de paráfrases.`
    : `${value}\n\nOBJETIVO ORIGINAL (imutável):\n${contract.objective}\nEXPECTATIVAS FIXADAS:\n${JSON.stringify([...pinned.values()])}`;
  return {...decision, fileChecks, acceptanceCriteria: [...new Set([...decision.acceptanceCriteria, ...contract.acceptanceCriteria])],
    ...(decision.action === 'delegate' ? {task: task(decision.task ?? contract.objective)} : {}),
    ...(decision.delegations ? {delegations: decision.delegations.map(d => ({...d, task: task(d.task)}))} : {})};
}
