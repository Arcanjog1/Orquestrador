/**
 * The workspace provisioner port.
 *
 * A remote run needs one thing that a local run gets for free: somewhere
 * isolated, with the repository in it, that can start processes. This is the
 * seam where that comes from, and it is a port on purpose - the coordinator,
 * the loop and the interface must not know whether the isolation underneath is
 * a container on a host we run, or a machine from a service we pay for.
 *
 * Everything above this line can therefore be written, tested and shipped
 * before the account that pays for the second one exists. That is the point.
 *
 * Two rules the port encodes rather than leaves to each implementation:
 *
 *  1. **A workspace is never handed a durable credential.** Repository access
 *     arrives as a short-lived token, fetched at clone time through
 *     `RepositoryAccess`, and it is never written into the remote URL - so it
 *     cannot end up in `.git/config`, in a log, or in anything a model reads.
 *  2. **A workspace belongs to exactly one session.** Two conversations in the
 *     same project get two workspaces; one can never overwrite the other's
 *     uncommitted work.
 */

import type { ProcessRunner } from '../execution/process-runner.js';

/** What a provisioner is asked for. */
export interface WorkspaceRequest {
  /** The durable `cloud_workspaces` row this belongs to. */
  readonly cloudWorkspaceId: string;
  /** `owner/name`, as GitHub names it. */
  readonly repository: string;
  readonly branch: string;
  /** True when the repository needs an authorised token to clone. */
  readonly privateRepository: boolean;
  /** Resource ceilings. A provisioner that cannot honour one must say so. */
  readonly limits: WorkspaceLimits;
  /** Cancels provisioning; a half-made workspace must be torn down, not leaked. */
  readonly signal?: AbortSignal;
  /** Progress, phase by phase, for the timeline the person watches. */
  readonly onProgress?: (phase: WorkspacePhase, detail?: string) => void;
}

export type WorkspacePhase =
  | 'preparing'
  | 'cloning'
  | 'installing-runtimes'
  | 'ready'
  | 'releasing';

/**
 * The ceilings a workspace runs under.
 *
 * Every one of these costs money when it is missing, which is why they are
 * required rather than optional: a provisioner has to be told the budget, not
 * left to invent one.
 */
export interface WorkspaceLimits {
  readonly cpus: number;
  readonly memoryMb: number;
  readonly diskMb: number;
  /** Wall-clock ceiling for the whole workspace, after which it is reclaimed. */
  readonly maxLifetimeMs: number;
  /** Reclaimed early when nothing has run for this long. */
  readonly idleTimeoutMs: number;
  /**
   * Hosts the workspace may reach. Empty means no outbound network at all.
   * A provisioner that cannot enforce this must report `network: false` in its
   * capabilities rather than silently allow everything.
   */
  readonly allowedHosts: readonly string[];
}

/** How a workspace gets at a repository, without ever holding a lasting secret. */
export interface RepositoryAccess {
  /**
   * A short-lived credential for one clone or push, minted now.
   *
   * Returning a fresh one per call is deliberate: an installation token is
   * good for about an hour, and a workspace that lives longer than that must
   * ask again rather than keep one around.
   */
  token(repository: string, scope: 'read' | 'write'): Promise<RepositoryToken>;
}

export interface RepositoryToken {
  /** The token itself. Never logged, never put in a URL, never shown a model. */
  readonly value: string;
  readonly expiresAt: string;
  /** The account the token acts as, for the record. */
  readonly identity: string;
}

/** A workspace that exists and can run processes. */
export interface ProvisionedWorkspace {
  readonly cloudWorkspaceId: string;
  /** The provisioner's own handle. Opaque above this layer. */
  readonly handle: string;
  /** The repository's absolute path **inside** the workspace. */
  readonly workingDirectory: string;
  /** Starts processes inside the workspace. */
  readonly processes: ProcessRunner;
  /** The commit the clone landed on, for the run's baseline. */
  readonly commit: string | null;
  /** Gives the workspace back. Idempotent: releasing twice is not an error. */
  release(): Promise<void>;
}

/** What an implementation can actually enforce, so nothing is assumed. */
export interface ProvisionerCapabilities {
  /** True when workspaces are isolated from each other and from the host. */
  readonly isolated: boolean;
  /** True when `allowedHosts` is really enforced. */
  readonly networkPolicy: boolean;
  /** True when cpu/memory/disk ceilings are really applied. */
  readonly resourceLimits: boolean;
  /** True when a workspace survives the process that created it. */
  readonly durable: boolean;
}

export interface WorkspaceProvisioner {
  /** Names this provisioner in the `cloud_workspaces` row. */
  readonly id: string;
  readonly capabilities: ProvisionerCapabilities;
  /** Makes a workspace, clones into it, and hands back something runnable. */
  provision(request: WorkspaceRequest): Promise<ProvisionedWorkspace>;
  /**
   * Reclaims a workspace by handle alone, with no live object.
   *
   * This is what the reaper uses after a restart: the row survived, the
   * in-memory object did not, and the resources are still being paid for.
   */
  reclaim(handle: string): Promise<void>;
}

/** A provisioner refused, and why - so the interface can say something useful. */
export class ProvisioningError extends Error {
  readonly userMessage: string;
  constructor(
    readonly reason:
      | 'BACKEND_UNAVAILABLE'
      | 'REPOSITORY_UNAUTHORIZED'
      /** No usable credential for an agent, so the run cannot be attempted. */
      | 'AGENT_CREDENTIAL_MISSING'
      /** A credential exists but the agent refused it. */
      | 'AGENT_CREDENTIAL_REFUSED'
      | 'REPOSITORY_NOT_FOUND'
      | 'BRANCH_NOT_FOUND'
      | 'CLONE_FAILED'
      | 'LIMITS_UNSUPPORTED'
      | 'QUOTA_EXCEEDED'
      | 'CANCELLED',
    userMessage: string,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${userMessage} (${detail})` : userMessage);
    this.name = 'ProvisioningError';
    this.userMessage = detail ? `${userMessage} Detalhe: ${detail}.` : userMessage;
  }
}

/** Ceilings that keep a forgotten run from becoming a bill. */
export const DEFAULT_LIMITS: WorkspaceLimits = {
  cpus: 2,
  memoryMb: 4096,
  diskMb: 20480,
  maxLifetimeMs: 4 * 60 * 60_000,
  idleTimeoutMs: 30 * 60_000,
  allowedHosts: [
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'api.openai.com',
    'chatgpt.com',
    'api.anthropic.com',
    'registry.npmjs.org',
  ],
};
