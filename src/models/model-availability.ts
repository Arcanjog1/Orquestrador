/**
 * Turning one account's verification record into what the interface shows.
 *
 * Everything here is pure: a record in, a status out. The rules it encodes are
 * the ones the interface was getting wrong.
 *
 *  - Not having checked is not a warning. `KNOWN_BUT_UNVERIFIED` renders as an
 *    ordinary line - "Disponível no catálogo — ainda não verificado nesta
 *    conta" - with tone `neutral`, and the model stays usable.
 *  - `UNAVAILABLE` is only ever reached from evidence: a complete entitlement
 *    listing that omits the model, a listing that names it as unavailable, a
 *    refusal on an authorised minimal call, or a retirement in the catalogue.
 *  - Evidence is per account. Passing account A's record while asking about
 *    account B throws rather than answering, because a quiet wrong answer here
 *    is exactly the bug this module exists to prevent.
 *  - A confirmation ages into "worth refreshing", never into a problem. A
 *    denial ages into "unverified", because entitlements get added and holding
 *    a stale denial would keep a model the user now has locked out.
 */

import {
  CONNECT_ACCOUNT,
  INSTALL_RUNTIME,
  VERIFY_ACCOUNT_MODELS,
  VERIFY_WITH_MINIMAL_CALL,
  type AccountModelVerification,
  type AvailabilityEvidence,
  type ModelAction,
  type ModelStatus,
  type StatusTone,
  type UnverifiedReason,
} from './model-types.js';
import { canonicalModelId, findModel, modelDisplayName, MODEL_CATALOG } from './model-catalog.js';

/** After this, a confirmation is still trusted but flagged as worth refreshing. */
export const CONFIRMATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** After this, a denial is dropped: an entitlement may have been added since. */
export const DENIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The three headline labels, exactly as the interface renders them. */
export const AVAILABILITY_LABELS = {
  confirmed: 'Disponível nesta conta',
  knownButUnverified: 'Disponível no catálogo — ainda não verificado nesta conta',
  unknownButUnverified: 'Modelo personalizado — ainda não verificado nesta conta',
  unavailable: 'Indisponível nesta conta',
} as const;

const UNVERIFIED_DETAILS: Record<UnverifiedReason, string> = {
  'never-checked':
    'Ninguém verificou os modelos desta conta ainda. Isto não é um erro: o modelo continua selecionável.',
  'cli-does-not-report-models':
    'O Claude Code instalado não informa quais modelos esta conta pode usar, então não dá para confirmar por aqui. Isso não significa que o modelo esteja indisponível.',
  'account-not-connected':
    'Só dá para verificar os modelos de uma conta conectada com credencial própria.',
  'runtime-missing': 'O Claude Code ainda não está configurado, então não há a quem perguntar.',
  'check-failed': 'A verificação não pôde ser concluída. O modelo continua selecionável.',
  'listing-not-exhaustive':
    'A conta respondeu, mas sem afirmar que a lista está completa, então a ausência do modelo não prova nada.',
  'outside-catalog':
    'Este identificador não está no catálogo desta aplicação. Ele continua selecionável; só não temos como descrevê-lo.',
  'denial-expired':
    'A verificação anterior é antiga demais para ser mantida. Direitos de acesso mudam, então ela foi descartada em vez de continuar bloqueando o modelo.',
};

export interface StatusOptions {
  now?: Date;
  confirmationTtlMs?: number;
  denialTtlMs?: number;
}

/**
 * The status of one model, for one account.
 *
 * `record` is that account's verification, or `null` when it has never been
 * checked. It is never another account's record.
 */
