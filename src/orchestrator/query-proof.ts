import type { FileReadResult } from "../verification/file-check.js";
import { classifyObjective, type ObjectiveIntent, type ReadProofKind } from './objective-intent.js';

/** Only application-collected facts enter this registry; never parsed from an
 * agent's output. Each fact is tied to a repository snapshot. */
export interface QueryEvidence {
  kind: Exclude<ReadProofKind, 'FILE_CONTENT'>;
  repository: string;
  commit: string;
  branch: string;
  paths?: readonly string[];
  complete?: boolean;
  commits?: readonly {sha:string;message:string}[];
  detail?: string;
}

export interface QueryProof {
  criteria: string[];
  citations: { path: string; quote: string }[];
}

/** Conservative classification: mixed requests retain the code-change gate. */
export function isReadOnlyObjective(objective: string): boolean {
  return classifyObjective(objective).kind === 'READ_ONLY_QUERY';
}

/** Proves grounding, not functional correctness. Code objectives never qualify. */
export function queryProofProblems(
  objective: string,
  answer: string,
  proof: QueryProof,
  reads: readonly FileReadResult[],
  evidence: readonly QueryEvidence[] = [],
): string[] {
  if (!isReadOnlyObjective(objective))
    return ["Objective is not an exclusively read-only query."];
  return readProofProblems(classifyObjective(objective), answer, proof, reads, evidence);
}

/** Mixed objectives retain all their read obligations as well as changes/tests. */
export function readProofProblems(intent: ObjectiveIntent, answer: string, proof: QueryProof | undefined, reads: readonly FileReadResult[], evidence: readonly QueryEvidence[]): string[] {
  const problems: string[] = [];
  if (!answer.trim()) problems.push('A final answer is required.');
  for(const kind of intent.readProofs) {
    if(kind==='FILE_CONTENT') {
      if(!proof?.citations.length)problems.push('FILE_CONTENT requires byte-grounded citations from delivered fileReads.');
      continue;
    }
    const facts=evidence.filter(e=>e.kind===kind&&e.repository&&e.branch&&e.commit);
    if(kind==='FILE_EXISTENCE') {
      if(!intent.targets.length)problems.push('FILE_EXISTENCE requires the file path being queried.');
      for(const target of intent.targets)if(!facts.some(e=>e.paths?.some(p=>p.toLowerCase()===target.toLowerCase()||p.toLowerCase()===target.toLowerCase()+'.md')||e.complete))problems.push('File existence was not measured: '+target);
    } else if(!facts.length || (kind==='REPOSITORY_TREE'&&!facts.some(e=>e.complete)) || (kind==='COMMIT'&&!facts.some(e=>e.commits?.length)))problems.push('Missing independent proof: '+kind);
  }
  for (const citation of proof?.citations ?? []) {
    const read = [...reads]
      .reverse()
      .find((r) => r.request.path === citation.path);
    if (
      !read?.ok ||
      read.text === null ||
      !citation.quote.trim() ||
      !read.text.includes(citation.quote)
    ) {
      problems.push(
        `Citation not present in delivered bytes: ${citation.path}`,
      );
    }
    if (!answer.includes(citation.path))
      problems.push(`Answer does not cite ${citation.path}.`);
  }
  if(intent.readProofs.includes('FILE_CONTENT'))for(const target of intent.targets) {
    if(!proof?.citations.some(c=>c.path.toLowerCase()===target.toLowerCase()||c.path.toLowerCase()===target.toLowerCase()+'.md'))problems.push('Requested file has no grounded citation: '+target);
  }
  return problems;
}
