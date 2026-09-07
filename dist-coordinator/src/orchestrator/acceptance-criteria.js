/**
 * The acceptance criteria ledger (spec 10, 15).
 *
 * Criteria accumulate across the whole run: once the orchestrator agent has
 * stated one, it stays on the books until evidence settles it. The DONE gate
 * reads this ledger, which is why a criterion is never silently dropped.
 */
import { createHash } from 'node:crypto';
/** Stable id so the same criterion text collapses across iterations. */
export function criterionId(text) {
    return createHash('sha1').update(normaliseText(text)).digest('hex').slice(0, 12);
}
function normaliseText(text) {
    return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
export class AcceptanceCriteriaLedger {
    criteria = new Map();
    constructor(existing = []) {
        for (const c of existing)
            this.criteria.set(c.id, { ...c });
    }
    /** Adds criteria that are not already tracked. Existing status is preserved. */
    add(texts, iteration) {
        for (const text of texts) {
            const trimmed = text.trim();
            if (!trimmed)
                continue;
            const id = criterionId(trimmed);
            if (this.criteria.has(id))
                continue;
            this.criteria.set(id, {
                id,
                text: trimmed,
                status: 'unknown',
                lastUpdatedIteration: iteration,
            });
        }
    }
    /** Records a verdict for one criterion. Unknown ids are ignored. */
    mark(id, status, iteration, note) {
        const existing = this.criteria.get(id);
        if (!existing)
            return;
        existing.status = status;
        existing.lastUpdatedIteration = iteration;
        if (note !== undefined)
            existing.note = note;
    }
    /** Records a verdict by criterion text (what the agent actually sends back). */
    markByText(text, status, iteration, note) {
        this.mark(criterionId(text), status, iteration, note);
    }
    /**
     * Applies a whole-run verdict to every criterion that is still unknown.
     *
     * Used when independent verification passes: the criteria the orchestrator
     * attached to those commands are now backed by evidence.
     */
    markAllUnknown(status, iteration, note) {
        for (const c of this.criteria.values()) {
            if (c.status === 'unknown') {
                c.status = status;
                c.lastUpdatedIteration = iteration;
                c.note = note;
            }
        }
    }
    get(id) {
        const found = this.criteria.get(id);
        return found ? { ...found } : undefined;
    }
    all() {
        return [...this.criteria.values()].map((c) => ({ ...c }));
    }
    pending() {
        return this.all().filter((c) => c.status !== 'satisfied');
    }
    satisfied() {
        return this.all().filter((c) => c.status === 'satisfied');
    }
    get size() {
        return this.criteria.size;
    }
}
//# sourceMappingURL=acceptance-criteria.js.map