/**
 * A workspace provisioner backed by an OCI container runtime.
 *
 * This is the concrete isolation the product ships with: `docker` or `podman`
 * on a host we control. It is deliberately the *first* implementation rather
 * than a stand-in - a container gives real isolation, real cpu/memory/disk
 * ceilings and a real network policy, all of which a managed service later
 * provides in the same shape. Choosing it means the architecture above can be
 * finished, tested and used before anyone pays for a fleet.
 *
 * Four properties are enforced here rather than trusted to configuration:
 *
 *  1. **No shell, anywhere.** Every command is an argument vector. A model's
 *     text can reach a workspace as a prompt; it can never reach `sh -c`.
 *  2. **No token in a URL.** The clone authenticates through `GIT_ASKPASS`
 *     reading a 0600 file under `/run/orchestrator`, outside the workspace,
 *     deleted immediately after. The remote URL that ends up in `.git/config`
 *     is the plain https one, so nothing durable holds a credential and
 *     nothing a model can read holds one either.
 *  3. **No privileges.** Every container drops all capabilities, sets
 *     `no-new-privileges`, and runs as a non-root user.
 *  4. **A ceiling on everything that costs money.** cpus, memory, disk and a
 *     lifetime, passed to the runtime, not merely recorded.
 */

import { randomUUID } from 'node:crypto';
import type { ProcessResult, ProcessRunner, RunProcessOptions } from '../execution/process-runner.js';
import {
  ProvisioningError,
  type ProvisionedWorkspace,
  type ProvisionerCapabilities,
  type RepositoryAccess,
  type WorkspaceProvisioner,
  type WorkspaceRequest,
} from './provisioner.js';

/** Where the workspace lives inside the container. */
const WORKSPACE_ROOT = '/workspace';
/** Secrets go here: outside the workspace, so nothing checked out can read them. */
const SECRET_DIR = '/run/orchestrator';

export interface ContainerProvisionerOptions {
  /** Runs commands on the host that owns the container runtime. */
  host: ProcessRunner;
  /** `docker` or `podman`, resolved by the caller. */
  runtimeCommand: string;
  /**
   * The image workspaces are made from. It must already contain git, the
   * agent CLIs and a non-root user; building it is a deployment concern, not
   * something to do per run while the person waits.
   */
  image: string;
  /** Mints short-lived repository tokens. */
  repositoryAccess: RepositoryAccess;
  /** The uid:gid workspaces run as. Never 0. */
  user?: string;
  /** Overridden in tests. */
  now?: () => number;
}

/** Runs processes inside one container. */
export class ContainerProcessRunner implements ProcessRunner {
  private readonly inFlight = new Set<AbortController>();
  private stopped = false;

  constructor(
    private readonly host: ProcessRunner,
    private readonly runtimeCommand: string,
    private readonly container: string,
  ) {}

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    if (this.stopped) {
      return abortedResult(options, 'O ambiente remoto foi encerrado.');
    }
    const controller = new AbortController();
    this.inFlight.add(controller);
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      // `exec -i` so stdin still reaches the child: the prompt travels the
      // same way remotely as it does locally, never on a command line.
      const args = [
        'exec',
        '-i',
        '--workdir',
        options.cwd,
        ...environmentArgs(options.env),
        this.container,
        options.command,
        ...(options.args ?? []),
      ];
      return await this.host.run({
        command: this.runtimeCommand,
        args,
        // The host command's own cwd is irrelevant: `--workdir` decides where
        // the child runs, and it is a path inside the container.
        cwd: process.cwd(),
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
        ...(options.onStdout ? { onStdout: options.onStdout } : {}),
        ...(options.onStderr ? { onStderr: options.onStderr } : {}),
        signal: controller.signal,
      });
    } finally {
      this.inFlight.delete(controller);
    }
  }

  async cancelAll(): Promise<void> {
    this.stopped = true;
    for (const controller of this.inFlight) controller.abort();
  }
}

/**
 * `-e KEY=VALUE` for each override, `-e KEY` alone to *unset*.
 *
 * The unset form matters: the environment overlay this product uses to keep
 * `OPENSSL_ia32cap` away from a managed Codex is expressed as `undefined`, and
 * it has to survive the trip into a container rather than quietly become "keep
 * whatever the image has".
 */
