/**
 * The Run Coordinator.
 *
 * This is the process that makes "close the computer and the work continues"
 * true. It owns runs, drives them, and writes everything it does to a durable
 * log - none of which depends on a desktop being connected, or even existing.
 *
 * The single most important thing about this file is what it does **not**
 * contain: a loop. Codex planning, delegation, evidence, verification, the
 * DONE gate and the automatic second delegation all come from the same
 * `OrchestrationService` the desktop has always used. A remote run differs
 * from a local one in exactly one way - the `ExecutionEnvironment` it is given
 * points into a provisioned workspace instead of a folder on someone's
 * machine. A second, simplified cloud loop would be a second DONE gate to keep
 * honest, and that is a promise this product would eventually break.
 *
 * Durability is three things, and they are all in `RunStore`: the event log
 * (so a desktop catches up exactly), idempotency keys (so a retry is not a
 * second run, a second commit or a second pull request) and leases (so two
 * coordinator processes never drive one run).
 */

import { randomUUID } from 'node:crypto';
import {
  Database,
  DECISION_JSON_SCHEMA,
  ProcessManager,
  newId,
  type WorkspaceWithAgents,
} from '../../desktop/src/main/core.js';
import type { ExecutionEnvironment } from '../../desktop/src/main/core.js';
import { EventBus } from '../../desktop/src/main/events.js';
import {
  OrchestrationService,
  type RunnerPair,
} from '../../desktop/src/main/services/orchestration-service.js';
import { CodexAdapter } from '../../desktop/src/main/adapters/codex-adapter.js';
import { ClaudeCodeAdapter } from '../../desktop/src/main/adapters/claude-adapter.js';
import { RunStore, type PrincipalRecord, type RemoteRunRecord } from '../../../src/cloud/coordinator/store.js';
import {
  DEFAULT_LIMITS,
  ProvisioningError,
  type ProvisionedWorkspace,
  type WorkspaceLimits,
  type WorkspaceProvisioner,
} from '../../../src/cloud/provisioner.js';
import { redact } from '../../../src/security/secret-redactor.js';

/**
 * Where the agent CLIs live inside a workspace image.
 *
 * Absolute, not a bare name: the same rule the desktop keeps (never resolve an
 * agent through PATH at execution time) matters more remotely, not less.
 */
export const REMOTE_EXECUTABLES = {
  codex: '/usr/local/bin/codex',
  claudeCode: '/usr/local/bin/claude',
} as const;

/**
 * Credentials the agents run with inside a workspace.
 *
 * Deliberately *not* copied from anyone's desktop. A local `auth.json` or a
 * browser cookie is a personal login for a personal machine; moving it to a
 * server is neither authorised by the subscription it came from nor safe. What
 * a workspace gets is an API credential the operator supplied for this
 * purpose, handed to the one process that needs it and never written down
 * inside the workspace.
 */
export interface AgentCredentials {
  /** For Codex. `codex login --with-api-key` reads it from stdin. */
  readonly openaiApiKey?: string | undefined;
  /** For Claude Code. */
  readonly anthropicApiKey?: string | undefined;
}

/**
 * What a desktop configured for this run: the team, and the checks it may ask
 * for.
 *
 * Verifications travel with the run because the DONE gate re-runs them from
 * scratch, remotely, before it accepts anything. A cloud run without its
 * catalogue would have nothing to prove itself with - and the gate would be
 * right to refuse it.
 *
 * They are *definitions*, written by a person in the interface, and the
 * orchestrator still asks for them **by id**. A model never supplies a command
 * line, remotely any more than locally.
 */
export interface RunTeam {
  readonly verifications?: readonly { id: string; label: string; command: string }[];
  readonly orchestrator?: { model?: string | null; reasoning?: string | null };
  readonly worker?: { selection?: string | null; model?: string | null; reasoning?: string | null };
}

export interface CoordinatorOptions {
  database: Database;
  provisioner: WorkspaceProvisioner;
  credentials: AgentCredentials;
  /** Identifies this process in a lease. Defaults to a fresh id per process. */
  owner?: string;
  limits?: WorkspaceLimits;
  /** Overridden in tests. */
  maxIterations?: number;
  agentTimeoutMs?: number;
  verificationTimeoutMs?: number;
  /** Lease lifetime and how often it is renewed while a run is driven. */
  leaseTtlMs?: number;
}

const LEASE_TTL_MS = 60_000;

