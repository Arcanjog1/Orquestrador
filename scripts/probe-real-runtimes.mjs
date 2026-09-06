/**
 * Installs the real runtimes, from the real internet, and reports what happened.
 *
 * This is the proof the unit tests cannot give. It drives the actual
 * `RuntimeManager` install pipeline - resolve, download, verify SHA-256,
 * extract, capability check, promote, health check - against the live release
 * feeds, into a throwaway app root, and then asks the installed binaries what
 * they can actually do.
 *
 * Nothing here is a mock. If it passes on a Windows runner, the application can
 * prepare that runtime on a user's machine.
 *
 * Usage:
 *   node scripts/probe-real-runtimes.mjs [--runtime codex] [--runtime claude-code]
 *   node scripts/probe-real-runtimes.mjs --capabilities-only
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const load = (relative) => import(new URL(relative, dist).href);

// `npm run build` emits with rootDir `src`, so dist mirrors src without it.
const { RuntimeManager } = await load('runtime/runtime-manager.js');
const { ProcessManager } = await load('process/process-manager.js');
const { appPaths, ensureAppPaths } = await load('runtime/paths.js');

const argv = process.argv.slice(2);
const requested = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--runtime' && argv[i + 1]) requested.push(argv[i + 1]);
}
const runtimes = requested.length > 0 ? requested : ['codex', 'claude-code'];
/** Also drive the product's adapter against the binary it just installed. */
const withAdapters = argv.includes('--adapters');

/**
 * The adapters, loaded from the desktop build.
 *
 * Only needed for `--adapters`, and only meaningful once `npm run
 * desktop:build` has run, so the import is lazy and its absence is reported
 * rather than thrown.
 */
async function loadAdapters() {
  const base = new URL('../apps/desktop/dist/apps/desktop/src/main/adapters/', import.meta.url);
  try {
    const claude = await import(new URL('claude-adapter.js', base).href);
    const codex = await import(new URL('codex-adapter.js', base).href);
    return { ClaudeCodeAdapter: claude.ClaudeCodeAdapter, CodexAdapter: codex.CodexAdapter };
  } catch (error) {
    console.log(`# adapters unavailable (build the desktop app first): ${error?.message ?? error}`);
    return null;
  }
}

const { probeCodexCatalog } = await import('./probe-codex-catalog.mjs');

const home = mkdtempSync(join(tmpdir(), 'lao-probe-'));
const paths = ensureAppPaths(appPaths({ ...process.env, AI_ORCHESTRATOR_HOME: home }));
const processManager = new ProcessManager();

/** Flags and subcommands the adapters actually rely on. */
const SUBCOMMAND_HELP = { codex: ['exec'] };

/**
 * Extra invocations that prove the adapter's real code path.
 *
 * For Claude the question is not "is this machine signed in" - CI never will
 * be - but "can the application drive the CLI and read its answer". A clean
 * exit with parseable JSON, or a clearly-reported unauthenticated state, both
 * count as the invocation working.
 */
const POST_INSTALL_CHECKS = {
  'claude-code': [{ label: 'auth status --json', args: ['auth', 'status', '--json'] }],
};

/** Flags the adapter would use, read from the subcommand's own help page. */
const SUBCOMMAND_FLAGS = {
  codex: [
    '--json',
    '--experimental-json',
    '--output-schema',
    '--skip-git-repo-check',
    '--sandbox',
    '--full-auto',
    '--cd',
    '--model',
  ],
};

const CAPABILITIES_OF_INTEREST = {
  codex: ['exec', '--json', '--output-schema', '--skip-git-repo-check', '--experimental-json'],
  'claude-code': ['--print', '--permission-mode', '--output-format', '--append-system-prompt'],
};

const results = [];
let failed = 0;

