/**
 * The model catalogue: what this application knows exists.
 *
 * This is *knowledge about models*, not *entitlement of an account*. A model
 * listed here has an id, a name and a tier; whether a given account may use it
 * is a completely separate question, answered only by
 * `account-model-verifier.ts` and only for one account at a time.
 *
 * Keeping the two apart is what makes the honest middle state possible: the
 * catalogue can say "this is a real model" while the account status still says
 * "ainda não verificado nesta conta".
 */

import type { ProviderId } from '../accounts/account-types.js';

/**
 * Capability tier, used by the ceilings policy.
 *
 * Ordered: a ceiling of `balanced` admits `balanced` and `light`.
 */
export type ModelTier = 'light' | 'balanced' | 'frontier';

export const TIER_ORDER: Record<ModelTier, number> = {
  light: 0,
  balanced: 1,
  frontier: 2,
};

export interface CatalogModel {
  /** The id passed to the CLI, e.g. `claude-opus-5`. */
  id: string;
  providerId: ProviderId;
  displayName: string;
  tier: ModelTier;
  /**
   * Short names the CLI also accepts, e.g. `opus`. Recorded so a model chosen
   * as "opus" is recognised as the same catalogue entry.
   */
  aliases: string[];
  /** Set when the model is no longer offered. The only catalogue-level denial. */
  retired?: boolean;
  note?: string;
}

/**
 * Models this application recognises.
 *
 * The list is deliberately small and explicit. An id that is not here is not
 * treated as wrong - it is reported as being outside the catalogue, which is a
 * statement about *us*, not about the account.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: 'claude-opus-5',
    providerId: 'anthropic',
    displayName: 'Claude Opus 5',
    tier: 'frontier',
    aliases: ['opus'],
  },
  {
    id: 'claude-sonnet-5',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 5',
    tier: 'balanced',
    aliases: ['sonnet'],
  },
  {
    id: 'claude-haiku-4-5',
    providerId: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    tier: 'light',
    aliases: ['haiku'],
  },
];

const BY_KEY = new Map<string, CatalogModel>();
for (const model of MODEL_CATALOG) {
  BY_KEY.set(model.id.toLowerCase(), model);
  for (const alias of model.aliases) BY_KEY.set(alias.toLowerCase(), model);
}

/** Looks a model up by id or alias. `null` means "we do not know it". */
export function findModel(idOrAlias: string): CatalogModel | null {
  return BY_KEY.get(idOrAlias.trim().toLowerCase()) ?? null;
}

/** Resolves an alias to its canonical id, leaving unknown ids untouched. */
export function canonicalModelId(idOrAlias: string): string {
  return findModel(idOrAlias)?.id ?? idOrAlias.trim();
}

/** True when two ids - possibly aliases - name the same model. */
export function sameModel(a: string, b: string): boolean {
  return canonicalModelId(a).toLowerCase() === canonicalModelId(b).toLowerCase();
}

/** The catalogue for one provider, retired entries included. */
export function catalogFor(providerId: ProviderId): CatalogModel[] {
  return MODEL_CATALOG.filter((model) => model.providerId === providerId);
}

/** The display name to show for an id we may or may not know. */
export function modelDisplayName(idOrAlias: string): string {
  return findModel(idOrAlias)?.displayName ?? idOrAlias;
}