export class Coordinator {
  readonly store: RunStore;
  private readonly owner: string;
  private readonly database: Database;
  private readonly processManager = new ProcessManager();
  /** Lease renewal timers, one per run this process is driving. */
  private readonly leases = new Map<string, NodeJS.Timeout>();
  /** The live loop of each run, so a cancel can reach the child processes. */
  private readonly driving = new Map<string, { orchestration: OrchestrationService; localRunId: string }>();
  /**
   * Every drive still in flight.
   *
   * Kept so `shutdown` can *wait* rather than merely ask. A drive that is
   * still writing when the store is closed is a lost event at best and a
   * half-written run at worst - and in a test it is the "asynchronous
   * activity after the test ended" that hides a real leak.
   */
  private readonly inFlight = new Set<Promise<void>>();
  /**
   * One controller per drive, so shutting down stops provisioning too.
   *
   * Provisioning is the longest thing a run does before it is cancellable by
   * any other means - a clone of a large repository can take minutes - so a
   * shutdown that could only wait for it would hang exactly when a person is
   * trying to stop paying for it.
   */
  private readonly aborts = new Map<string, AbortController>();
  private stopped = false;

  constructor(private readonly options: CoordinatorOptions) {
    this.database = options.database;
    this.store = new RunStore(options.database);
    this.owner = options.owner ?? `coord_${randomUUID()}`;
  }

  /**
   * Accepts a run and starts driving it, without waiting for it to finish.
   *
   * The caller gets an id immediately, which is what lets a desktop close
   * straight afterwards. `created: false` means this idempotency key already
   * produced a run, and the same one comes back.
   */
  async submit(input: {
    principal: PrincipalRecord;
    repository: string;
    branch: string;
    objective: string;
    idempotencyKey?: string | null;
    clientRunId?: string | null;
    clientSessionId?: string | null;
    team?: unknown;
  }): Promise<{ run: RemoteRunRecord; created: boolean }> {
    const result = this.store.createRun(input);
    if (result.created) this.track(this.drive(result.run.id));
    return result;
  }

  /**
   * Picks up runs nobody is driving.
   *
   * Called at start-up: a run that was in flight when the previous process
   * died is not lost, and it is not restarted either - the loop resumes from
   * the durable record.
   */
  async recover(): Promise<number> {
    let count = 0;
    for (const run of this.store.listAbandoned()) {
      if (this.driving.has(run.id)) continue;
      this.store.append(run.id, 'run.recovered', { owner: this.owner, previousStatus: run.status });
      this.track(this.drive(run.id));
      count += 1;
    }
    return count;
  }

  cancel(runId: string, principal: PrincipalRecord): boolean {
    const run = this.store.findRun(runId, principal);
    if (!run) return false;
    // Provisioning is the longest thing a run does before its loop exists, and
    // a clone of a large repository can take minutes. Aborting it is what makes
    // "cancel" stop the meter rather than only stop the next phase.
    this.aborts.get(runId)?.abort();

    const driving = this.driving.get(runId);
    if (driving) {
      driving.orchestration.cancel(driving.localRunId);
      return true;
    }
    // Not being driven here: record the intent so whichever process picks it
    // up stops rather than starts.
    this.store.setStatus(runId, 'CANCELLED', 'Encerrada pelo usuário.');
    return true;
  }

  /**
   * Stops driving, releases leases, and leaves every run resumable.
   *
   * It *waits* for what is in flight. A drive still writing while the store is
   * closing loses events, and a lease released while its loop is still running
   * would let a second process start the same run.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const controller of this.aborts.values()) controller.abort();
    for (const driving of this.driving.values()) driving.orchestration.cancel(driving.localRunId);
    await this.processManager.cancelAll();
    await Promise.allSettled([...this.inFlight]);
    this.aborts.clear();
    for (const [runId, renew] of this.leases) {
      clearInterval(renew);
      this.store.releaseLease(runId, this.owner);
    }
    this.leases.clear();
    this.driving.clear();
    this.inFlight.clear();
  }

  /** Remembers a drive until it settles, so shutdown can wait for it. */
  private track(promise: Promise<void>): void {
    const tracked = promise.catch(() => {});
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
  }

  // -- driving one run ------------------------------------------------------