export function statusFor(
  accountId: string,
  modelIdOrAlias: string,
  record: AccountModelVerification | null,
  options: StatusOptions = {},
): ModelStatus {
  if (record && record.accountId !== accountId) {
    throw new Error(
      `refusing to describe ${accountId} using evidence gathered for ${record.accountId}: ` +
        'model availability is never shared between accounts',
    );
  }

  const now = options.now ?? new Date();
  const modelId = canonicalModelId(modelIdOrAlias);
  const catalogEntry = findModel(modelId);
  const displayName = modelDisplayName(modelId);
  const base = { accountId, modelId, displayName };

  const checkedAt = record?.checkedAt;
  const ageMs = checkedAt ? now.getTime() - Date.parse(checkedAt) : Number.POSITIVE_INFINITY;
  const confirmationExpired = ageMs > (options.confirmationTtlMs ?? CONFIRMATION_TTL_MS);
  const denialExpired = ageMs > (options.denialTtlMs ?? DENIAL_TTL_MS);

  // A retired model is a fact about the catalogue, and holds for every account.
  if (catalogEntry?.retired) {
    return {
      ...base,
      availability: 'UNAVAILABLE',
      reason: 'retired',
      label: AVAILABILITY_LABELS.unavailable,
      detail: catalogEntry.note ?? 'Este modelo foi descontinuado e não é mais oferecido.',
      tone: 'blocked',
      usable: false,
      evidence: { source: 'catalog', detail: 'catálogo: modelo descontinuado' },
      actions: [],
    };
  }

  const listsModel = (ids: string[]): boolean =>
    ids.some((id) => canonicalModelId(id).toLowerCase() === modelId.toLowerCase());

  if (record && listsModel(record.denied)) {
    if (!denialExpired) {
      const byCall = record.method === 'minimal-call';
      return {
        ...base,
        availability: 'UNAVAILABLE',
        reason: byCall ? 'refused-on-minimal-call' : 'reported-unavailable',
        label: AVAILABILITY_LABELS.unavailable,
        detail: byCall
          ? 'A chamada de verificação foi recusada para este modelo nesta conta.'
          : 'Esta conta informou explicitamente que não tem acesso a este modelo.',
        tone: 'blocked',
        usable: false,
        evidence: evidenceFrom(record),
        checkedAt: record.checkedAt,
        actions: [VERIFY_ACCOUNT_MODELS],
      };
    }
    return unverified(base, 'denial-expired', record, catalogEntry !== null);
  }

  if (record && listsModel(record.confirmed)) {
    return {
      ...base,
      availability: 'CONFIRMED_FOR_ACCOUNT',
      reason: 'confirmed',
      label: AVAILABILITY_LABELS.confirmed,
      detail: confirmationExpired
        ? `Confirmado nesta conta em ${formatDate(record.checkedAt)}. Vale confirmar de novo.`
        : `Confirmado nesta conta em ${formatDate(record.checkedAt)}.`,
      tone: 'ok',
      usable: true,
      evidence: evidenceFrom(record),
      checkedAt: record.checkedAt,
      ...(confirmationExpired ? { stale: true } : {}),
      actions: confirmationExpired ? [VERIFY_ACCOUNT_MODELS] : [],
    };
  }

  // Absence only means something when the listing claims to be complete, and
  // only for a model the catalogue knows - an unknown id could be anything.
  if (
    record &&
    record.outcome === 'verified' &&
    record.completeness === 'exhaustive' &&
    catalogEntry
  ) {
    if (!denialExpired) {
      return {
        ...base,
        availability: 'UNAVAILABLE',
        reason: 'not-in-account-entitlement',
        label: AVAILABILITY_LABELS.unavailable,
        detail:
          'A lista de modelos desta conta veio completa e não inclui este modelo. ' +
          'Outra conta pode tê-lo; esta não tem.',
        tone: 'blocked',
        usable: false,
        evidence: evidenceFrom(record),
        checkedAt: record.checkedAt,
        actions: [VERIFY_ACCOUNT_MODELS],
      };
    }
    return unverified(base, 'denial-expired', record, true);
  }

  return unverified(
    base,
    unverifiedReason(record, catalogEntry !== null),
    record,
    catalogEntry !== null,
  );
}

/** Every catalogue model for a provider, plus any extra ids in play. */
export function statusesForAccount(
  accountId: string,
  record: AccountModelVerification | null,
  options: StatusOptions & { extraModelIds?: string[] } = {},
): ModelStatus[] {
  const ids = MODEL_CATALOG.map((model) => model.id);
  for (const extra of options.extraModelIds ?? []) {
    const canonical = canonicalModelId(extra);
    if (!ids.some((id) => id.toLowerCase() === canonical.toLowerCase())) ids.push(canonical);
  }
  return ids.map((id) => statusFor(accountId, id, record, options));
}

/**
 * The one-line summary above the list.
 *
 * It says what was and was not established, and never implies breakage.
 */
