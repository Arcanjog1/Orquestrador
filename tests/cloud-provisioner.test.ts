/**
 * The container workspace provisioner.
 *
 * A remote workspace is where somebody else's code, a private repository and
 * two language models meet. The properties tested here are the ones that, if
 * they broke, would not show up as a failing run - they would show up as a
 * leaked token or a container with more power than it needed. So they are
 * pinned against the exact argument vectors the provisioner builds.
 *
 * The container runtime is faked; that is deliberate and sufficient. What is
 * under test is what we *ask* it to do - and asking for the wrong thing is the
 * whole risk. Running the real runtime end to end is the cloud E2E gate, and
 * it needs a host, which is a human gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContainerProcessRunner,
  ContainerWorkspaceProvisioner,
} from '../src/cloud/container-provisioner.js';
import { DEFAULT_LIMITS, ProvisioningError, type RepositoryAccess } from '../src/cloud/provisioner.js';
import type { ProcessResult, ProcessRunner, RunProcessOptions } from '../src/execution/process-runner.js';

const TOKEN = 'ghs_thisIsTheSecretInstallationToken';

function fakeHost(script: (options: RunProcessOptions) => Partial<ProcessResult> = () => ({})) {
  const calls: RunProcessOptions[] = [];
  const host: ProcessRunner = {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      calls.push(options);
      return {
        outcome: 'completed',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
        truncated: false,
        ...script(options),
      } as ProcessResult;
    },
    async cancelAll() {},
  };
  return { host, calls };
}

const access: RepositoryAccess = {
  async token() {
    return { value: TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString(), identity: 'app/orq' };
  },
};

function provisioner(host: ProcessRunner): ContainerWorkspaceProvisioner {
  return new ContainerWorkspaceProvisioner({
    host,
    runtimeCommand: 'docker',
    image: 'ai-orchestrator/workspace:1',
    repositoryAccess: access,
  });
}

const request = (overrides: Partial<Parameters<ContainerWorkspaceProvisioner['provision']>[0]> = {}) => ({
  cloudWorkspaceId: 'cw-1',
  repository: 'Arcanjog1/Orquestrador',
  branch: 'main',
  privateRepository: true,
  limits: DEFAULT_LIMITS,
  ...overrides,
});

/** Everything the host was ever asked to run, flattened for searching. */
const flatten = (calls: RunProcessOptions[]): string =>
  calls.map((c) => [c.command, ...(c.args ?? [])].join(' ')).join('\n');

test('a workspace is created with least privilege and a ceiling on every resource', async () => {
  const { host, calls } = fakeHost((o) => (o.args?.[0] === 'create' ? { stdout: 'abc123\n' } : {}));
  await provisioner(host).provision(request());

  const create = calls.find((c) => c.args?.[0] === 'create')!;
  const args = create.args!;
  const valueOf = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

  assert.ok(args.includes('--cap-drop') && valueOf('--cap-drop') === 'ALL');
  assert.equal(valueOf('--security-opt'), 'no-new-privileges');
  assert.ok(valueOf('--user') !== '0:0' && valueOf('--user') !== 'root', 'workspaces never run as root');
  assert.equal(valueOf('--cpus'), String(DEFAULT_LIMITS.cpus));
  assert.equal(valueOf('--memory'), `${DEFAULT_LIMITS.memoryMb}m`);
  assert.equal(valueOf('--storage-opt'), `size=${DEFAULT_LIMITS.diskMb}m`);
  assert.ok(args.includes('--pids-limit'));
  // The reaper finds abandoned containers by label after a coordinator restart.
  assert.ok(args.some((a) => a === `cloudWorkspaceId=cw-1`));
  // The container's entry point is not a shell.
  assert.deepEqual(args.slice(-2), ['sleep', 'infinity']);
});

test('the repository token never reaches a URL, an argument or the git config', async () => {
  // The property that matters most: a credential that leaks into .git/config
  // is a credential the worker model can read and a log line can carry.
  const { host, calls } = fakeHost((o) => (o.args?.[0] === 'create' ? { stdout: 'abc123\n' } : {}));
  await provisioner(host).provision(request());

  const everything = flatten(calls);
  assert.ok(!everything.includes(TOKEN), 'the token appeared in an argument vector');
  assert.ok(!/https:\/\/[^\s]*@github\.com/.test(everything), 'a credential was embedded in a URL');

  const clone = calls.find((c) => (c.args ?? []).includes('clone'))!;
  assert.ok(clone, 'nothing was cloned');
  // The remote that lands in .git/config is the plain one.
  assert.ok((clone.args ?? []).includes('https://github.com/Arcanjog1/Orquestrador.git'));
  // Authentication goes through the askpass helper, and caching is off.
  assert.ok((clone.args ?? []).join(' ').includes('credential.helper='));
  // The token was handed over on stdin, not as an argument.
  const write = calls.find((c) => (c.args ?? []).some((a) => a.startsWith('/run/orchestrator/')))!;
  assert.ok(write, 'the token was never written to a protected file');
  assert.equal(write.stdin, TOKEN);
  assert.ok(!(write.args ?? []).some((a) => a.includes(TOKEN)));
  // And it is deleted afterwards rather than left in the environment.
  assert.ok(everything.includes('rm -f /run/orchestrator/'), 'the token file was not removed');
});

