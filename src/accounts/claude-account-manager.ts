/**
 * Claude Code accounts, isolated from each other and managed by the app.
 *
 * Each account gets its own configuration home under the application's private
 * folder, exported to the CLI as CLAUDE_CONFIG_DIR. The user never sees that
 * variable: they add "Claude Trabalho" and "Claude Pessoal" and click Connect.
 *
 * Two things this module refuses to get wrong:
 *
 *  1. **Ambient credentials.** The CLI can report being signed in while holding
 *     no credential of its own, because a token in the environment satisfies it.
 *     Both accounts would then look connected through the *same* login. That is
 *     reported as `ambient-credential`, never as connected.
 *  2. **Leaking secrets.** Credential files are checked for existence only, and
 *     never opened. The sign-in URL is passed to the caller but never logged.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ProcessManager } from '../process/process-manager.js';
import { SENSITIVE_ENV_KEYS } from '../security/secret-redactor.js';
import { accountProfileDir, appPaths, ensureAppPaths, type AppPaths } from '../runtime/paths.js';
import type { RuntimeManager } from '../runtime/runtime-manager.js';
import {
  AccountError,
  type Account,
  type AccountStatus,
  type AuthState,
  type LoginProgress,
} from './account-types.js';

/** Shape of `claude auth status --json`, as far as this module relies on it. */
interface ClaudeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  /** Derived from the configuration home, so it proves which profile was used. */
  projectsDirectory?: string;
}

const CREDENTIALS_FILENAME = '.credentials.json';

export interface ClaudeAccountManagerOptions {
  runtimeManager: RuntimeManager;
  paths?: AppPaths;
  processManager?: ProcessManager;
}

export class ClaudeAccountManager {
  private readonly paths: AppPaths;
  private readonly processManager: ProcessManager;
  private readonly runtimeManager: RuntimeManager;

  constructor(options: ClaudeAccountManagerOptions) {
    this.runtimeManager = options.runtimeManager;
    this.paths = options.paths ?? appPaths();
    this.processManager = options.processManager ?? new ProcessManager();
    ensureAppPaths(this.paths);
  }

  /**
   * The configuration home for an account.
   *
   * Always absolute: the Claude Code CLI rejects a relative CLAUDE_CONFIG_DIR.
   */
  profileDirectory(accountId: string): string {
    const dir = accountProfileDir(accountId, this.paths);
    if (!isAbsolute(dir)) {
      throw new AccountError(
        accountId,
        'Não foi possível preparar a pasta desta conta.',
        'Tentar novamente',
        'the resolved profile directory is not absolute',
      );
    }
    return dir;
  }

  /** Creates an account's private folder. Safe to call repeatedly. */
  createAccount(account: Account): Account {
    mkdirSync(this.profileDirectory(account.id), { recursive: true });
    return account;
  }

  /**
   * Removes an account's folder, and with it its stored credentials.
   *
   * Only ever touches paths inside the application's own profiles directory.
   */
  removeAccount(accountId: string): void {
    const dir = this.profileDirectory(accountId);
    if (!dir.startsWith(this.paths.profiles)) {
      throw new AccountError(
        accountId,
        'Não foi possível remover esta conta.',
        'Tentar novamente',
        'refusing to delete a path outside the application profiles folder',
      );
    }
    rmSync(dir, { recursive: true, force: true });
  }