export function summarise(record: AccountModelVerification | null): {
  headline: string;
  tone: StatusTone;
  action: ModelAction;
} {
  if (!record) {
    return {
      headline: 'Modelos desta conta ainda não verificados.',
      tone: 'neutral',
      action: VERIFY_ACCOUNT_MODELS,
    };
  }
  switch (record.outcome) {
    case 'verified':
      return {
        headline:
          record.completeness === 'exhaustive'
            ? `${record.confirmed.length} modelo(s) confirmados nesta conta em ${formatDate(record.checkedAt)}.`
            : `${record.confirmed.length} modelo(s) confirmados nesta conta; a lista não se declara completa.`,
        tone: 'ok',
        action: VERIFY_ACCOUNT_MODELS,
      };
    case 'not-supported':
      return {
        headline:
          'O Claude Code instalado não expõe os modelos nem os direitos de acesso desta conta. ' +
          'Nada foi marcado como indisponível por causa disso.',
        tone: 'neutral',
        action: VERIFY_WITH_MINIMAL_CALL,
      };
    case 'account-not-connected':
      return {
        headline: 'Conecte a conta para poder verificar os modelos dela.',
        tone: 'neutral',
        action: CONNECT_ACCOUNT,
      };
    case 'runtime-missing':
      return {
        headline: 'Configure o Claude Code para poder verificar os modelos desta conta.',
        tone: 'neutral',
        action: INSTALL_RUNTIME,
      };
    case 'failed':
      return {
        headline: `Não foi possível concluir a verificação: ${record.detail}`,
        tone: 'neutral',
        action: VERIFY_ACCOUNT_MODELS,
      };
  }
}

function unverifiedReason(
  record: AccountModelVerification | null,
  inCatalog: boolean,
): UnverifiedReason {
  if (!record) return inCatalog ? 'never-checked' : 'outside-catalog';
  switch (record.outcome) {
    case 'not-supported':
      return 'cli-does-not-report-models';
    case 'account-not-connected':
      return 'account-not-connected';
    case 'runtime-missing':
      return 'runtime-missing';
    case 'failed':
      return 'check-failed';
    case 'verified':
      return inCatalog ? 'listing-not-exhaustive' : 'outside-catalog';
  }
}

function unverified(
  base: { accountId: string; modelId: string; displayName: string },
  reason: UnverifiedReason,
  record: AccountModelVerification | null,
  inCatalog: boolean,
): ModelStatus {
  return {
    ...base,
    availability: 'KNOWN_BUT_UNVERIFIED',
    reason,
    label: inCatalog
      ? AVAILABILITY_LABELS.knownButUnverified
      : AVAILABILITY_LABELS.unknownButUnverified,
    detail: UNVERIFIED_DETAILS[reason],
    // Never a warning: nothing here is broken.
    tone: 'neutral',
    usable: true,
    evidence: record
      ? evidenceFrom(record)
      : { source: 'catalog', detail: 'catálogo da aplicação; nenhuma conta consultada' },
    ...(record ? { checkedAt: record.checkedAt } : {}),
    actions: actionsForUnverified(reason),
  };
}

function actionsForUnverified(reason: UnverifiedReason): ModelAction[] {
  switch (reason) {
    case 'runtime-missing':
      return [INSTALL_RUNTIME];
    case 'account-not-connected':
      return [CONNECT_ACCOUNT];
    case 'cli-does-not-report-models':
      return [VERIFY_ACCOUNT_MODELS, VERIFY_WITH_MINIMAL_CALL];
    default:
      return [VERIFY_ACCOUNT_MODELS, VERIFY_WITH_MINIMAL_CALL];
  }
}

function evidenceFrom(record: AccountModelVerification): AvailabilityEvidence {
  const source =
    record.method === 'none'
      ? ('none' as const)
      : record.method === 'minimal-call'
        ? ('minimal-call' as const)
        : record.method === 'provider-entitlement'
          ? ('provider-entitlement' as const)
          : ('runtime-capabilities' as const);
  return {
    source,
    detail: record.source ? `${record.detail} (${record.source})` : record.detail,
    accountId: record.accountId,
    observedAt: record.checkedAt,
  };
}

function formatDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const date = new Date(parsed);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}
