/**
 * Model availability, stated honestly.
 *
 * The interface used to render a single unverified line - "Disponibilidade do
 * modelo não confirmada" - in the same yellow as a real failure. That is wrong
 * twice over: it looks like an error when nothing is broken, and it hides the
 * one distinction that actually matters to the user.
 *
 * There are three different things to say, and they are kept apart here:
 *
 *   CONFIRMED_FOR_ACCOUNT   the provider or the runtime told us, for *this*
 *                           account, that the model is there.
 *   KNOWN_BUT_UNVERIFIED    the model exists in the catalogue, and nobody has
 *                           checked this account yet. Not a problem, not a
 *                           warning, and never painted as one.
 *   UNAVAILABLE             something authoritative said this account cannot
 *                           use it. Only ever set from evidence.
 *
 * Two rules the rest of the module exists to keep:
 *
 *  1. **Evidence belongs to one account.** A model confirmed for "Claude
 *     Trabalho" says nothing about "Claude Pessoal". Every record is keyed by
 *     `accountId` and refuses to answer for a different one.
 *  2. **Silence is not a denial.** If the CLI does not expose the account's
 *     models, that is reported as exactly that, and everything stays
 *     `KNOWN_BUT_UNVERIFIED`. Nothing is ever marked `UNAVAILABLE` for want of
 *     an answer.
 */

/** The three states, spelled as the interface and the specification spell them. */
export type ModelAvailability =
  | 'CONFIRMED_FOR_ACCOUNT'
  | 'KNOWN_BUT_UNVERIFIED'
  | 'UNAVAILABLE';

/** Why a model is not confirmed. None of these is a failure of the model. */
export type UnverifiedReason =
  /** This account has never been checked. */
  | 'never-checked'
  /** The CLI has no command that reports the account's models or entitlement. */
  | 'cli-does-not-report-models'
  /** Checking needs a connected account, and this one is not connected. */
  | 'account-not-connected'
  /** The runtime that would answer is not installed yet. */
  | 'runtime-missing'
  /** The check ran and could not be completed - timeout, unreadable output. */
  | 'check-failed'
  /** The account's listing came back, but it does not claim to be complete. */
  | 'listing-not-exhaustive'
  /** The model is not in our catalogue, so the catalogue cannot vouch for it. */
  | 'outside-catalog'
  /** A previous denial has aged out; entitlements change, so it is not reused. */
  | 'denial-expired';

/** Why a model is unavailable. Every one of these requires evidence. */
export type UnavailableReason =
  /** The account's own listing is complete and does not contain the model. */
  | 'not-in-account-entitlement'
  /** The listing named the model and marked it as not available to this account. */
  | 'reported-unavailable'
  /** A minimal verification call was authorised and the model refused it. */
  | 'refused-on-minimal-call'
  /** The catalogue records the model as retired. */
  | 'retired';

export type StatusReason = UnverifiedReason | UnavailableReason | 'confirmed';

/**
 * How the interface paints a status.
 *
 * `neutral` is the whole point of this module: it is an ordinary informational
 * line, in ordinary text, with no warning colour and no alert icon.
 */
export type StatusTone = 'ok' | 'neutral' | 'blocked';

/** Where a piece of knowledge came from. */
export type EvidenceSource =
  /** Our own list of models. Says nothing about any account. */
  | 'catalog'
  /** The runtime reported its capabilities for this account's profile. */
  | 'runtime-capabilities'
  /** The provider reported this account's entitlement. */
  | 'provider-entitlement'
  /** A minimal call the user explicitly authorised. */
  | 'minimal-call'
  /** Nothing was consulted. */
  | 'none';

export interface AvailabilityEvidence {
  source: EvidenceSource;
  /** Human-readable, e.g. "listado por `claude models list --json`". */
  detail: string;
  /**
   * The account the evidence was gathered for. Present whenever the source is
   * anything but `catalog`, and checked before the evidence is used.
   */
  accountId?: string;
  /** When it was gathered. */
  observedAt?: string;
}

