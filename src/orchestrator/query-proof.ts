import type { FileReadResult } from '../verification/file-check.js';

export interface QueryProof {
  criteria: string[];
  citations: { path: string; quote: string }[];
}

/** Conservative classification: mixed requests retain the code-change gate. */
export function isReadOnlyObjective(objective: string): boolean {
  const text = objective.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(crie|criar|implemente|implementar|corrija|corrigir|altere|alterar|adicione|adicionar|remova|remover|modifique|conserte|build|implement|fix|change|edit|write|delete|add|create)\b/.test(text)) return false;
  return /\b(onde|quais|qual|como|explique|explicar|leia|ler|liste|listar|analise|analisar|where|which|what|explain|read|list|review|audit)\b/.test(text);
}

/** Proves grounding, not functional correctness. Code objectives never qualify. */
export function queryProofProblems(objective: string, answer: string, proof: QueryProof, reads: readonly FileReadResult[]): string[] {
  if (!isReadOnlyObjective(objective)) return ['Objective is not an exclusively read-only query.'];
  if (!answer.trim() || !proof.citations.length) return ['An answer and byte-grounded citations are required.'];
  const problems: string[] = [];
  for (const citation of proof.citations) {
    const read = [...reads].reverse().find(r => r.request.path === citation.path);
    if (!read?.ok || read.text === null || !citation.quote.trim() || !read.text.includes(citation.quote)) {
      problems.push(`Citation not present in delivered bytes: ${citation.path}`);
    }
    if (!answer.includes(citation.path)) problems.push(`Answer does not cite ${citation.path}.`);
  }
  return problems;
}