test('a public repository is cloned with no token at all', async () => {
  let minted = 0;
  const countingAccess: RepositoryAccess = {
    async token() {
      minted += 1;
      return { value: TOKEN, expiresAt: '', identity: 'x' };
    },
  };
  const { host, calls } = fakeHost((o) => (o.args?.[0] === 'create' ? { stdout: 'abc\n' } : {}));
  await new ContainerWorkspaceProvisioner({
    host,
    runtimeCommand: 'docker',
    image: 'img',
    repositoryAccess: countingAccess,
  }).provision(request({ privateRepository: false }));

  assert.equal(minted, 0, 'a token was minted for a public repository');
  assert.ok(!flatten(calls).includes('/run/orchestrator/'));
});

test('a clone that fails names the reason, and the half-made workspace is removed', async () => {
  for (const [stderr, reason] of [
    ['remote: Repository not found.\nfatal: repository not found', 'REPOSITORY_NOT_FOUND'],
    ['fatal: could not read Username for https://github.com: terminal prompts disabled', 'REPOSITORY_UNAUTHORIZED'],
    ["fatal: Remote branch nope not found in upstream origin", 'BRANCH_NOT_FOUND'],
    ['fatal: unable to access: server certificate verification failed', 'CLONE_FAILED'],
  ] as const) {
    const { host, calls } = fakeHost((o) => {
      if (o.args?.[0] === 'create') return { stdout: 'abc\n' };
      if ((o.args ?? []).includes('clone')) return { exitCode: 128, stderr };
      // The clone runs through `docker exec`, so unwrap to see the inner args.
      if (o.args?.[0] === 'exec' && o.args.includes('clone')) return { exitCode: 128, stderr };
      return {};
    });
    await assert.rejects(
      provisioner(host).provision(request()),
      (error: unknown) => {
        assert.ok(error instanceof ProvisioningError, String(error));
        assert.equal(error.reason, reason, stderr);
        return true;
      },
    );
    // Nothing is left running and billing.
    assert.ok(
      calls.some((c) => c.args?.[0] === 'rm' && (c.args ?? []).includes('--force')),
      `the container was left behind after ${reason}`,
    );
  }
});

test('the environment overlay survives the trip into the container, unset included', async () => {
  // The block A3 policy is expressed as `undefined`: the variable must NOT be
  // inherited. If that became "keep whatever the image has", a managed Codex
  // in a container inheriting a poisoned variable would abort exactly as it
  // did on Windows - the same incident, one layer away.
  const { host, calls } = fakeHost();
  const runner = new ContainerProcessRunner(host, 'docker', 'orq-cw-1');
  await runner.run({
    command: 'codex',
    args: ['exec'],
    cwd: '/workspace/repo',
    env: { OPENSSL_ia32cap: undefined, CODEX_HOME: '/run/profiles/a' },
    stdin: 'o prompt',
  });

  const args = calls[0]!.args!;
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('-i'), 'stdin must reach the child');
  assert.equal(args[args.indexOf('--workdir') + 1], '/workspace/repo');
  assert.ok(args.includes('OPENSSL_ia32cap='), 'the unset was dropped on the way in');
  assert.ok(args.includes('CODEX_HOME=/run/profiles/a'));
  // The prompt travels on stdin, never in argv - the same rule as locally.
  assert.equal(calls[0]!.stdin, 'o prompt');
  assert.ok(!args.some((a) => a.includes('o prompt')));
  // The command and its arguments are a vector; nothing is handed to a shell.
  assert.deepEqual(args.slice(-2), ['codex', 'exec']);
  assert.ok(!args.includes('sh') && !args.includes('-c'));
});

test('a released workspace refuses to start anything else', async () => {
  const { host, calls } = fakeHost();
  const runner = new ContainerProcessRunner(host, 'docker', 'orq-cw-1');
  await runner.cancelAll();
  const result = await runner.run({ command: 'git', args: ['status'], cwd: '/workspace/repo' });
  assert.equal(result.outcome, 'cancelled');
  assert.equal(calls.length, 0, 'a command reached a released workspace');
});
