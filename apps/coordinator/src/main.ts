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
import { RunStore } from '../../../src/cloud/coordinator/store.js';
import { createCoordinatorServer } from './http.js';
import { Reaper } from './reaper.js';
import { ContainerWorkspaceProvisioner } from '../../../src/cloud/container-provisioner.js';
import { GitHubAppRepositoryAccess } from '../../../src/cloud/github-app-access.js';
import { GitHubClient } from '../../../src/github/github-client.js';
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

/**
 * Issues a device token, and prints it once.
 *
 * A separate command rather than a route: minting a credential must not be
 * something a request can ask for, only something a person with access to the
 * host can do.
 *
 * The token is shown once and then only its hash is kept, so this output is
 * the single moment it exists in readable form. Losing it means issuing
 * another, which is the correct trade.
 */
async function issueToken(label: string): Promise<void> {
  const database = new Database({ filePath: process.env.ORQ_DATABASE_FILE ?? undefined });
  try {
    const store = new RunStore(database);
    const principalName = process.env.ORQ_PRINCIPAL ?? label;
    // One principal per person; more devices for the same person reuse it, so
    // a second computer sees the same runs rather than an empty history.
    const existing = database.driver.get<{ id: string; display_name: string; tenant_id: string; status: string; created_at: string }>(
      'SELECT * FROM principals WHERE display_name = ? AND status = \'active\'',
      [principalName],
    );
    const principal = existing ?? store.createPrincipal({ displayName: principalName });
    const issued = store.issueSession({ principalId: principal.id, label });

    console.log('');
    console.log(`  Pessoa:      ${principal.display_name} (${principal.id})`);
    console.log(`  Dispositivo: ${label} (${issued.id})`);
    console.log('');
    console.log('  Cole isto em Configurações → Nuvem, no aplicativo:');
    console.log('');
    console.log(`    ${issued.token}`);
    console.log('');
    console.log('  Ele é mostrado uma única vez. Só o hash fica guardado aqui,');
    console.log('  então nem este servidor consegue lê-lo de novo.');
    console.log('');
  } finally {
    database.close();
  }
}

export async function main(): Promise<void> {
  // `issue-token <rótulo>` before anything else: it needs the database and
  // nothing else, so it must not be blocked by a missing workspace image.
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'issue-token') {
    const label = rest.join(' ').trim();
    if (!label) throw new Error('uso: issue-token "<nome do dispositivo>"');
    return issueToken(label);
  }

  const database = new Database({ filePath: process.env.ORQ_DATABASE_FILE ?? undefined });

  const limits: WorkspaceLimits = {
    cpus: positive('ORQ_LIMIT_CPUS', DEFAULT_LIMITS.cpus),
    memoryMb: positive('ORQ_LIMIT_MEMORY_MB', DEFAULT_LIMITS.memoryMb),
    diskMb: positive('ORQ_LIMIT_DISK_MB', DEFAULT_LIMITS.diskMb),
    maxLifetimeMs: positive('ORQ_LIMIT_LIFETIME_MS', DEFAULT_LIMITS.maxLifetimeMs),
    idleTimeoutMs: positive('ORQ_LIMIT_IDLE_MS', DEFAULT_LIMITS.idleTimeoutMs),
    // Unset means no restriction is *requested*. Setting it is a requirement,
    // and the container provisioner refuses rather than accepting one it
    // cannot enforce - see WORKSPACE_EGRESS_HOSTS for what to allow in a host
    // firewall instead.
    allowedHosts: process.env.ORQ_ALLOWED_HOSTS
      ? process.env.ORQ_ALLOWED_HOSTS.split(',').map((host) => host.trim()).filter(Boolean)
      : null,
  };

  // One access object, shared by the clone and the publish: it caches the
  // installation lookup, and a token is minted per repository and per scope.
  const repositoryAccess = new GitHubAppRepositoryAccess({
    appId: required('ORQ_GITHUB_APP_ID'),
    // From the deployment's secret store. Never from a repository, and never
    // copied from anybody's desktop.
    privateKeyPem: required('ORQ_GITHUB_APP_PRIVATE_KEY'),
  });

  const provisioner = new ContainerWorkspaceProvisioner({
    host: new ProcessManager(),
    runtimeCommand: process.env.ORQ_CONTAINER_RUNTIME ?? 'docker',
    image: required('ORQ_WORKSPACE_IMAGE'),
    repositoryAccess,
  });

  const coordinator = new Coordinator({
    database,
    provisioner,
    repositoryAccess,
    // The same GitHub client the desktop uses, driven with the installation
    // token rather than with anyone's personal login.
    pullRequests: new GitHubClient(),
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
