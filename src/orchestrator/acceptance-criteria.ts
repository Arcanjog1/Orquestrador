/**
 * The acceptance criteria ledger (spec 10, 15).
 *
 * Criteria accumulate across the whole run: once the orchestrator agent has
 * stated one, it stays on the books until evidence settles it. The DONE gate
 * reads this ledger, which is why a criterion is never silently dropped.
 */

import { createHash } from 'node:crypto';
import type { AcceptanceCriterion } from '../core/types.js';

/** Stable id so the same criterion text collapses across iterations. */
export function criterionId(text: string): string {
  return createHash('sha1').update(normaliseText(text)).digest('hex').slice(0, 12);
}

function normaliseText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class AcceptanceCriteriaLedger {
  private readonly criteria = new Map<string, AcceptanceCriterion>();

  constructor(existing: readonly AcceptanceCriterion[] = []) {
    for (const c of existing) this.criteria.set(c.id, { ...c });
  }

  /** Adds criteria that are not already tracked. Existing status is preserved. */
  add(texts: readonly string[], iteration: number): void {
    for (const text of texts) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      const id = criterionId(trimmed);
      if (this.criteria.has(id)) continue;
      this.criteria.set(id, {
        id,
        text: trimmed,
        status: 'unknown',
        lastUpdatedIteration: iteration,
      });
    }
  }

  /** Records a verdict for one criterion. Unknown ids are ignored. */
  mark(id: string, status: AcceptanceCriterion['status'], iteration: number, note?: string): void {
    const existing = this.criteria.get(id);
    if (!existing) return;
    existing.status = status;
    existing.lastUpdatedIteration = iteration;
    if (note !== undefined) existing.note = note;
  }

  /** Records a verdict by criterion text (what the agent actually sends back). */
  markByText(
    text: string,
    status: AcceptanceCriterion['status'],
    iteration: number,
    note?: string,
  ): void {
    this.mark(criterionId(text), status, iteration, note);
  }

  /**
   * Applies a whole-run verdict to every criterion that is still unknown.
   *
   * Used when independent verification passes: the criteria the orchestrator
   * attached to those commands are now backed by evidence.
   */
  markAllUnknown(status: AcceptanceCriterion['status'], iteration: number, note: string): void {
    for (const c of this.criteria.values()) {
      if (c.status === 'unknown') {
        c.status = status;
        c.lastUpdatedIteration = iteration;
        c.note = note;
      }
    }
  }

  get(id: string): AcceptanceCriterion | undefined {
    const found = this.criteria.get(id);
    return found ? { ...found } : undefined;
  }

  all(): AcceptanceCriterion[] {
    return [...this.criteria.values()].map((c) => ({ ...c }));
  }

  /**
   * True when every one of these texts is a criterion this ledger holds and
   * has settled as satisfied.
   *
   * A text the ledger does not know is **not** satisfied — an unknown
   * criterion is the case where the caller and the ledger disagree about what
   * was asked, and answering "yes" there would be the one answer that cannot
   * be checked.
   */
  allSatisfied(texts: readonly string[]): boolean {
    if (texts.length === 0) return false;
    return texts.every((text) => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      return this.criteria.get(criterionId(trimmed))?.status === 'satisfied';
    });
  }

  pending(): AcceptanceCriterion[] {
    return this.all().filter((c) => c.status !== 'satisfied');
  }

  satisfied(): AcceptanceCriterion[] {
    return this.all().filter((c) => c.status === 'satisfied');
  }

  get size(): number {
    return this.criteria.size;
  }
}