  private async drive(runId: string): Promise<void> {
    if (this.stopped) return;
    if (!this.store.acquireLease(runId, this.owner, this.options.leaseTtlMs ?? LEASE_TTL_MS)) return;

    const renew = setInterval(() => {
      this.store.renewLease(runId, this.owner, this.options.leaseTtlMs ?? LEASE_TTL_MS);
    }, Math.max(1_000, (this.options.leaseTtlMs ?? LEASE_TTL_MS) / 3));
    // The renewal timer must never keep the process alive on its own.
    renew.unref?.();
    this.leases.set(runId, renew);
    const abort = new AbortController();
    this.aborts.set(runId, abort);

    let workspace: ProvisionedWorkspace | null = null;
    try {
      const run = this.store.requireRunUnscoped(runId);
      if (run.status === 'CANCELLED') return;

      this.store.setStatus(runId, 'PROVISIONING');
      const cloudWorkspace = this.database.cloudWorkspaces.create({
        id: newId('cw'),
        // The coordinator's own workspace row: one per remote run, so two
        // conversations never share a checkout.
        workspaceId: await this.ensureLocalWorkspaceRow(run),
        sessionId: null,
        provisioner: this.options.provisioner.id,
        repository: run.repository,
        branch: run.branch,
        workingDir: '/workspace/repo',
        ttlMs: (this.options.limits ?? DEFAULT_LIMITS).maxLifetimeMs,
      });
      this.store.setCloudWorkspace(runId, cloudWorkspace.id);

      workspace = await this.options.provisioner.provision({
        cloudWorkspaceId: cloudWorkspace.id,
        repository: run.repository,
        branch: run.branch,
        privateRepository: true,
        limits: this.options.limits ?? DEFAULT_LIMITS,
        signal: abort.signal,
        onProgress: (phase, detail) => {
          this.store.append(runId, 'workspace.phase', { phase, detail: detail ?? null });
        },
      });
      this.database.cloudWorkspaces.setHandle(cloudWorkspace.id, workspace.handle);
      this.database.cloudWorkspaces.setStatus(cloudWorkspace.id, 'ready');

      await this.signIn(workspace);

      const finished = await this.runLoop(run, workspace, cloudWorkspace.id);
      this.store.setStatus(runId, finished.status, finished.reason);
    } catch (error) {
      // A shutdown is not a failed run: the lease lapses and the next process
      // picks it up, which is the whole point of recovery.
      if (this.stopped) return;
      // Nor is a cancellation. The person's decision is already on the record;
      // overwriting it with FAILED would report their own choice as an error.
      if (this.store.requireRunUnscoped(runId).status === 'CANCELLED') return;
      const reason =
        error instanceof ProvisioningError
          ? error.userMessage
          : error instanceof Error
            ? error.message
            : String(error);
      this.store.append(runId, 'run.error', { reason: redact(reason) });
      this.store.setStatus(runId, 'FAILED', redact(reason));
    } finally {
      clearInterval(renew);
      this.leases.delete(runId);
      this.driving.delete(runId);
      this.aborts.delete(runId);
      // The workspace is given back whatever happened - it costs money for as
      // long as it exists, and shutting down is not a reason to leak one.
      await workspace?.release().catch(() => {});
      if (!this.stopped) {
        this.store.releaseLease(runId, this.owner);
        const run = this.store.requireRunUnscoped(runId);
        if (run.cloud_workspace_id) {
          this.database.cloudWorkspaces.setStatus(run.cloud_workspace_id, 'released');
        }
      }
    }
  }

