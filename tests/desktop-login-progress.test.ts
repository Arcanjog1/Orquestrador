/**
 * The device code, from the CLI's stdout to the window's listener.
 *
 * Observed on the installed Windows build: the browser opened the right page,
 * the page asked for the nine-character code, and the dialog showed a spinner
 * and no code. The parser was right by then; the code was lost on its way to
 * the screen. So this file follows it across every boundary with the real
 * pieces on each side:
 *
 *   stand-in codex (writes the CLI's exact prompt to a pipe, in pieces)
 *   → CodexAccountManager, on a real ProcessManager
 *   → AccountService, on a real Database
 *   → EventBus `account:progress` payloads, exactly what the shell forwards
 *   → the preload's `api.events.accountProgress`, over a transport
 *
 * The last leg, the dialog itself, is covered in the Electron suite against
 * the real renderer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccountManager } from '../src/accounts/codex-account-manager.js';
import { ProcessManager } from '../src/process/process-manager.js';
import { ensureAppPaths } from '../src/runtime/paths.js';
import { Database } from '../src/database/database.js';
import type { RuntimeManager } from '../src/runtime/runtime-manager.js';
import { AccountService } from '../apps/desktop/src/main/services/account-service.js';
import { EventBus } from '../apps/desktop/src/main/events.js';
import { buildApi, type BridgeTransport } from '../apps/desktop/src/preload/bridge.js';
import type { AccountProgressEvent } from '../apps/desktop/src/shared/ipc-contract.js';

const ANSI_BLUE = '\x1b[94m';
const ANSI_GRAY = '\x1b[90m';
const ANSI_RESET = '\x1b[0m';

/** codex-cli 0.153.0, `login --device-auth`, byte for byte. */
const DEVICE_PROMPT =
  `\nWelcome to Codex [v${ANSI_GRAY}0.153.0${ANSI_RESET}]\n${ANSI_GRAY}OpenAI's command-line coding agent${ANSI_RESET}\n` +
  '\nFollow these steps to sign in with ChatGPT using device code authorization:\n' +
  `\n1. Open this link in your browser and sign in to your account\n   ${ANSI_BLUE}https://auth.openai.com/codex/device${ANSI_RESET}\n` +
  `\n2. Enter this one-time code ${ANSI_GRAY}(expires in 15 minutes)${ANSI_RESET}\n   ${ANSI_BLUE}ABCD-EFGH${ANSI_RESET}\n` +
  `\n${ANSI_GRAY}Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.${ANSI_RESET}\n`;

/** Cut where a pipe might cut it: after the URL, inside its reset sequence. */
const SPLIT_PROMPT: readonly string[] = [
  DEVICE_PROMPT.slice(0, DEVICE_PROMPT.indexOf('https://')) + 'https://auth.openai.com/codex/device\x1b[',
  `0m\n\n2. Enter this one-time code ${ANSI_GRAY}(expires in 15 minutes)${ANSI_RESET}\n   ${ANSI_BLUE}`,
  `ABCD-EFGH${ANSI_RESET}\n\n${ANSI_GRAY}Continue only if you started this login in Codex.${ANSI_RESET}\n`,
];

/**
 * Runs one sign-in through the real service and returns every payload the
 * EventBus published on `account:progress` - the objects the Electron shell
 * hands to `webContents.send`, untouched.
 */
