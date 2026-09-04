/**
 * Codex accounts, isolated from each other and managed by the app.
 *
 * The same shape as `ClaudeAccountManager`, against a different CLI. Codex
 * reads its configuration from `CODEX_HOME`, so each account gets its own
 * directory under the application's private folder and the user never sees the
 * variable: they add "Codex Trabalho" and click Connect.
 *
 * Everything here was read from the installed binary rather than assumed:
 *
 *   codex login              browser sign-in
 *   codex login --device-auth   device-code sign-in, which suits a GUI
 *   codex login status          "Not logged in" until it is
 *   codex login --with-api-key       reads a key from stdin
 *   codex login --with-access-token  reads a token from stdin
 *
 * Two things this module refuses to get wrong, exactly as the Claude one does:
 * an ambient credential must never be reported as the account's own, and no
 * credential value is ever read or logged.
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
  type LoginProgress,
} from './account-types.js';

/**
 * The credential file Codex writes inside CODEX_HOME.
 *
 * Observed, not documented, so it is used only as positive evidence that the
 * account holds its own credential - never to read anything.
 */
const CREDENTIALS_FILENAME = 'auth.json';

/** What `codex login status` prints while signed out. */
const SIGNED_OUT = /not\s+logged\s+in/i;

export interface CodexAccountManagerOptions {
  runtimeManager: RuntimeManager;
  paths?: AppPaths;
  processManager?: ProcessManager;
}

export class CodexAccountManager {
  private readonly paths: AppPaths;
  private readonly processManager: ProcessManager;
  private readonly runtimeManager: RuntimeManager;

  constructor(options: CodexAccountManagerOptions) {
    this.runtimeManager = options.runtimeManager;
    this.paths = options.paths ?? appPaths();
    this.processManager = options.processManager ?? new ProcessManager();
    ensureAppPaths(this.paths);
  }

  /**
   * The configuration home for an account.
   *
   * Always absolute, and it must exist before the CLI is run: Codex refuses to
   * start when CODEX_HOME points at a path that is not there.
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

  createAccount(account: Account): Account {
    mkdirSync(this.profileDirectory(account.id), { recursive: true });
    return account;
  }

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
   * An OPENAI_API_KEY or CODEX_ACCESS_TOKEN inherited from the user's shell
   * would satisfy every profile at once, so both are deleted rather than
   * passed through.
   */
  buildEnvironment(accountId: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      CODEX_HOME: this.profileDirectory(accountId),
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
      executable = await this.runtimeManager.getExecutablePath('codex');
    } catch {
      return {
        ...base,
        state: 'runtime-missing',
        problem: 'O Codex ainda não está configurado.',
        remedy: 'Configurar automaticamente',
      };
    }

    mkdirSync(this.profileDirectory(account.id), { recursive: true });
    const result = await this.processManager.run({
      command: executable,
      args: ['login', 'status'],
      cwd: this.paths.root,
      env: this.buildEnvironment(account.id),
      timeoutMs: 60_000,
    });

    if (result.outcome !== 'completed') {
      return {
        ...base,
        state: 'disconnected',
        problem: 'Não foi possível verificar esta conta.',
        remedy: 'Conectar novamente',
      };
    }

    const output = `${result.stdout}\n${result.stderr}`;
    if (SIGNED_OUT.test(output)) {
      return { ...base, state: 'disconnected', remedy: 'Conectar conta' };
    }

    // Signed in - but by whose credential? The environment was stripped, so a
    // logged-in answer should come from this profile. If it holds no credential
    // of its own, something outside it is satisfying the CLI, and calling that
    // connected would silently share one login between accounts.
    if (!this.hasOwnCredentials(account.id)) {
      return {
        ...base,
        state: 'ambient-credential',
        problem:
          'Entrou com uma credencial que não é desta conta. Conecte novamente para isolá-la.',
        remedy: 'Conectar conta',
      };
    }

    return { ...base, state: 'connected', authMethod: 'oauth' };
  }

  /**
   * Signs in, driven entirely by the application.
   *
   * Uses `--device-auth` when the build offers it: a device-code flow prints a
   * URL and waits, which is exactly what a window with no terminal needs. The
   * browser is opened by the application, and completion is detected by polling
   * `login status` rather than by scraping the CLI's output.
   */
  async connect(
    account: Account,
    options: {
      onProgress?: (progress: LoginProgress) => void;
      openUrl?: (url: string) => void | Promise<void>;
      signal?: AbortSignal;
      urlTimeoutMs?: number;
      completionTimeoutMs?: number;
    } = {},
  ): Promise<AccountStatus> {
    const report = options.onProgress ?? (() => {});
    const executable = await this.runtimeManager.getExecutablePath('codex');
    const home = this.profileDirectory(account.id);
    mkdirSync(home, { recursive: true });

    report({
      accountId: account.id,
      phase: 'starting',
      message: `Conectando ${account.displayName}...`,
    });

    const args = (await this.supportsDeviceAuth(executable))
      ? ['login', '--device-auth']
      : ['login'];

    let output = '';
    let capturedUrl: string | null = null;

    const running = this.processManager.run({
      command: executable,
      args,
      cwd: this.paths.root,
      env: this.buildEnvironment(account.id),
      timeoutMs: options.completionTimeoutMs ?? 600_000,
      ...(options.signal ? { signal: options.signal } : {}),
      onStdout: (chunk) => {
        output += chunk;
      },
      onStderr: (chunk) => {
        output += chunk;
      },
    });

    let settled = false;
    void running.then(() => {
      settled = true;
    });

    const urlDeadline = Date.now() + (options.urlTimeoutMs ?? 45_000);
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
        // A device flow shows a short code the user must confirm; it is not a
        // secret, and without it the browser page cannot be completed.
        ...(extractDeviceCode(output) ? { code: extractDeviceCode(output)! } : {}),
      });
      await options.openUrl?.(capturedUrl);
    }

    report({
      accountId: account.id,
      phase: 'waiting-for-completion',
      message: 'Aguardando você concluir o login...',
    });

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
        status = await this.getStatus(account);
        break;
      }
    }

    if (!settled) await this.processManager.cancelAll(3000);
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

  /** Reads `codex login --help` rather than assuming the flag exists. */
  private async supportsDeviceAuth(executable: string): Promise<boolean> {
    const result = await this.processManager.run({
      command: executable,
      args: ['login', '--help'],
      cwd: this.paths.root,
      timeoutMs: 30_000,
    });
    if (result.outcome !== 'completed') return false;
    return /--device-auth\b/.test(`${result.stdout}\n${result.stderr}`);
  }
}

/** First http(s) URL in some CLI output. Never logged: it can carry a code. */
export function extractUrl(text: string): string | null {
  const match = /https?:\/\/[^\s"'<>)\]]+/.exec(text);
  return match ? match[0].replace(/[.,;]+$/, '') : null;
}

/** The short confirmation code a device flow prints, when there is one. */
export function extractDeviceCode(text: string): string | null {
  const match = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text);
  return match ? match[1]! : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
