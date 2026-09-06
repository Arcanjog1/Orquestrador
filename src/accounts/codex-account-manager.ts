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
 * What `codex login --device-auth` actually prints (0.153.0,
 * login/src/device_code_auth.rs) is a banner, then the verification URL and the
 * one-time code, each wrapped in ANSI colour codes - unconditionally, pipe or
 * terminal. Parsing therefore strips escape sequences first; without that the
 * URL handed to the browser ends in the reset sequence and the sign-in page
 * never loads, which is how this was found.
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

/**
 * How long a sign-in may take before the application gives up.
 *
 * A device code expires after fifteen minutes, so the CLI keeps polling for
 * that long. Giving up sooner would leave the CLI still able to complete a
 * login the application had already reported as failed.
 */
const DEVICE_CODE_TTL_MS = 15 * 60_000;

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
    const completionTimeoutMs = options.completionTimeoutMs ?? DEVICE_CODE_TTL_MS;

    // The sign-in process is stopped through its own signal, never through
    // `cancelAll`: the process manager is shared with everything else the
    // application runs, and a cancel there is sticky - every later process,
    // including the status check that would show this account connected, is
    // refused until restart.
    const login = new AbortController();
    if (options.signal?.aborted) login.abort();
    options.signal?.addEventListener('abort', () => login.abort(), { once: true });

    const running = this.processManager.run({
      command: executable,
      args,
      cwd: this.paths.root,
      env: this.buildEnvironment(account.id),
      timeoutMs: completionTimeoutMs,
      signal: login.signal,
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

    // What the person needs from the CLI's output - the page to open and the
    // one-time code to type there - read from everything received so far, not
    // from any single chunk: the two are printed together, but a pipe hands
    // them over in whatever pieces it likes, sometimes with an escape sequence
    // cut in half. Every progress report from here on carries both, so no one
    // event is load-bearing and a later report can only add what was missing.
    let reportedCode: string | null = null;
    const details = (): { url?: string; code?: string } => {
      const url = capturedUrl ?? extractUrl(output);
      // Not a secret - the page is useless without the account's own login -
      // but it is never written to a log or a database either.
      const code = extractDeviceCode(output);
      return { ...(url ? { url } : {}), ...(code ? { code } : {}) };
    };
    const waiting = (): void => {
      const known = details();
      if (known.code) reportedCode = known.code;
      report({
        accountId: account.id,
        phase: 'waiting-for-completion',
        message: 'Aguardando você concluir o login...',
        ...known,
      });
    };

    const urlDeadline = Date.now() + (options.urlTimeoutMs ?? 45_000);
    while (!capturedUrl && !settled && Date.now() < urlDeadline) {
      capturedUrl = extractUrl(output);
      if (capturedUrl) break;
      await sleep(200);
    }

    if (capturedUrl) {
      const known = details();
      if (known.code) reportedCode = known.code;
      report({
        accountId: account.id,
        phase: 'awaiting-browser',
        message: 'Abrindo o navegador para você entrar...',
        ...known,
      });
      await options.openUrl?.(capturedUrl);
    }

    waiting();

    // The code usually follows the URL within the same write; when it does not,
    // give it a few seconds at a fast cadence rather than the status check's
    // slower one, and report again as soon as it is there.
    const codeDeadline = Date.now() + 5_000;
    while (!reportedCode && !settled && Date.now() < codeDeadline && !options.signal?.aborted) {
      await sleep(200);
      if (extractDeviceCode(output)) waiting();
    }

    const completionDeadline = Date.now() + completionTimeoutMs;
    let status = await this.getStatus(account);
    while (
      status.state !== 'connected' &&
      Date.now() < completionDeadline &&
      !options.signal?.aborted
    ) {
      await sleep(2000);
      // Still worth a look on each pass: a code that only now appeared in the
      // output must still reach the interface.
      if (!reportedCode && extractDeviceCode(output)) waiting();
      status = await this.getStatus(account);
      if (settled && status.state !== 'connected') {
        status = await this.getStatus(account);
        break;
      }
    }

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

/**
 * Removes ANSI escape sequences (colours, cursor moves) from CLI output.
 *
 * Output is read as it streams, so the text may end in the middle of a
 * sequence - `ESC [` with the final byte still to come. That fragment is
 * dropped too; left in, its `[` would be taken for part of whatever precedes it.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*$/, '')
    .replace(/\x1b/g, '');
}

/**
 * The sign-in URL in some CLI output. Never logged: it can carry a code.
 *
 * Two rules, both learned from a pipe. An https URL is preferred over an http
 * one: the browser flow announces its local callback server
 * (`http://localhost:1455`) before the address the person must actually visit.
 * And a URL counts only once the character after it has arrived - the text
 * may end mid-address, and an address cut short is not one to open.
 */
export function extractUrl(text: string): string | null {
  const clean = stripAnsi(text);
  const all = clean.match(/https?:\/\/[^\s"'<>)\]\x00-\x1f]+(?=[\s"'<>)\]])/g) ?? [];
  const chosen = all.find((u) => u.startsWith('https://')) ?? all[0];
  return chosen ? chosen.replace(/[.,;]+$/, '') : null;
}

/**
 * The one-time code a device flow prints, when there is one.
 *
 * Read from the text with its colour codes removed: the CLI wraps the code in
 * them, and the escape sequence ends in a letter, so on the raw text there is
 * no word boundary in front of the code and nothing would match. As with the
 * URL, the code counts only once something follows it.
 */
export function extractDeviceCode(text: string): string | null {
  const match = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})(?=[\s.,;)\]"'])/.exec(stripAnsi(text));
  return match ? match[1]! : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
