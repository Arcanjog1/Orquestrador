import { createHash } from 'node:crypto';

/** Sets of facts: repeating a read, test, invocation or timestamp is not progress. */
export function progressFingerprint(value: unknown): string {
  function stable(v: unknown): unknown {
    // Hashes, case-sensitive paths and measured output are byte facts.
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      const rows=[...new Set(v.map(x=>JSON.stringify(stable(x))))];
      return v.every(x=>x && typeof x==='object') ? rows.sort() : rows;
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v)
      .filter(([k])=>!['id','timestamp','checkedAt','collectedAt','lastUpdatedIteration','startedAt','finishedAt','durationMs','iteration','taskId'].includes(k))
      .sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** Refuse equivalent work against equivalent context BEFORE paying for a worker. */
export class DelegationProgressGuard {
  private readonly seen = new Set<string>();
  admit(mission: unknown, context: unknown): boolean {
    // Instructions can contain case-sensitive paths, operators and exact bytes.
    // Presentation-level answer equivalence is unsafe for executable missions.
    const key=progressFingerprint({mission,context});
    if(this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}