async function signInThroughTheService(chunks: readonly string[]): Promise<{
  accountId: string;
  payloads: AccountProgressEvent[];
}> {
  const root = mkdtempSync(join(tmpdir(), 'lao-login-progress-'));
  const paths = ensureAppPaths({
    root,
    runtimes: join(root, 'runtimes'),
    profiles: join(root, 'profiles'),
    data: join(root, 'data'),
    logs: join(root, 'logs'),
    artifacts: join(root, 'artifacts'),
    updates: join(root, 'updates'),
    staging: join(root, 'staging'),
  });
  // The manager runs codex with the application root as its working
  // directory, so a script named `login` there is what `node login ...` runs.
  writeFileSync(
    join(root, 'login'),
    [
      "const args = process.argv.slice(2).join(' ');",
      "if (args === '--help') { console.log('  --device-auth'); process.exit(0); }",
      "if (args === 'status') { console.log('Not logged in'); process.exit(1); }",
      "if (args === '--device-auth') {",
      `  const chunks = ${JSON.stringify(chunks)}; let i = 0;`,
      '  const tick = () => { if (i < chunks.length) { process.stdout.write(chunks[i++]); setTimeout(tick, 250); } };',
      '  tick(); setTimeout(() => {}, 60_000);',
      '}',
    ].join('\n'),
    'utf8',
  );

  const processManager = new ProcessManager();
  const runtimeManager = {
    async getExecutablePath() {
      return process.execPath;
    },
  } as unknown as RuntimeManager;
  const manager = new CodexAccountManager({ runtimeManager, paths, processManager });
  const database = new Database({ paths });
  database.providers.ensureSeeded();
  const events = new EventBus();
  const payloads: AccountProgressEvent[] = [];
  events.subscribe((channel, payload) => {
    if (channel === 'account:progress') payloads.push(payload as AccountProgressEvent);
  });
  const service = new AccountService(database, { anthropic: manager, openai: manager }, events, () => {});

  try {
    const account = service.create('Codex Trabalho', 'openai');
    // The service has no timeout knobs - a person cancels. Give the stand-in
    // long enough to write every piece, then cancel, as closing the dialog does.
    const connecting = service.connect(account.id);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    service.cancelConnect(account.id);
    await connecting;
    return { accountId: account.id, payloads };
  } finally {
    await processManager.cancelAll(1000);
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('the code reaches the account:progress payloads, whole and clean, and leaves with the attempt', async () => {
  const { accountId, payloads } = await signInThroughTheService(SPLIT_PROMPT);

  const stages = payloads.map((p) => p.stage);
  assert.ok(stages.includes('awaiting-browser'), `stages: ${stages.join(', ')}`);
  assert.ok(stages.includes('waiting-for-completion'));
  assert.equal(stages[stages.length - 1], 'cancelled');

  // The code was published, on a waiting report, with the page beside it, and
  // never with an escape sequence in it.
  const carrying = payloads.filter((p) => p.code !== undefined);
  assert.ok(carrying.length > 0, 'at least one payload carries the code');
  for (const p of carrying) {
    assert.equal(p.accountId, accountId);
    assert.equal(p.code, 'ABCD-EFGH');
    assert.equal(p.url, 'https://auth.openai.com/codex/device');
    assert.doesNotMatch(p.code!, /\x1b/);
  }
  assert.ok(carrying.some((p) => p.stage === 'waiting-for-completion'));

  // The final report says the attempt is over and carries nothing to type.
  const last = payloads[payloads.length - 1]!;
  assert.equal(last.code, undefined);
  assert.equal(last.url, undefined);
});

test('the preload hands the very same payload to the window, code included', () => {
  // The transport the preload is built on: `invoke` for requests, `on` for
  // events. This one lets the test push what the main process would send.
  const listeners = new Map<string, (payload: unknown) => void>();
  const transport: BridgeTransport = {
    async invoke() {
      return { ok: true, value: null };
    },
    on(channel, listener) {
      listeners.set(channel, listener);
      return () => listeners.delete(channel);
    },
  };
  const api = buildApi(transport);

  const received: AccountProgressEvent[] = [];
  const stop = api.events.accountProgress((event) => received.push(event));

  const sent: AccountProgressEvent = {
    accountId: 'acc-1',
    stage: 'waiting-for-completion',
    label: 'Aguardando você concluir no navegador...',
    url: 'https://auth.openai.com/codex/device',
    code: 'ABCD-EFGH',
  };
  listeners.get('account:progress')!(sent);

  assert.deepEqual(received, [sent], 'nothing added, nothing dropped, on the way through the bridge');
  assert.equal(received[0]!.code, 'ABCD-EFGH');
  stop();
});