  /** Account ids that have a folder on disk. */
  listProfileDirectories(): string[] {
    if (!existsSync(this.paths.profiles)) return [];
    return readdirSync(this.paths.profiles, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  /**
   * The environment for a child process acting as this account.
   *
   * Sensitive variables are deleted rather than passed through: an
   * ANTHROPIC_API_KEY inherited from the user's shell would override the
   * account's own credential and quietly collapse the isolation.
   */
  buildEnvironment(accountId: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      CLAUDE_CONFIG_DIR: this.profileDirectory(accountId),
    };
    for (const key of SENSITIVE_ENV_KEYS) env[key] = undefined;
    return env;
  }

  /** True when the account holds a credential file of its own. Never read. */
  hasOwnCredentials(accountId: string): boolean {
    return existsSync(join(this.profileDirectory(accountId), CREDENTIALS_FILENAME));
  }

  /** Checks one account's authentication, without touching any other. */
  async getStatus(account: Account): Promise<AccountStatus> {
    const checkedAt = new Date().toISOString();
    const base = { accountId: account.id, displayName: account.displayName, checkedAt };

    let executable: string;
    try {
      executable = await this.runtimeManager.getExecutablePath('claude-code');
    } catch {
      return {
        ...base,
        state: 'runtime-missing',
        problem: 'Claude Code ainda não está configurado.',
        remedy: 'Configurar automaticamente',
      };
    }

    const status = await this.readAuthStatus(executable, account.id);

    if (!status?.loggedIn) {
      return {
        ...base,
        state: 'disconnected',
        ...(status?.authMethod ? { authMethod: status.authMethod } : {}),
        problem: `${account.displayName} não está conectada.`,
        remedy: 'Conectar',
      };
    }

    // Signed in, but with whose credential? An account with no credential file
    // of its own is riding on something ambient, and is not isolated.
    if (!this.hasOwnCredentials(account.id)) {
      return {
        ...base,
        state: 'ambient-credential',
        ...(status.authMethod ? { authMethod: status.authMethod } : {}),
        problem:
          `${account.displayName} está usando uma credencial do sistema, não a própria. ` +
          'Contas separadas podem acabar usando o mesmo login.',
        remedy: 'Conectar novamente',
      };
    }

    return {
      ...base,
      state: 'connected',
      ...(status.authMethod ? { authMethod: status.authMethod } : {}),
    };
  }

  /**
   * Confirms an invocation really used this account's configuration home.
   *
   * `projectsDirectory` is derived from CLAUDE_CONFIG_DIR, so it settles the
   * question without going anywhere near a credential.
   */
  async verifyProfileInUse(account: Account): Promise<boolean> {
    let executable: string;
    try {
      executable = await this.runtimeManager.getExecutablePath('claude-code');
    } catch {
      return false;
    }
    const status = await this.readAuthStatus(executable, account.id);
    const projects = status?.projectsDirectory;
    if (!projects) return false;
    return normalisePath(projects).startsWith(normalisePath(this.profileDirectory(account.id)));
  }

  /**
   * Signs in, driven entirely by the application.
   *
   * The CLI is spawned with piped stdio - an Electron app has no terminal to
   * give it - and the sign-in URL it prints is handed back through `onProgress`
   * so the app can open the system browser. Completion is detected by polling
   * `auth status --json`, so nothing has to scrape the terminal.
   */
  async connect(
    account: Account,
    options: {
      onProgress?: (progress: LoginProgress) => void;
      /** Opens the URL for the user. Injected so it is testable. */
      openUrl?: (url: string) => void | Promise<void>;
      signal?: AbortSignal;
      urlTimeoutMs?: number;
      completionTimeoutMs?: number;
    } = {},
  ): Promise<AccountStatus> {
    const report = options.onProgress ?? (() => {});
    const executable = await this.runtimeManager.getExecutablePath('claude-code');
    const configDir = this.profileDirectory(account.id);
    mkdirSync(configDir, { recursive: true });

    report({ accountId: account.id, phase: 'starting', message: `Conectando ${account.displayName}...` });

    let output = '';
    let capturedUrl: string | null = null;

    // The sign-in process is stopped through its own signal, never through
    // `cancelAll`: the process manager is shared with everything else the
    // application runs, and a cancel there is sticky.
    const login = new AbortController();
    if (options.signal?.aborted) login.abort();
    options.signal?.addEventListener('abort', () => login.abort(), { once: true });

    const running = this.processManager.run({
      command: executable,
      args: ['auth', 'login'],
      cwd: this.paths.root,
      env: this.buildEnvironment(account.id),
      timeoutMs: options.completionTimeoutMs ?? 600_000,
      signal: login.signal,
      onStdout: (chunk) => {
        output += chunk;
      },
      onStderr: (chunk) => {
        output += chunk;
      },
    });

    // Wait for the CLI to print a sign-in URL.
    const urlDeadline = Date.now() + (options.urlTimeoutMs ?? 45_000);
    let settled = false;
    void running.then(() => {
      settled = true;
    });

    while (!capturedUrl && !settled && Date.now() < urlDeadline) {
      capturedUrl = extractUrl(output);
      if (capturedUrl) break;
      await sleep(200);
    }

    if (capturedUrl) {
      report({
        accountId: account.id,
        phase: 'awaiting-browser',
        message: 'Abrindo o navegador para você entrar...',
        url: capturedUrl,
      });
      await options.openUrl?.(capturedUrl);
    }

    report({
      accountId: account.id,
      phase: 'waiting-for-completion',
      message: 'Aguardando você concluir o login...',
    });

    // Poll for completion rather than parsing the CLI's terminal output.
    const completionDeadline = Date.now() + (options.completionTimeoutMs ?? 300_000);
    let status = await this.getStatus(account);
    while (
      status.state !== 'connected' &&
      Date.now() < completionDeadline &&
      !options.signal?.aborted
    ) {
      await sleep(2000);
      status = await this.getStatus(account);
      if (settled && status.state !== 'connected') {
        // The CLI exited without completing: one more check, then give up.
        status = await this.getStatus(account);
        break;
      }
    }

    // Never leave a sign-in process running - and stop only this one. The
    // process manager is shared with everything else the application runs; a
    // `cancelAll` here was sticky and refused every later process, including
    // the status check that would have shown the account connected.
    if (!settled) login.abort();
    await running.catch(() => undefined);

    if (status.state === 'connected') {
      report({
        accountId: account.id,
        phase: 'connected',
        message: `${account.displayName} conectada`,
      });
      return status;
    }

    if (options.signal?.aborted) {
      report({ accountId: account.id, phase: 'cancelled', message: 'Conexão cancelada.' });
      return status;
    }

    report({
      accountId: account.id,
      phase: 'failed',
      message: status.problem ?? `Não foi possível conectar ${account.displayName}.`,
    });
    return status;
  }

  private async readAuthStatus(
    executable: string,
    accountId: string,
  ): Promise<ClaudeAuthStatus | null> {
    const result = await this.processManager.run({
      command: executable,
      args: ['auth', 'status', '--json'],
      cwd: this.paths.root,
      env: this.buildEnvironment(accountId),
      timeoutMs: 60_000,
    });
    if (result.outcome !== 'completed') return null;
    return parseJsonObject(result.stdout) as ClaudeAuthStatus | null;
  }
}

/** Whether a status means the account can actually be used for work. */
export function isUsable(state: AuthState): boolean {
  return state === 'connected';
}

function normalisePath(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function extractUrl(text: string): string | null {
  const match = /https?:\/\/[^\s"'<>]+/.exec(text);
  return match ? match[0] : null;
}

/** Finds the first balanced JSON object; CLI output is often multi-line. */
function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
