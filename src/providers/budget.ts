/**
 * The run's spending ledger.
 *
 * What it is: a count of what this run has consumed, checked **before** each
 * invocation and updated after it, so a loop cannot quietly run up a bill.
 *
 * What it is not, and the interface says so in these words: a guarantee. This
 * process can refuse to make the next call; it cannot make a provider refuse
 * one. Only the provider's own spending controls can do that. A local limit is
 * a stop button on this loop, not a ceiling on an account.
 *
 * Two rules the ledger enforces that are easy to get wrong:
 *
 *  - A **subscription** invocation is not charged against a dollar budget. It
 *    has no dollar cost to charge, and pretending otherwise would make the
 *    conversation mode look expensive and push a person toward the paid path.
 *    Invocation and token limits still apply to it.
 *  - An invocation whose cost could not be estimated is counted as an
 *    invocation and as its tokens, and is **flagged**, so a run of unpriced
 *    models does not silently look like a run that cost nothing.
 */

import type { InvocationUsage } from '../core/types.js';

export interface BudgetLimits {
  /** Hard stop on how many provider calls one run may make. */
  maxInvocations?: number | null;
  /** Hard stop on total tokens across the run, when providers report them. */
  maxTokens?: number | null;
  /** Hard stop on estimated metered dollars. Subscription calls do not count. */
  maxCostUsd?: number | null;
  /** Fraction of a limit at which the person is warned once. Default 0.8. */
  warnAt?: number;
}

export interface BudgetTotals {
  invocations: number;
  tokens: number;
  costUsd: number;
  /** Metered invocations whose cost this build could not estimate. */
  unpricedInvocations: number;
}

export type BudgetVerdict =
  | { allowed: true; warning: string | null }
  | { allowed: false; reason: string };

const DEFAULT_WARN_AT = 0.8;

export class BudgetLedger {
  private totals: BudgetTotals = {
    invocations: 0,
    tokens: 0,
    costUsd: 0,
    unpricedInvocations: 0,
  };
  private warned = new Set<string>();

  constructor(private readonly limits: BudgetLimits = {}) {}

  get snapshot(): Readonly<BudgetTotals> {
    return { ...this.totals };
  }

  /** True when nothing was configured: the ledger only counts, never blocks. */
  get unlimited(): boolean {
    return (
      !positive(this.limits.maxInvocations) &&
      !positive(this.limits.maxTokens) &&
      !positive(this.limits.maxCostUsd)
    );
  }

  /**
   * Asked before every invocation.
   *
   * Refusing here is the whole point: once a call is made the money is spent,
   * so the check that matters is the one that happens first.
   */
  check(): BudgetVerdict {
    const { maxInvocations, maxTokens, maxCostUsd } = this.limits;
    if (positive(maxInvocations) && this.totals.invocations >= maxInvocations) {
      return {
        allowed: false,
        reason:
          `Limite de ${maxInvocations} chamadas por execução atingido. ` +
          'Nenhuma nova chamada foi feita.',
      };
    }
    if (positive(maxTokens) && this.totals.tokens >= maxTokens) {
      return {
        allowed: false,
        reason:
          `Limite de ${formatInt(maxTokens)} tokens por execução atingido ` +
          `(${formatInt(this.totals.tokens)} consumidos). Nenhuma nova chamada foi feita.`,
      };
    }
    if (positive(maxCostUsd) && this.totals.costUsd >= maxCostUsd) {
      return {
        allowed: false,
        reason:
          `Limite de ${formatUsd(maxCostUsd)} por execução atingido ` +
          `(${formatUsd(this.totals.costUsd)} estimados). Nenhuma nova chamada foi feita. ` +
          'Este limite interrompe o aplicativo; ele não é um teto cobrado pelo provider.',
      };
    }
    return { allowed: true, warning: this.warning() };
  }

  /** Records what an invocation consumed. Called on success and on failure. */
  record(usage: InvocationUsage | null | undefined): void {
    this.totals.invocations += 1;
    if (!usage) return;
    const tokens =
      usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || null);
    if (tokens !== null) this.totals.tokens += tokens;
    if (usage.billing !== 'api-metered') return;
    if (usage.costUsd === null) {
      this.totals.unpricedInvocations += 1;
      return;
    }
    this.totals.costUsd = round(this.totals.costUsd + usage.costUsd);
  }

  /**
   * One sentence for the person the first time a limit is close, and never
   * again for that same limit: a warning repeated every iteration is noise
   * that gets ignored, which is the opposite of what a budget alert is for.
   */
  private warning(): string | null {
    const at = this.limits.warnAt ?? DEFAULT_WARN_AT;
    const checks: Array<[string, number | null | undefined, number, string]> = [
      ['invocations', this.limits.maxInvocations, this.totals.invocations, 'chamadas'],
      ['tokens', this.limits.maxTokens, this.totals.tokens, 'tokens'],
      ['cost', this.limits.maxCostUsd, this.totals.costUsd, 'gasto estimado'],
    ];
    for (const [key, limit, used, label] of checks) {
      if (!positive(limit) || this.warned.has(key)) continue;
      if (used < limit * at) continue;
      this.warned.add(key);
      const usedText = key === 'cost' ? formatUsd(used) : formatInt(used);
      const limitText = key === 'cost' ? formatUsd(limit) : formatInt(limit);
      return `Orçamento desta execução: ${usedText} de ${limitText} em ${label}.`;
    }
    return null;
  }

  /** What the run's summary shows. Null fields stay null, never zero. */
  describe(): string {
    const parts = [`${this.totals.invocations} chamada(s)`];
    if (this.totals.tokens > 0) parts.push(`${formatInt(this.totals.tokens)} tokens`);
    if (this.totals.costUsd > 0) parts.push(`${formatUsd(this.totals.costUsd)} estimados`);
    if (this.totals.unpricedInvocations > 0) {
      parts.push(`${this.totals.unpricedInvocations} sem preço conhecido`);
    }
    return parts.join(', ');
  }
}

function positive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString('pt-BR');
}

function formatUsd(value: number): string {
  return `US$ ${value.toFixed(value < 1 ? 4 : 2)}`;
}
