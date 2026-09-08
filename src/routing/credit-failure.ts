/**
 * Reading a provider's own words about credits, without inventing a cause.
 *
 * The account in the incident answered:
 *
 *     You're out of usage credits.
 *
 * That sentence is narrower than it looks. It does **not** say the
 * subscription is exhausted; on the account it came from, ordinary
 * subscription use was still available and what was missing were the extra
 * credits the chosen model draws on. Reporting it as "sem saldo" would have
 * been a guess dressed as a finding.
 *
 * So this classifies only what the text actually supports, and has an honest
 * `unknown` for everything else. The classification changes the *sentence a
 * person reads*; it never changes whether the failure is mechanical - it
 * always is, and a mechanical failure never buys a stronger model.
 */

/** What the provider's message supports saying, and nothing beyond it. */
export type CreditFailureCause =
  /** Extra credits, on top of the subscription, are exhausted or absent. */
  | 'extra-credits'
  /** The ordinary subscription allowance is used up for now. */
  | 'subscription-limit'
  /** The account is not entitled to the model that was asked for. */
  | 'model-not-authorised'
  /** The credential itself was refused. */
  | 'authentication'
  /** The message does not say. */
  | 'unknown';

export interface CreditFailure {
  readonly cause: CreditFailureCause;
  /** One line for the person, in the words the cause supports. */
  readonly message: string;
  /** True when the text names a model the account may not use. */
  readonly model: string | null;
}

/**
 * Classifies a provider or CLI message about credits, limits or entitlement.
 *
 * Order matters: the more specific readings are tried first, and the general
 * "no credits" wording only reaches `subscription-limit` when nothing more
 * precise matched.
 */
export function classifyCreditFailure(text: string | null | undefined): CreditFailure {
  const raw = (text ?? '').trim();
  const lower = raw.toLowerCase();
  if (lower.length === 0) return { cause: 'unknown', message: UNKNOWN, model: null };

  // The exact family of wording the incident produced. "Usage credits" and
  // "extra credits" are the vendor's words for the balance that sits beside
  // the subscription, not for the subscription itself.
  if (
    /out of (usage |extra |additional )?credits|usage credits|extra credits|additional credits|credit balance|sem cr[ée]ditos|cr[ée]ditos extras/.test(
      lower,
    )
  ) {
    return {
      cause: 'extra-credits',
      message:
        'A conta está sem créditos extras. Isso não é o mesmo que a assinatura ter acabado: ' +
        'o modelo escolhido consome créditos além do uso normal da assinatura. Escolha um ' +
        'modelo dentro do teto da conta, ou libere créditos extras para ela em Contas e ' +
        'integrações.',
      model: modelIn(raw),
    };
  }

  if (/not (authorized|authorised|entitled|allowed) (to use|for)|do(es)? not have access to (the )?model|model_not_found|unauthorized model|modelo não (autorizado|disponível)/.test(lower)) {
    return {
      cause: 'model-not-authorised',
      message:
        'Esta conta não tem acesso ao modelo solicitado. Ajuste o teto da conta para um ' +
        'modelo que ela possa usar.',
      model: modelIn(raw),
    };
  }

  if (/invalid api key|unauthorized|unauthorised|authentication|not logged in|please (log ?in|run \/login)|credencial/.test(lower)) {
    return {
      cause: 'authentication',
      message: 'A credencial desta conta não foi aceita. Reconecte a conta e tente de novo.',
      model: null,
    };
  }

  if (/usage limit|rate limit|limite de uso|quota|cota|plan limit|too many requests/.test(lower)) {
    return {
      cause: 'subscription-limit',
      message:
        'O limite de uso normal desta conta foi atingido. Isso costuma se restabelecer com o ' +
        'tempo; nenhum modelo mais forte resolve.',
      model: null,
    };
  }

  return { cause: 'unknown', message: UNKNOWN, model: null };
}

const UNKNOWN =
  'O provedor recusou a chamada e não disse o motivo com precisão suficiente. ' +
  'A causa exata não está registrada, e o aplicativo não vai adivinhá-la.';

/**
 * A model alias the message names, when it names one.
 *
 * Matched against the aliases this application routes by, so an unrelated word
 * in an error message never becomes a "model" on the screen.
 */
function modelIn(text: string): string | null {
  const match = /\b(fable|opus|sonnet|haiku|mythos)\b/i.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}
