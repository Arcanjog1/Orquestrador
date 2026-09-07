/**
 * The provider boundary.
 *
 * One interface for "invoke an agent and get a structured answer back",
 * whatever is behind it: the official Claude Code CLI, the official Codex CLI,
 * the Anthropic Messages API, the OpenAI Responses API, or the next provider.
 *
 * It is deliberately an *extension* of `AgentRunner`, not a replacement. The
 * orchestration loop already talks to `AgentRunner` and keeps doing exactly
 * that - so adding API providers does not fork the loop, does not create a
 * second orchestrator and does not create a second DONE gate. What this
 * interface adds is the part the loop cannot get from a process: what a
 * connection can actually do, which models the account really has, whether it
 * is authenticated, and what it has spent.
 *
 * The honesty rule of this file: **a capability is declared, never assumed.**
 * A model API can produce text, decisions and tool calls. It cannot edit a
 * file. `ProviderCapabilities.toolExecution` is what says which is which, and
 * the loop refuses a coding delegation to a connection that declares `false`.
 */

import type { AgentRunner } from '../agents/agent-runner.js';
import type { ProviderId } from '../accounts/account-types.js';
import type { BillingModel, InvocationUsage, ProviderFailureKind } from '../core/types.js';

export type { BillingModel, InvocationUsage, ProviderFailureKind };

/** How a connection authenticates, and therefore who pays for it. */
export type ConnectionKind =
  /** The provider's official CLI, signed in by the person, on their machine. */
  | 'cli'
  /** The provider's HTTP API with the person's own key. Metered, billed apart. */
  | 'api';

/**
 * What one connection can really do.
 *
 * Every field is answered by the adapter about *itself*. Nothing here is a
 * promise the loop makes on a provider's behalf.
 */
export interface ProviderCapabilities {
  readonly providerId: ProviderId;
  readonly connectionKind: ConnectionKind;
  /** Can answer, analyse, plan, review. Every provider can. */
  readonly conversation: boolean;
  /**
   * Can read, edit and run things in a workspace *by itself*.
   *
   * True for the coding CLIs, which carry their own tool executor. False for a
   * bare model API: it can describe an edit, it cannot make one. This is the
   * field that stops "the API said it edited the file" from ever becoming
   * "the file changed".
   */
  readonly toolExecution: boolean;
  /** Needs a folder to run in at all. False for conversation-only providers. */
  readonly workspaceRequired: boolean;
  /** Can report partial output while the invocation is still running. */
  readonly streaming: boolean;
  /** Can be asked for output conforming to a JSON schema. */
  readonly structuredOutput: boolean;
  /** Reports token usage the application can record and add up. */
  readonly usageReporting: boolean;
  /** Accepts a model chosen per invocation. */
  readonly modelSelection: boolean;
  /** Accepts a reasoning/effort level per invocation. */
  readonly reasoningSelection: boolean;
  readonly billing: BillingModel;
}

/** A model the account really has, as the provider named it. Never invented. */
export interface ModelDescriptor {
  /** The exact id to send back to the provider. */
  readonly id: string;
  /** What the provider calls it, when it says. Falls back to the id. */
  readonly displayName: string;
  /** When the provider dates it, for ordering newest-first. */
  readonly createdAt?: string | null;
}

/** Whether a connection can be used right now, and what to do when it cannot. */
export interface AuthenticationStatus {
  readonly connectionId: string | null;
  readonly providerId: ProviderId;
  readonly connectionKind: ConnectionKind;
  readonly authenticated: boolean;
  /** How it is authenticated, in the provider's own words when it says. */
  readonly method?: string;
  /** Why it is not usable. Present only when `authenticated === false`. */
  readonly problem?: string;
  /** The action that fixes it, as a label the interface can render. */
  readonly remedy?: string;
  readonly checkedAt: string;
}

/** Failures it is ever sensible to try again. Everything else is not. */
const RETRYABLE: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
  'rate-limit',
  'timeout',
  'network',
  'provider-error',
]);

export class ProviderError extends Error {
  readonly userMessage: string;
  constructor(
    readonly kind: ProviderFailureKind,
    userMessage: string,
    readonly detail: string | null = null,
    /** The provider's HTTP status, when there was one. */
    readonly status: number | null = null,
    /** Seconds the provider asked us to wait, from `retry-after`. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(detail ? `${userMessage} (${detail})` : userMessage);
    this.name = 'ProviderError';
    this.userMessage = detail ? `${userMessage} Detalhe: ${detail}.` : userMessage;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/**
 * A provider connection, as the application drives it.
 *
 * `run`, `cancel` and `healthCheck` come from `AgentRunner` unchanged: that is
 * the whole point - the loop keeps calling what it already called.
 */
export interface AgentProvider extends AgentRunner {
  readonly providerId: ProviderId;
  /** The connection (account) this provider speaks for. Null for an unbound CLI. */
  readonly connectionId: string | null;
  getCapabilities(): ProviderCapabilities;
  /**
   * The models this account really has, asked of the provider.
   *
   * Never a hard-coded list: an account without access to a model must not be
   * offered it, and a model released after this build must not be hidden.
   */
  getAvailableModels(): Promise<ModelDescriptor[]>;
  getAuthenticationStatus(): Promise<AuthenticationStatus>;
  /** What this provider has consumed since it was built, summed. */
  getUsage(): InvocationUsage;
}

/** True when the object is a full provider rather than a bare runner. */
export function isAgentProvider(runner: AgentRunner): runner is AgentProvider {
  return typeof (runner as Partial<AgentProvider>).getCapabilities === 'function';
}

/** Adds two usages. Nulls stay null only when neither side reported anything. */
export function addUsage(a: InvocationUsage | null, b: InvocationUsage | null): InvocationUsage {
  const sum = (x: number | null | undefined, y: number | null | undefined): number | null =>
    x === null || x === undefined ? (y ?? null) : x + (y ?? 0);
  return {
    billing: a?.billing ?? b?.billing ?? 'unknown',
    inputTokens: sum(a?.inputTokens, b?.inputTokens),
    outputTokens: sum(a?.outputTokens, b?.outputTokens),
    cachedInputTokens: sum(a?.cachedInputTokens, b?.cachedInputTokens),
    reasoningTokens: sum(a?.reasoningTokens, b?.reasoningTokens),
    totalTokens: sum(a?.totalTokens, b?.totalTokens),
    costUsd: sum(a?.costUsd, b?.costUsd),
    costReported: (a?.costReported ?? false) || (b?.costReported ?? false),
  };
}

/** The zero usage, for a provider that has run nothing yet. */
export function emptyUsage(billing: BillingModel): InvocationUsage {
  return {
    billing,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    costUsd: null,
    costReported: false,
  };
}
