/**
 * Price table, used only to *estimate* what a metered invocation cost.
 *
 * Three rules, because a wrong number here is worse than no number:
 *
 *  1. A model this table does not know returns `null`, not zero and not a
 *     guess. The interface renders a null as "custo não informado", never as
 *     "free".
 *  2. A price the provider itself reports (the Claude Code CLI's
 *     `total_cost_usd`, for one) wins over this table.
 *  3. A local estimate is never presented as a guaranteed ceiling. Only the
 *     provider can enforce a spending limit; this table can only tell a person
 *     what has probably been spent so far. `docs/API_COST_CONTROLS.md` says so
 *     in the same words the interface uses.
 *
 * Prices are US dollars per million tokens, from each vendor's public pricing
 * page, and they go stale: that is why every figure reaches the person labelled
 * as an estimate with the date this table was last checked.
 */

export const PRICING_CHECKED_AT = '2026-09-07';

export interface ModelPrice {
  /** US dollars per million input tokens. */
  readonly inputPerMillion: number;
  /** US dollars per million output tokens. */
  readonly outputPerMillion: number;
}

/**
 * Keys are matched as a **prefix** of the model id, longest first, so a dated
 * snapshot (`claude-opus-5-20260401`) is priced by its family without this
 * table having to list every snapshot a vendor ever publishes.
 */
const PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic
  'claude-fable-5': { inputPerMillion: 10, outputPerMillion: 50 },
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-8': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-7': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-6': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
};

/** The price for a model id, or null when this table does not know it. */
export function priceOf(modelId: string | null | undefined): ModelPrice | null {
  if (!modelId) return null;
  const id = modelId.trim().toLowerCase();
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(PRICES)) {
    if (!id.startsWith(key)) continue;
    if (!best || key.length > best.key.length) best = { key, price };
  }
  return best?.price ?? null;
}

/**
 * Estimated dollars for a number of tokens, or null when the model is unknown.
 *
 * Cached input tokens are billed at a fraction of the input rate by both
 * vendors; rather than encode a second uncertain number, they are charged here
 * at the full input rate. The estimate therefore errs *high*, which is the
 * safe direction for a budget warning.
 */
export function estimateCostUsd(
  modelId: string | null | undefined,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const price = priceOf(modelId);
  if (!price) return null;
  if (inputTokens === null && outputTokens === null) return null;
  const input = ((inputTokens ?? 0) / 1_000_000) * price.inputPerMillion;
  const output = ((outputTokens ?? 0) / 1_000_000) * price.outputPerMillion;
  return round(input + output);
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