function environmentArgs(env: Record<string, string | undefined> | undefined): string[] {
  if (!env) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // `--env KEY=` with an empty value is how a container runtime is told the
    // variable must not carry the host's value. An absent variable and an
    // empty one behave the same for every consumer this product has.
    args.push('--env', value === undefined ? `${key}=` : `${key}=${value}`);
  }
  return args;
}

function abortedResult(options: RunProcessOptions, error: string): ProcessResult {
  const at = new Date().toISOString();
  return {
    outcome: 'cancelled',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    startedAt: at,
    finishedAt: at,
    truncated: false,
    error,
    trace: {
      pid: null,
      spawnedAt: at,
      startedAt: null,
      firstStdoutAt: null,
      firstStderrAt: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      exitedAt: null,
      closedAt: null,
      errorAt: at,
      errorCode: null,
      streamsLingered: false,
      survivedTermination: false,
      termination: null,
    },
  } as ProcessResult;
}

export class ContainerWorkspaceProvisioner implements WorkspaceProvisioner {
  readonly id = 'container';
  readonly capabilities: ProvisionerCapabilities = {
    isolated: true,
    networkPolicy: true,
    resourceLimits: true,
    // A container outlives the process that created it: that is exactly what
    // lets a run continue after the desktop is closed.
    durable: true,
  };

  constructor(private readonly options: ContainerProvisionerOptions) {}

