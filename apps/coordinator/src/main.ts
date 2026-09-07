/**
 * The coordinator, as a process.
 *
 * Everything it needs comes from the environment, because everything it needs
 * is a secret or a deployment decision and neither belongs in a repository.
 * It refuses to start rather than run half-configured: a coordinator that
 * quietly came up without a provisioner would accept runs it could never
 * execute, and the person would find out fifteen minutes later.
 */

import { Database, ProcessManager } from '../../desktop/src/main/core.js';
import { Coordinator } from './coordinator.js';
import { createCoordinatorServer } from './http.js';
import { Reaper } from './reaper.js';
import { ContainerWorkspaceProvisioner } from '../../../src/cloud/container-provisioner.js';
import { GitHubAppRepositoryAccess } from '../../../src/cloud/github-app-access.js';
import { DEFAULT_LIMITS, type WorkspaceLimits } from '../../../src/cloud/provisioner.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} não está definido. O coordenador não sobe sem ele: aceitar execuções que não pode executar é pior do que recusar iniciar.`,
    );
  }
  return value;
}

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function main(): Promise<void> {
  const database = new Database({ filePath: process.env.ORQ_DATABASE_FILE ?? undefined });

  const limits: WorkspaceLimits = {
    cpus: positive('ORQ_LIMIT_CPUS', DEFAULT_LIMITS.cpus),
    memoryMb: positive('ORQ_LIMIT_MEMORY_MB', DEFAULT_LIMITS.memoryMb),
    diskMb: positive('ORQ_LIMIT_DISK_MB', DEFAULT_LIMITS.diskMb),
    maxLifetimeMs: positive('ORQ_LIMIT_LIFETIME_MS', DEFAULT_LIMITS.maxLifetimeMs),
    idleTimeoutMs: positive('ORQ_LIMIT_IDLE_MS', DEFAULT_LIMITS.idleTimeoutMs),
    allowedHosts: (process.env.ORQ_ALLOWED_HOSTS ?? DEFAULT_LIMITS.allowedHosts.join(','))
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  };

  const provisioner = new ContainerWorkspaceProvisioner({
    host: new ProcessManager(),
    runtimeCommand: process.env.ORQ_CONTAINER_RUNTIME ?? 'docker',
    image: required('ORQ_WORKSPACE_IMAGE'),
    repositoryAccess: new GitHubAppRepositoryAccess({
      appId: required('ORQ_GITHUB_APP_ID'),
      // From the deployment's secret store. Never from a repository, and
      // never copied from anybody's desktop.
      privateKeyPem: required('ORQ_GITHUB_APP_PRIVATE_KEY'),
    }),
  });

  const coordinator = new Coordinator({
    database,
    provisioner,
    limits,
    credentials: {
      openaiApiKey: process.env.ORQ_OPENAI_API_KEY,
      anthropicApiKey: process.env.ORQ_ANTHROPIC_API_KEY,
    },
  });

  const reaper = new Reaper({ database, store: coordinator.store, provisioner });
  reaper.start();

  // Work the previous process was driving when it stopped. Recovered, not
  // restarted: the run is the same row, with its history intact.
  const recovered = await coordinator.recover();
  if (recovered > 0) console.log(`[coordinator] recuperadas ${recovered} execuções`);

  const server = createCoordinatorServer({ coordinator });
  const port = positive('ORQ_PORT', 8787);
  // Loopback by default. Exposing this is a deployment decision that has to be
  // made deliberately, in front of a TLS terminator.
  const host = process.env.ORQ_HOST ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.log(`[coordinator] ouvindo em http://${host}:${port}`);

  const stop = async (): Promise<void> => {
    reaper.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Leases are released and runs stay resumable: whatever picks them up
    // next continues rather than starting again.
    await coordinator.shutdown();
    database.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

// Imported as a library by the tests; run as a process, this is the entry point.
if (process.argv[1] && process.argv[1].endsWith('main.js')) {
  main().catch((error: unknown) => {
    console.error(`[coordinator] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
