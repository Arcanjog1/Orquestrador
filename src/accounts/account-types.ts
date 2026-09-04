/**
 * Provider accounts.
 *
 * The user types a friendly name - "Claude Trabalho" - and nothing else. The
 * application owns the configuration directory behind it and never shows the
 * string CLAUDE_CONFIG_DIR anywhere in the interface.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google';

export interface Account {
  /** Stable internal id; also the name of the account's private folder. */
  id: string;
  providerId: ProviderId;
  /** What the user typed, e.g. "Claude Trabalho". */
  displayName: string;
  createdAt: string;
  /** Set once the account has authenticated at least once. */
  lastConnectedAt?: string;
}

export type AuthState =
  /** Authenticated with a credential that belongs to this account alone. */
  | 'connected'
  /** Never signed in, or signed out. */
  | 'disconnected'
  /**
   * The CLI reports being signed in, but the credential is not this account's:
   * it comes from the environment or a shared configuration home. Treating this
   * as connected would silently break account isolation.
   */
  | 'ambient-credential'
  /** The runtime needed to check is not installed yet. */
  | 'runtime-missing';

export interface AccountStatus {
  accountId: string;
  displayName: string;
  state: AuthState;
  /** How the CLI says it is authenticated, when it says anything. */
  authMethod?: string;
  /** User-facing explanation; present when `state !== 'connected'`. */
  problem?: string;
  /** Label for the action that fixes it. */
  remedy?: string;
  checkedAt: string;
}

/** Progress of an interactive sign-in, as the interface renders it. */
export type LoginPhase =
  | 'starting'
  | 'awaiting-browser'
  | 'waiting-for-completion'
  | 'connected'
  | 'failed'
  | 'cancelled';

export interface LoginProgress {
  accountId: string;
  phase: LoginPhase;
  message: string;
  /**
   * The sign-in URL, handed to the application so it can open the system
   * browser. It is never logged: it can carry a one-time code.
   */
  url?: string;
  /**
   * The short confirmation code a device-code flow shows.
   *
   * Displayed to the user so they can match it on the browser page. Not a
   * secret on its own - the page is useless without the account's own login -
   * but it is still never written to a log.
   */
  code?: string;
}

export class AccountError extends Error {
  constructor(
    readonly accountId: string,
    readonly userMessage: string,
    readonly remedy: string,
    readonly detail?: string,
  ) {
    super(`${accountId}: ${userMessage}${detail ? ` (${detail})` : ''}`);
    this.name = 'AccountError';
  }
}