  /**
   * Signs the agents in, inside the workspace, using operator credentials.
   *
   * `codex login --with-api-key` reads the key from **stdin** - the CLI's own
   * documented non-interactive path - so the key is never an argument and
   * never appears in the container's process list. Claude Code reads
   * `ANTHROPIC_API_KEY` from the environment of the exec that needs it, which
   * is why it is not written to a file here.
   *
   * Nothing about a person's ChatGPT or Claude subscription is assumed to
   * authorise this. When a key is absent the run fails with a sentence saying
   * so rather than pretending to be signed in.
   */
  private async signIn(workspace: ProvisionedWorkspace): Promise<void> {
    const key = this.options.credentials.openaiApiKey;
    if (!key) {
      throw new ProvisioningError(
        'REPOSITORY_UNAUTHORIZED',
        'O ambiente remoto não tem uma credencial autorizada para o Codex.',
        'configure OPENAI_API_KEY no coordenador',
      );
    }
    const result = await workspace.processes.run({
      command: REMOTE_EXECUTABLES.codex,
      args: ['login', '--with-api-key'],
      cwd: workspace.workingDirectory,
      stdin: key,
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0) {
      throw new ProvisioningError(
        'REPOSITORY_UNAUTHORIZED',
        'O Codex não aceitou a credencial no ambiente remoto.',
        redact(firstLine(result.stderr) ?? `saída ${result.exitCode}`),
      );
    }
  }

  /**
   * The existing loop, pointed at the remote workspace.
   *
   * Every event it publishes is written to the durable log before anyone sees
   * it, which is what a reconnecting desktop reads.
   */
  private async runLoop(
    run: RemoteRunRecord,
    workspace: ProvisionedWorkspace,
    cloudWorkspaceId: string,
  ): Promise<{ status: string; reason: string | null }> {
    const events = new EventBus();
    events.subscribe((channel, payload) => {
      this.store.append(run.id, `orchestration.${String(channel)}`, payload);
    });

    const environment: ExecutionEnvironment = {
      kind: 'remote',
      id: cloudWorkspaceId,
      workingDirectory: workspace.workingDirectory,
      processes: workspace.processes,
      // Released by `drive`'s finally, once, after the loop has ended.
      release: async () => {},
    };

    const orchestration = new OrchestrationService(
      this.database,
      this.processManager,
      events,
      async () => this.buildRunners(environment),
      {
        environments: async () => environment,
        ...(this.options.maxIterations !== undefined ? { maxIterations: this.options.maxIterations } : {}),
        ...(this.options.agentTimeoutMs !== undefined ? { agentTimeoutMs: this.options.agentTimeoutMs } : {}),
        ...(this.options.verificationTimeoutMs !== undefined
          ? { verificationTimeoutMs: this.options.verificationTimeoutMs }
          : {}),
        // Evidence uses the git that is in the workspace image.
        gitCommand: async () => 'git',
      },
      // The readiness check is the sign-in above; by here it has passed.
      async () => null,
    );

    const localWorkspaceId = await this.ensureLocalWorkspaceRow(run);
    const session = this.database.chat.createSession({
      id: newId('chat'),
      workspaceId: localWorkspaceId,
      title: run.objective.slice(0, 80),
      projectId: null,
    });
    this.store.append(run.id, 'run.started', { sessionId: session.id });
    this.store.setStatus(run.id, 'RUNNING');

    const started = orchestration.start({ sessionId: session.id, objective: run.objective });
    this.driving.set(run.id, { orchestration, localRunId: started.id });
    const view = await orchestration.waitFor(
      started.id,
      (this.options.agentTimeoutMs ?? 15 * 60_000) * ((this.options.maxIterations ?? 8) + 2),
    );
    return { status: view.status, reason: view.summary ?? null };
  }

  /** The agent pair, built against the workspace rather than this machine. */
  private buildRunners(environment: ExecutionEnvironment): RunnerPair {
    const orchestrator = new CodexAdapter({
      processManager: environment.processes,
      resolveExecutable: async () => REMOTE_EXECUTABLES.codex,
      outputSchema: DECISION_JSON_SCHEMA,
      // The workspace is disposable and belongs to one run, so the profile is
      // simply the one inside it. No desktop profile is ever copied here.
      buildEnvironment: () => ({ CODEX_HOME: '/home/node/.codex' }),
    });
    const worker = new ClaudeCodeAdapter({
      processManager: environment.processes,
      resolveExecutable: async () => REMOTE_EXECUTABLES.claudeCode,
      buildEnvironment: () => ({
        ANTHROPIC_API_KEY: this.options.credentials.anthropicApiKey,
        CLAUDE_CONFIG_DIR: '/home/node/.claude',
      }),
    });
    return {
      orchestrator,
      worker,
      workerAccountId: null,
      workerRouting: {
        provider: 'anthropic',
        selection: 'auto',
        manual: { model: null, reasoning: null },
        capabilities: () => worker.describeCapabilities(environment.workingDirectory),
      },
    };
  }

  /**
   * The workspace row the loop's own tables hang off.
   *
   * A remote run still has projects, sessions, steps and invocations, and they
   * still belong to a workspace row. Its `local_path` is empty because there
   * is no folder on any computer - the environment decides where work happens.
   */
  private async ensureLocalWorkspaceRow(run: RemoteRunRecord): Promise<string> {
    const existing = this.database.workspaces
      .list()
      .find((w) => w.environment === 'cloud' && w.repository_full_name === run.repository && w.branch === run.branch);
    const workspaceId =
      existing?.id ??
      this.database.workspaces.create({
        id: newId('ws'),
        name: run.repository,
        localPath: '',
        environment: 'cloud',
        repositoryFullName: run.repository,
        repositoryPrivate: true,
        branch: run.branch,
        repositoryUrl: `https://github.com/${run.repository}`,
        defaultBranch: run.branch,
      }).id;

    // The checks this run may be asked to prove itself with. Registered
    // before the loop starts, because the orchestrator resolves them by id and
    // an unknown id is reported as a failure rather than run.
    for (const verification of this.teamOf(run).verifications ?? []) {
      this.database.verifications.upsert({
        workspaceId,
        id: verification.id,
        label: verification.label,
        command: verification.command,
      });
    }
    return workspaceId;
  }

  /** The team configuration the desktop sent with this run. */
  private teamOf(run: RemoteRunRecord): RunTeam {
    try {
      const parsed: unknown = JSON.parse(run.team || '{}');
      return parsed && typeof parsed === 'object' ? (parsed as RunTeam) : {};
    } catch {
      return {};
    }
  }
}

function firstLine(text: string): string | null {
  for (const line of (text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

export type { WorkspaceWithAgents };
