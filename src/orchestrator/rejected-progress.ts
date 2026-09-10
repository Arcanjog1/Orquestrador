import { createHash } from 'node:crypto';
import type { DoneGateResult, GitEvidence } from '../core/types.js';
import type { FileReadResult } from '../verification/file-check.js';

export const equivalentAnswer=(answer:string)=>answer.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const unique=(items:readonly unknown[])=>[...new Set(items.map(item=>JSON.stringify(item)))].sort();
export interface RejectedRound {
  answer: string;
  evidence: GitEvidence;
  reads: readonly FileReadResult[];
  criteria: readonly {text:string;status:string}[];
  gate: DoneGateResult;
}
/** Consecutive rejected DONE proposals, including the branches that continue
 * before the ordinary delegation progress detector. Timestamps/call counts
 * and duplicate reads are not new information. */
export class RejectedProgressGuard {
  private previous: string | null = null;
  observe(round:RejectedRound):boolean {
    const e=round.evidence;
    const fingerprint=createHash('sha256').update(JSON.stringify({
      tree:[e.commit,e.statusShort,e.diff,e.changedSinceBaseline],
      reads:unique(round.reads.map(r=>[r.request.path,r.request.offsetBytes??0,r.sha256,r.ok,r.text])),
      criteria:unique(round.criteria.map(c=>[c.text,c.status])),
      rejection:unique(round.gate.failures),
      commands:unique(round.gate.verification.map(v=>[v.command,v.exitCode,v.stdout,v.stderr,v.refused??null,v.timedOut])),
      files:unique((round.gate.fileChecks??[]).map(c=>[c.request,c.passed,c.outcome,c.sha256,c.sizeBytes])),
    })).digest('hex');
    const repeated=fingerprint===this.previous;
    this.previous=fingerprint;
    return repeated;
  }
}

/** A failing executed test can be a coding failure. Missing/refused proof,
 * context or executor cannot be fixed by increasing the model tier. */
export function mechanicalGateFailure(gate:DoneGateResult):boolean {
  if(gate.verification.some(v=>!v.refused&&!v.timedOut&&v.exitCode!==null&&v.exitCode!==0))return false;
  if(gate.fileChecks?.some(c=>!c.passed&&!['outside-workspace','read-error','invalid-request','too-large'].includes(c.outcome)))return false;
  return !gate.passed;
}

export function publicGateAnswer(answer:string):string {
  if(!answer.includes('--allow-no-changes'))return answer;
  return 'A resposta ainda precisa de uma validação compatível com o objetivo. O aplicativo deve verificar a evidência necessária.';
}