/** An action the interface can offer next to a model. */
export type ModelActionId =
  | 'verify-account-models'
  | 'verify-with-minimal-call'
  | 'connect-account'
  | 'install-runtime';

export interface ModelAction {
  id: ModelActionId;
  label: string;
  /**
   * True when running the action spends the account's usage. Such an action is
   * only ever offered, never taken without the user saying yes.
   */
  consumesUsage: boolean;
  hint?: string;
}

export const VERIFY_ACCOUNT_MODELS: ModelAction = {
  id: 'verify-account-models',
  label: 'Verificar modelos desta conta',
  consumesUsage: false,
  hint: 'Pergunta ao Claude Code quais modelos esta conta pode usar. Não envia nenhuma mensagem para o modelo.',
};

export const VERIFY_WITH_MINIMAL_CALL: ModelAction = {
  id: 'verify-with-minimal-call',
  label: 'Verificar com uma chamada mínima',
  consumesUsage: true,
  hint: 'Envia um pedido mínimo ao modelo para confirmar o acesso. Consome uso da sua conta.',
};

export const CONNECT_ACCOUNT: ModelAction = {
  id: 'connect-account',
  label: 'Conectar',
  consumesUsage: false,
};

export const INSTALL_RUNTIME: ModelAction = {
  id: 'install-runtime',
  label: 'Configurar automaticamente',
  consumesUsage: false,
};

/** One model, as one account sees it. */
export interface ModelStatus {
  accountId: string;
  modelId: string;
  displayName: string;
  availability: ModelAvailability;
  reason: StatusReason;
  /** The short line rendered next to the model. */
  label: string;
  /** One sentence of explanation, under the label. */
  detail: string;
  tone: StatusTone;
  /** Whether the model may be used. Only `UNAVAILABLE` says no. */
  usable: boolean;
  evidence: AvailabilityEvidence;
  /** When this account was last checked, when it ever was. */
  checkedAt?: string;
  /** True when the confirmation is old enough to be worth refreshing. */
  stale?: boolean;
  actions: ModelAction[];
}

/** How complete an account's model listing claims to be. */
export type ListingCompleteness =
  /** The listing states it is this account's entitlement, in full. */
  | 'exhaustive'
  /** Models were named, but the listing does not claim to be complete. */
  | 'partial'
  /** Nothing was listed. */
  | 'none';

export type VerificationOutcome =
  /** The account was checked and answered. */
  | 'verified'
  /** The CLI exposes no way to ask. Not a failure of the account. */
  | 'not-supported'
  /** The account is not connected, or is riding on an ambient credential. */
  | 'account-not-connected'
  /** The runtime is not installed. */
  | 'runtime-missing'
  /** The check ran and broke. */
  | 'failed';

export type VerificationMethod =
  | 'runtime-capabilities'
  | 'provider-entitlement'
  | 'minimal-call'
  | 'none';

/**
 * What one account's verification found.
 *
 * `confirmed` and `denied` are model ids *for this account only*. Reading this
 * record for a different account is a bug, and the store refuses it.
 */
export interface AccountModelVerification {
  accountId: string;
  checkedAt: string;
  outcome: VerificationOutcome;
  method: VerificationMethod;
  confirmed: string[];
  denied: string[];
  completeness: ListingCompleteness;
  /** User-facing sentence explaining the outcome. */
  detail: string;
  /** What answered, e.g. a command name. Never carries arguments or secrets. */
  source?: string;
}

export class ModelVerificationError extends Error {
  constructor(
    readonly accountId: string,
    readonly userMessage: string,
    readonly remedy: string,
    detail?: string,
  ) {
    super(`${accountId}: ${userMessage}${detail ? ` (${detail})` : ''}`);
    this.name = 'ModelVerificationError';
  }
}