for (const runtimeId of runtimes) {
  const result = { runtimeId, ok: false, steps: [] };
  results.push(result);
  const say = (label, value) => result.steps.push([label, value]);

  try {
    const manager = new RuntimeManager({ paths });
    const runtime = manager.get(runtimeId);

    console.log(`\n=== ${runtimeId} ===`);
    const phases = [];
    const started = Date.now();
    const install = await manager.install(runtimeId, (p) => {
      const last = phases[phases.length - 1];
      if (last !== p.phase) {
        phases.push(p.phase);
        console.log(`  [${p.phase}] ${p.message}`);
      }
    });

    const m = install.manifest;
    say('source', `${m.sourceId} (${m.sourceLabel})`);
    say('contract', m.contract);
    say('host', m.host);
    say('asset url', m.url);
    say('version', m.version);
    say('platform/arch', `${m.platform}/${m.arch}`);
    say('bytes', String(m.bytes));
    say('sha256 (computed)', m.sha256);
    say('integrity strategy', m.integrity.strategy);
    say('integrity verified', String(m.integrity.verified));
    say('integrity detail', m.integrity.detail);
    say('trust level', m.trustLevel);
    say('executable', install.executablePath);
    say('health', install.health.healthy ? 'PASS' : `FAIL - ${install.health.problem ?? ''}`);
    say('elapsed ms', String(Date.now() - started));

    if (!m.integrity.verified) throw new Error('integrity was not verified');
    if (!install.health.healthy) throw new Error('health check failed');

    // What the binary really is, and what it really offers.
    const version = await processManager.run({
      command: install.executablePath,
      args: ['--version'],
      cwd: home,
      timeoutMs: 120_000,
    });
    say('--version exit', String(version.exitCode));
    say('--version output', `${version.stdout}${version.stderr}`.trim().split(/\r?\n/)[0] ?? '');

    const help = await processManager.run({
      command: install.executablePath,
      args: ['--help'],
      cwd: home,
      timeoutMs: 120_000,
    });
    const helpText = `${help.stdout}\n${help.stderr}`;
    say('--help exit', String(help.exitCode));

    const found = [];
    const missing = [];
    for (const token of CAPABILITIES_OF_INTEREST[runtimeId] ?? []) {
      // A subcommand appears on its own indented line; a flag appears verbatim.
      const present = token.startsWith('--')
        ? new RegExp(`\\s${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(helpText)
        : new RegExp(`^\\s{2,}${token}\\b`, 'm').test(helpText);
      (present ? found : missing).push(token);
    }
    say('capabilities present', found.join(', ') || '(none)');
    say('capabilities absent', missing.join(', ') || '(none)');

    // A subcommand's flags do not appear in the top-level help. The adapter
    // drives `codex exec`, so that is the help page whose flags matter.
    for (const sub of SUBCOMMAND_HELP[runtimeId] ?? []) {
      if (!new RegExp(`^\\s{2,}${sub}\\b`, 'm').test(helpText)) continue;
      const subHelp = await processManager.run({
        command: install.executablePath,
        args: [sub, '--help'],
        cwd: home,
        timeoutMs: 120_000,
      });
      const subText = `${subHelp.stdout}\n${subHelp.stderr}`;
      const subFound = [];
      for (const token of SUBCOMMAND_FLAGS[runtimeId] ?? []) {
        if (new RegExp(`\\s${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(subText)) {
          subFound.push(token);
        }
      }
      say(`${sub} flags present`, subFound.join(', ') || '(none)');
      if (process.env.AI_ORCHESTRATOR_PROBE_DUMP_HELP === '1') {
        console.log(`\n----- ${runtimeId} ${sub} --help -----\n${subText}\n-----`);
      }
    }

    // The incident check: the binary the application just installed is put
    // in front of a model catalogue that carries `max` and `ultra`, as the
    // real backend serves, and must accept it and complete a structured turn.
    if (runtimeId === 'codex') {
      const catalogue = await probeCodexCatalog(install.executablePath);
      say('catalogue with max: unknown variant', String(catalogue.unknownVariant));
      say('catalogue with max: catalogue requested', String(catalogue.catalogueRequested));
      say('catalogue with max: turn completed', String(catalogue.turnRequested && catalogue.producedDecision));
      say('catalogue with max: exit', `${catalogue.exitCode}`);
      for (const line of catalogue.stderrTail.slice(-3)) say('catalogue with max: stderr', line);
      if (!catalogue.pass) throw new Error('the installed Codex did not survive a catalogue with max');
    }

    for (const check of POST_INSTALL_CHECKS[runtimeId] ?? []) {
      const outcome = await processManager.run({
        command: install.executablePath,
        args: check.args,
        cwd: home,
        timeoutMs: 120_000,
      });
      const text = `${outcome.stdout}${outcome.stderr}`.trim();
      let shape = 'not JSON';
      try {
        const parsed = JSON.parse(text);
        shape = `JSON with keys: ${Object.keys(parsed).join(', ') || '(none)'}`;
      } catch {
        /* left as "not JSON" */
      }
      // The invocation is what is being proved. A non-zero exit because nobody
      // is signed in is a correct answer, not a failure of the plumbing.
      const invoked = outcome.outcome === 'completed';
      say(`${check.label}`, `${invoked ? 'INVOKED' : outcome.outcome}, exit ${outcome.exitCode}`);
      say(`${check.label} shape`, shape);
      say(`${check.label} first line`, text.split(/\r?\n/)[0]?.slice(0, 200) ?? '');
      if (!invoked) throw new Error(`${check.label} could not be invoked`);
    }

    // Drive the product's own adapter against the binary just installed. The
    // point is the plumbing - argv, stdin, environment, and what the adapter
    // makes of an answer - not whether a model replied. Nothing here is
    // authenticated, and an unauthenticated answer is a correct answer.
    if (withAdapters) {
      const adapters = await loadAdapters();
      const Adapter =
        runtimeId === 'claude-code' ? adapters?.ClaudeCodeAdapter : adapters?.CodexAdapter;
      if (Adapter) {
        const adapter = new Adapter({
          processManager,
          resolveExecutable: async () => install.executablePath,
          buildEnvironment: () => ({}),
          ...(runtimeId === 'codex' ? { outputSchema: { type: 'object' } } : {}),
        });

        const started = Date.now();
        // Short on purpose. Without credentials these CLIs do not fail fast -
        // Codex sits on "Reading prompt from stdin..." until something stops
        // it - and the question here is whether the adapter can drive them,
        // which is answered in the first seconds.
        const agentResult = await adapter.run({
          prompt: 'Responda apenas: ok',
          workingDirectory: home,
          timeoutMs: 30_000,
          runId: 'probe',
          iteration: 1,
        });

        // `completed` means the adapter built a real invocation and the CLI
        // answered it. A non-zero exit because nobody is signed in is exactly
        // the state the interface has to recognise.
        say('adapter outcome', `${agentResult.outcome}, exit ${agentResult.exitCode}`);
        say('adapter elapsed ms', String(Date.now() - started));
        const firstLine = `${agentResult.stdout}${agentResult.stderr}`
          .trim()
          .split(/\r?\n/)[0]
          ?.slice(0, 200);
        say('adapter first line', firstLine ?? '(no output)');
        if (agentResult.outcome === 'spawn-error') {
          throw new Error(`the adapter could not launch ${runtimeId}`);
        }
        say('adapter invocation', 'PASS');
      }
    }

    result.ok = true;
    result.helpText = helpText;
  } catch (error) {
    failed += 1;
    result.error = error?.userMessage ?? error?.message ?? String(error);
    result.steps.push(['error', result.error]);
    // `detail` carries why each source declined, which is the whole point of a
    // diagnostic: "could not prepare it" alone tells nobody anything.
    if (error?.detail) result.steps.push(['detail', String(error.detail)]);
  }
}

console.log('\n======================================================================');
console.log('REAL RUNTIME PROBE');
console.log('======================================================================');
for (const result of results) {
  console.log(`\n${result.runtimeId.toUpperCase()}: ${result.ok ? 'PASS' : 'FAIL'}`);
  for (const [label, value] of result.steps) {
    console.log(`  ${label.padEnd(20)} ${value}`);
  }
}
console.log(`\n# pass ${results.length - failed}`);
console.log(`# fail ${failed}`);

try {
  await processManager.cancelAll();
  rmSync(home, { recursive: true, force: true });
} catch {
  /* teardown must not change the verdict */
}

process.exit(failed === 0 ? 0 : 1);