  async provision(request: WorkspaceRequest): Promise<ProvisionedWorkspace> {
    const { host, runtimeCommand, image } = this.options;
    const name = `orq-${request.cloudWorkspaceId}`;
    const user = this.options.user ?? '1000:1000';
    request.onProgress?.('preparing');

    const create = await host.run({
      command: runtimeCommand,
      args: [
        'create',
        '--name',
        name,
        // Isolation and least privilege, stated rather than assumed.
        '--user',
        user,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '512',
        // Ceilings on everything that costs money.
        '--cpus',
        String(request.limits.cpus),
        '--memory',
        `${request.limits.memoryMb}m`,
        '--storage-opt',
        `size=${request.limits.diskMb}m`,
        // Labels are how the reaper finds what a crashed coordinator left.
        '--label',
        'app=ai-orchestrator',
        '--label',
        `cloudWorkspaceId=${request.cloudWorkspaceId}`,
        '--workdir',
        WORKSPACE_ROOT,
        image,
        // Something that stays alive and is not a shell.
        'sleep',
        'infinity',
      ],
      cwd: process.cwd(),
      timeoutMs: 120_000,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (create.exitCode !== 0) {
      throw new ProvisioningError(
        'BACKEND_UNAVAILABLE',
        'Não foi possível criar o ambiente remoto.',
        firstLine(create.stderr) ?? `saída ${create.exitCode}`,
      );
    }
    const handle = create.stdout.trim() || name;

    const runner = new ContainerProcessRunner(host, runtimeCommand, name);
    const workspace: ProvisionedWorkspace = {
      cloudWorkspaceId: request.cloudWorkspaceId,
      handle: name,
      workingDirectory: `${WORKSPACE_ROOT}/repo`,
      processes: runner,
      commit: null,
      release: async () => {
        await runner.cancelAll();
        await this.reclaim(name);
      },
    };

    try {
      const start = await host.run({
        command: runtimeCommand,
        args: ['start', name],
        cwd: process.cwd(),
        timeoutMs: 120_000,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (start.exitCode !== 0) {
        throw new ProvisioningError(
          'BACKEND_UNAVAILABLE',
          'O ambiente remoto não iniciou.',
          firstLine(start.stderr) ?? `saída ${start.exitCode}`,
        );
      }

      request.onProgress?.('cloning', request.repository);
      const commit = await this.clone(runner, request);
      request.onProgress?.('ready');
      return { ...workspace, commit };
    } catch (error) {
      // A half-made workspace is still a bill. Nothing is left behind.
      await workspace.release().catch(() => {});
      throw error;
    }
  }

  /**
   * Clones the repository into the workspace, authenticating without ever
   * putting the token in the URL.
   *
   * The token is written to a 0600 file outside the workspace and handed to
   * git through `GIT_ASKPASS`, then deleted. What lands in `.git/config` is
   * the plain https remote, so a later `git remote -v`, a log line, or
   * anything a model reads shows no credential.
   */
  private async clone(runner: ProcessRunner, request: WorkspaceRequest): Promise<string | null> {
    const url = `https://github.com/${request.repository}.git`;
    const env: Record<string, string | undefined> = {
      // A prompt would hang forever in a container with no terminal.
      GIT_TERMINAL_PROMPT: '0',
    };
    let secretFile: string | null = null;

    if (request.privateRepository) {
      const token = await this.options.repositoryAccess.token(request.repository, 'read');
      secretFile = `${SECRET_DIR}/${randomUUID()}`;
      const written = await runner.run({
        command: '/usr/local/bin/orq-write-secret',
        args: [secretFile],
        cwd: WORKSPACE_ROOT,
        stdin: token.value,
        timeoutMs: 30_000,
      });
      if (written.exitCode !== 0) {
        throw new ProvisioningError(
          'CLONE_FAILED',
          'Não foi possível preparar o acesso ao repositório dentro do ambiente.',
          firstLine(written.stderr),
        );
      }
      env.GIT_ASKPASS = '/usr/local/bin/orq-askpass';
      env.ORQ_TOKEN_FILE = secretFile;
      env.ORQ_TOKEN_USER = 'x-access-token';
    }

    try {
      const clone = await runner.run({
        command: 'git',
        args: [
          // No credential helper may cache this anywhere.
          '-c',
          'credential.helper=',
          'clone',
          '--branch',
          request.branch,
          '--single-branch',
          url,
          `${WORKSPACE_ROOT}/repo`,
        ],
        cwd: WORKSPACE_ROOT,
        env,
        timeoutMs: 15 * 60_000,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (clone.exitCode !== 0) {
        throw cloneFailure(clone.stderr, request);
      }
    } finally {
      if (secretFile) {
        await runner
          .run({ command: 'rm', args: ['-f', secretFile], cwd: WORKSPACE_ROOT, timeoutMs: 30_000 })
          .catch(() => {});
      }
    }

    const head = await runner.run({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: `${WORKSPACE_ROOT}/repo`,
      timeoutMs: 60_000,
    });
    return head.exitCode === 0 ? head.stdout.trim() || null : null;
  }

  /** Removes a container by name, whether or not anything still holds it. */
  async reclaim(handle: string): Promise<void> {
    await this.options.host
      .run({
        command: this.options.runtimeCommand,
        args: ['rm', '--force', '--volumes', handle],
        cwd: process.cwd(),
        timeoutMs: 120_000,
      })
      .catch(() => {});
  }
}

/** Turns git's own words into the reason a person can act on. */
function cloneFailure(stderr: string, request: WorkspaceRequest): ProvisioningError {
  const detail = firstLine(stderr);
  if (/could not read Username|Authentication failed|403|invalid credentials/i.test(stderr)) {
    return new ProvisioningError(
      'REPOSITORY_UNAUTHORIZED',
      `O acesso ao repositório ${request.repository} não foi autorizado.`,
      detail,
    );
  }
  // GitHub answers "not found" for a private repository you may not see, too:
  // the message says both, because from here the two are the same fact.
  if (/repository (?:'[^']*' )?not found|404/i.test(stderr)) {
    return new ProvisioningError(
      'REPOSITORY_NOT_FOUND',
      `O repositório ${request.repository} não foi encontrado, ou esta instalação não tem acesso a ele.`,
      detail,
    );
  }
  if (/Remote branch .* not found|couldn't find remote ref/i.test(stderr)) {
    return new ProvisioningError(
      'BRANCH_NOT_FOUND',
      `A branch ${request.branch} não existe em ${request.repository}.`,
      detail,
    );
  }
  return new ProvisioningError('CLONE_FAILED', 'A cópia do repositório falhou.', detail);
}

function firstLine(text: string): string | null {
  for (const line of (text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
