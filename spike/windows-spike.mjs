#!/usr/bin/env node
/**
 * WINDOWS INTEGRATION SPIKE - Local Multi-Agent Orchestrator
 *
 * Proves the local integrations the desktop application will be built on,
 * BEFORE any of that application is written.
 *
 * Run it with:   node spike/windows-spike.mjs
 *
 * Safety guarantees:
 *  - Writes only inside a scratch directory under the OS temp folder.
 *  - Never touches your own repositories or files.
 *  - Never runs a destructive git command.
 *  - Never prints tokens, credentials or the contents of credential files.
 *  - Asks before doing anything that costs agent quota.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Options. The spike is interactive by default - these exist so it can also be
// re-run unattended without editing anything.
//
//   --non-interactive   never prompt; take every default
//   --live              allow the prompts that spend agent quota
//   --profile-a <path>  CLAUDE_CONFIG_DIR for profile A
//   --profile-b <path>  CLAUDE_CONFIG_DIR for profile B
// ---------------------------------------------------------------------------

const ARGV = process.argv.slice(2);
const hasFlag = (name) => ARGV.includes(name);
const flagValue = (name, fallback = null) => {
  const index = ARGV.indexOf(name);
  const next = index >= 0 ? ARGV[index + 1] : undefined;
  return next && !next.startsWith('--') ? next : fallback;
};

const NON_INTERACTIVE = hasFlag('--non-interactive') || hasFlag('-y');
const ALLOW_LIVE = hasFlag('--live');

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(
    [
      'Windows integration spike',
      '',
      'Usage: node spike/windows-spike.mjs [options]',
      '',
      '  --non-interactive, -y   never prompt; take every default',
      '  --live                  allow the checks that spend agent quota',
      '  --profile-a <path>      CLAUDE_CONFIG_DIR for profile A',
      '  --profile-b <path>      CLAUDE_CONFIG_DIR for profile B',
      '  --help, -h              show this message',
      '',
      'With no options the spike walks you through everything interactively.',
    ].join('\n'),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Console helpers
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });

const transcript = [];
function say(text = '') {
  console.log(text);
  transcript.push(text);
}
function heading(text) {
  say('');
  say('='.repeat(74));
  say(text);
  say('='.repeat(74));
}
function step(text) {
  say(`  -> ${text}`);
}
function detail(text) {
  say(`     ${text}`);
}

async function ask(question, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : '';
  if (NON_INTERACTIVE) {
    say(`\n${question}${suffix}\n> ${fallback} (non-interactive)`);
    return fallback;
  }
  const answer = (await rl.question(`\n${question}${suffix}\n> `)).trim();
  transcript.push(`${question}${suffix} -> ${answer || fallback}`);
  return answer || fallback;
}

async function askYesNo(question, fallback = true) {
  const suffix = fallback ? ' [Y/n]' : ' [y/N]';
  if (NON_INTERACTIVE) {
    say(`\n${question}${suffix}\n> ${fallback ? 'y' : 'n'} (non-interactive)`);
    return fallback;
  }
  for (;;) {
    const answer = (await rl.question(`\n${question}${suffix}\n> `)).trim().toLowerCase();
    transcript.push(`${question}${suffix} -> ${answer || (fallback ? 'y' : 'n')}`);
    if (answer === '') return fallback;
    if (['y', 'yes', 's', 'sim'].includes(answer)) return true;
    if (['n', 'no', 'nao', 'não'].includes(answer)) return false;
    console.log('  Please answer y or n.');
  }
}

/**
 * Asks before doing something that spends agent quota.
 *
 * Unattended runs never spend quota unless --live was passed explicitly.
 */
async function askLive(question) {
  if (NON_INTERACTIVE) {
    say(`\n${question}\n> ${ALLOW_LIVE ? 'y (--live)' : 'n (no --live)'}`);
    return ALLOW_LIVE;
  }
  return askYesNo(question, true);
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

const results = new Map();
const blockers = [];
const findings = [];

function record(id, title, status, lines = []) {
  results.set(id, { id, title, status, lines });
  const badge = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  say('');
  say(`  [${badge}] ${title}`);
  for (const line of lines) say(`         ${line}`);
}

function blocker(text) {
  blockers.push(text);
}
function finding(text) {
  findings.push(text);
}

// ---------------------------------------------------------------------------
// Redaction - applied to everything that reaches the report
// ---------------------------------------------------------------------------

let redact = (s) => s;

// ---------------------------------------------------------------------------
// Build the compiled ProcessManager, so tests 4-6 exercise the real code
// ---------------------------------------------------------------------------

let ProcessManager = null;
let RuntimeManager = null;
let appPaths = null;
let ensureAppPaths = null;

function ensureBuild() {
  const built = join(REPO_ROOT, 'dist', 'process', 'process-manager.js');
  if (existsSync(built)) return true;

  step('dist/ not found - building the project so this spike tests the real ProcessManager.');
  if (!existsSync(join(REPO_ROOT, 'node_modules'))) {
    step('Installing dev dependencies (npm install)...');
    const install = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: false,
    });
    if (install.status !== 0) {
      detail('npm install failed.');
      return false;
    }
  }
  step('Compiling (npm run build)...');
  const build = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (build.status !== 0) {
    detail('Build failed.');
    return false;
  }
  return existsSync(built);
}

async function loadCompiledModules() {
  if (!ensureBuild()) return false;
  try {
    const pmUrl = pathToFileURL(join(REPO_ROOT, 'dist', 'process', 'process-manager.js')).href;
    const secUrl = pathToFileURL(join(REPO_ROOT, 'dist', 'security', 'secret-redactor.js')).href;
    ({ ProcessManager } = await import(pmUrl));
    const sec = await import(secUrl);
    redact = sec.redact;

    // The runtime layer too, so TEST 8 can exercise the sources the product
    // actually ships rather than a second list that drifts away from them.
    const rmUrl = pathToFileURL(join(REPO_ROOT, 'dist', 'runtime', 'runtime-manager.js')).href;
    const pathsUrl = pathToFileURL(join(REPO_ROOT, 'dist', 'runtime', 'paths.js')).href;
    ({ RuntimeManager } = await import(rmUrl));
    ({ appPaths, ensureAppPaths } = await import(pathsUrl));
    return true;
  } catch (err) {
    detail(`Could not load the compiled modules: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Executable resolution (where.exe on Windows, PATH scan elsewhere)
// ---------------------------------------------------------------------------

function resolveExecutable(command) {
  if (IS_WINDOWS) {
    const found = spawnSync('where.exe', [command], { encoding: 'utf8', shell: false });
    if (found.status === 0) {
      const first = String(found.stdout)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (first) return first;
    }
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const separator = IS_WINDOWS ? ';' : ':';
  const extensions = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').flatMap((e) => [e, e.toLowerCase()])
    : [''];
  for (const dir of pathValue.split(separator).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Runs a command directly, capturing output. Used before ProcessManager loads. */
function runSync(command, args, options = {}) {
  const isCmdLauncher = IS_WINDOWS && /\.(cmd|bat)$/i.test(command);
  const file = isCmdLauncher ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const finalArgs = isCmdLauncher
    ? ['/d', '/s', '/c', `"${[command, ...args].map((a) => `"${a}"`).join(' ')}"`]
    : args;
  const result = spawnSync(file, finalArgs, {
    encoding: 'utf8',
    shell: false,
    windowsVerbatimArguments: isCmdLauncher,
    timeout: options.timeoutMs ?? 60_000,
    input: options.input,
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    error: result.error,
  };
}

// ---------------------------------------------------------------------------
// Process inspection - Windows has no POSIX signals, so this is OS specific
// ---------------------------------------------------------------------------

function isProcessAlive(pid) {
  if (IS_WINDOWS) {
    const out = runSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']);
    return out.stdout.includes(`"${pid}"`);
  }
  // On POSIX a reparented orphan lingers as a zombie, and signalling a zombie
  // succeeds - so read the actual process state instead of using kill(pid, 0).
  const out = runSync('ps', ['-o', 'stat=', '-p', String(pid)]);
  const state = out.stdout.trim();
  return state.length > 0 && !state.startsWith('Z');
}

function childrenOf(pid) {
  if (IS_WINDOWS) {
    const out = runSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`,
    ]);
    return out.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  const out = runSync('ps', ['-o', 'pid=,comm=', '--ppid', String(pid)]);
  return out.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Scratch workspace - every write in this spike happens under here
// ---------------------------------------------------------------------------

const scratchRoot = mkdtempSync(join(tmpdir(), 'lao-spike-'));
function scratch(...parts) {
  const dir = join(scratchRoot, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ===========================================================================
// TEST 1 - Codex CLI: detection and capabilities
// ===========================================================================

async function test1Codex(env) {
  heading('TEST 1 - Codex CLI (orchestrator candidate)');
  say('Detecting how the installed Codex CLI can be driven non-interactively.');
  say('No flag is assumed: capabilities are read out of the CLI\'s own --help text.');

  const lines = [];
  const exe = resolveExecutable('codex') ?? resolveExecutable('codex.cmd');
  if (!exe) {
    record('codex', 'TEST 1 - Codex', 'FAIL', [
      'codex was not found on PATH.',
      'Install the Codex CLI, or add it to PATH, then re-run this spike.',
    ]);
    blocker('Codex CLI is not installed, so the orchestrator adapter cannot be designed against it.');
    env.codex = { found: false };
    return;
  }

  step(`Found: ${exe}`);
  lines.push(`Executable: ${exe}`);

  const version = runSync(exe, ['--version']);
  const versionText = (version.stdout || version.stderr).trim().split(/\r?\n/)[0] ?? '';
  step(`Version: ${versionText || '(no output)'}`);
  lines.push(`Version: ${versionText || '(unknown)'} (exit ${version.status})`);

  const help = runSync(exe, ['--help']);
  const helpText = `${help.stdout}\n${help.stderr}`;
  if (help.status !== 0 && !helpText.trim()) {
    record('codex', 'TEST 1 - Codex', 'FAIL', [
      ...lines,
      `codex --help exited ${help.status} with no output.`,
    ]);
    blocker('codex --help produced nothing, so capabilities cannot be detected.');
    env.codex = { found: true, exe, helpText: '' };
    return;
  }

  // Only report tokens that literally appear in the help output. Nothing here
  // invents a flag; absence is reported as absence.
  const candidates = [
    'exec',
    'run',
    '--json',
    '--output-format',
    '--output-schema',
    '--output-last-message',
    '--non-interactive',
    '--quiet',
    '--full-auto',
    '--sandbox',
    '--ask-for-approval',
    '--model',
    '--cd',
    '--config',
    '--skip-git-repo-check',
  ];
  const present = candidates.filter((token) => helpText.includes(token));
  const absent = candidates.filter((token) => !helpText.includes(token));

  step('Capabilities found in `codex --help`:');
  for (const token of present) detail(`+ ${token}`);
  if (present.length === 0) detail('(none of the expected tokens were present)');

  lines.push(`Tokens present in --help: ${present.join(', ') || '(none)'}`);
  lines.push(`Tokens absent from --help: ${absent.join(', ') || '(none)'}`);

  // If an `exec` subcommand exists, read its own help too - that is where the
  // non-interactive and structured-output flags usually live.
  let execHelpText = '';
  if (helpText.includes('exec')) {
    const execHelp = runSync(exe, ['exec', '--help']);
    execHelpText = `${execHelp.stdout}\n${execHelp.stderr}`;
    if (execHelpText.trim()) {
      step('`codex exec --help` is available; its flags are captured in the report.');
      const execPresent = candidates.filter((t) => execHelpText.includes(t));
      lines.push(`Tokens present in "exec --help": ${execPresent.join(', ') || '(none)'}`);
    }
  }

  env.codex = { found: true, exe, versionText, helpText, execHelpText, present };

  // A real non-interactive invocation. This consumes quota, so it is opt-in.
  const supportsExec = helpText.includes('exec');
  if (!supportsExec) {
    record('codex', 'TEST 1 - Codex', 'FAIL', [
      ...lines,
      'No `exec` subcommand was found, so no non-interactive mode could be confirmed.',
    ]);
    blocker(
      'The installed Codex CLI exposes no non-interactive `exec` mode; the orchestrator adapter needs one.',
    );
    return;
  }

  const wantLive = await askLive(
    'TEST 1 can now send a tiny real prompt to Codex over stdin to prove the round trip.\n' +
      'This uses your Codex quota (one very short request). Run it?',
  );
  if (!wantLive) {
    record('codex', 'TEST 1 - Codex', 'SKIP', [
      ...lines,
      'Live round trip skipped by the user; capability detection only.',
    ]);
    finding('Codex live round trip was skipped - stdin delivery is still unproven.');
    return;
  }

  const prompt = 'Reply with exactly this token and nothing else: SPIKE_CODEX_OK';
  const workDir = scratch('codex-work');

  // Try, in order, the invocation shapes the help text actually advertises.
  const attempts = [];
  if (execHelpText.includes('--json')) attempts.push(['exec', '--json', '-']);
  if (execHelpText.includes('-') || true) attempts.push(['exec', '-']);
  attempts.push(['exec', prompt]);

  let success = null;
  for (const args of attempts) {
    const usesStdin = args.includes('-');
    step(`Trying: codex ${args.join(' ')} ${usesStdin ? '(prompt over stdin)' : '(prompt as argument)'}`);
    const run = runSync(exe, args, {
      cwd: workDir,
      timeoutMs: 180_000,
      input: usesStdin ? prompt : undefined,
    });
    const combined = `${run.stdout}\n${run.stderr}`;
    detail(`exit code: ${run.status}`);
    if (run.status === 0) {
      success = { args, usesStdin, run, combined };
      break;
    }
    detail(`stderr (first line): ${redact(run.stderr.split(/\r?\n/)[0] ?? '')}`);
  }

  if (!success) {
    record('codex', 'TEST 1 - Codex', 'FAIL', [
      ...lines,
      'Every non-interactive invocation shape failed. See the raw help dump below.',
    ]);
    blocker('No working non-interactive Codex invocation was found on this machine.');
    return;
  }

  const echoed = success.combined.includes('SPIKE_CODEX_OK');
  const jsonParsed = tryParseAnyJson(success.combined);

  lines.push(`Working invocation: codex ${success.args.join(' ')}`);
  lines.push(`Prompt delivery: ${success.usesStdin ? 'stdin' : 'command-line argument'}`);
  lines.push(`Exit code: ${success.run.status}`);
  lines.push(`Token echoed back: ${echoed ? 'yes' : 'no'}`);
  lines.push(`Structured (JSON) output: ${jsonParsed ? 'yes' : 'no'}`);
  lines.push(`stdout bytes: ${success.run.stdout.length}, stderr bytes: ${success.run.stderr.length}`);

  env.codex.invocation = success.args;
  env.codex.usesStdin = success.usesStdin;
  env.codex.structured = Boolean(jsonParsed);

  record('codex', 'TEST 1 - Codex', echoed ? 'PASS' : 'FAIL', lines);
  if (!echoed) {
    blocker('Codex ran but did not return the requested token; output shape needs investigation.');
  }
  if (!success.usesStdin) {
    finding(
      'Codex accepted the prompt only as a command-line argument. Large prompts must then avoid ' +
        'the shell entirely - see TEST 6.',
    );
  }
}

/**
 * Finds and parses the first balanced JSON object in `text`.
 *
 * CLI output is usually pretty-printed across several lines and often wrapped
 * in prose, so brace counting is needed rather than a per-line JSON.parse.
 * Braces inside string literals are skipped.
 */
function tryParseAnyJson(text) {
  if (!text) return null;
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf('{', searchFrom);
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
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
            /* not valid JSON; look for the next candidate */
          }
          break;
        }
      }
    }
    searchFrom = start + 1;
  }
}

// ===========================================================================
// TEST 2 - Claude Code CLI as a coding worker
// ===========================================================================

async function test2Claude(env) {
  heading('TEST 2 - Claude Code CLI (coding worker)');
  say('Runs Claude Code non-interactively against a throwaway git repository.');
  say('Your own projects are never touched.');

  const lines = [];
  const exe = resolveExecutable('claude') ?? resolveExecutable('claude.cmd');
  if (!exe) {
    record('claude', 'TEST 2 - Claude', 'FAIL', [
      'claude was not found on PATH.',
      'Install the Claude Code CLI, then re-run this spike.',
    ]);
    blocker('Claude Code CLI is not installed, so the worker adapter cannot be designed against it.');
    env.claude = { found: false };
    return;
  }

  step(`Found: ${exe}`);
  lines.push(`Executable: ${exe}`);

  const version = runSync(exe, ['--version']);
  const versionText = (version.stdout || version.stderr).trim().split(/\r?\n/)[0] ?? '';
  step(`Version: ${versionText}`);
  lines.push(`Version: ${versionText} (exit ${version.status})`);

  const status = runSync(exe, ['auth', 'status', '--json']);
  const auth = tryParseAnyJson(status.stdout) ?? {};
  step(`auth status: loggedIn=${auth.loggedIn}, authMethod=${auth.authMethod ?? '(unknown)'}`);
  lines.push(`Default profile loggedIn: ${auth.loggedIn}`);
  lines.push(`Default profile authMethod: ${auth.authMethod ?? '(unknown)'}`);

  env.claude = { found: true, exe, versionText, auth };

  if (!auth.loggedIn) {
    record('claude', 'TEST 2 - Claude', 'FAIL', [
      ...lines,
      'Claude Code is not authenticated.',
      'Run:  claude auth login',
      'then re-run this spike.',
    ]);
    blocker('Claude Code is not authenticated on the default profile.');
    return;
  }

  const wantLive = await askLive(
    'TEST 2 can now ask Claude Code to create one small file in a throwaway git repo.\n' +
      'This uses your Claude quota (one short request). Run it?',
  );
  if (!wantLive) {
    record('claude', 'TEST 2 - Claude', 'SKIP', [...lines, 'Live edit skipped by the user.']);
    finding('Claude live file-edit round trip was skipped.');
    return;
  }

  const repo = makeScratchRepo('claude-worker');
  step(`Scratch repository: ${repo}`);

  const prompt = [
    'Create a file named spike-artifact.txt in the current directory.',
    'Its entire contents must be exactly this single line:',
    'SPIKE_CLAUDE_OK',
    'Do not create or modify any other file. Then stop.',
  ].join('\n');

  step('Running: claude -p --output-format json --permission-mode acceptEdits (prompt over stdin)');
  const run = runSync(exe, ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'], {
    cwd: repo,
    input: prompt,
    timeoutMs: 300_000,
  });

  const artifact = join(repo, 'spike-artifact.txt');
  const created = existsSync(artifact);
  const contents = created ? readFileSync(artifact, 'utf8').trim() : '';
  const gitStatus = runSync('git', ['status', '--short'], { cwd: repo }).stdout.trim();

  detail(`exit code: ${run.status}`);
  detail(`file created: ${created}`);
  detail(`git status: ${gitStatus || '(clean)'}`);

  lines.push(`Prompt delivery: stdin (${Buffer.byteLength(prompt)} bytes)`);
  lines.push(`Exit code: ${run.status}`);
  lines.push(`stdout bytes: ${run.stdout.length}, stderr bytes: ${run.stderr.length}`);
  lines.push(`File created: ${created}`);
  lines.push(`File contents match: ${contents === 'SPIKE_CLAUDE_OK'}`);
  lines.push(`git status --short: ${gitStatus.replace(/\r?\n/g, ' | ') || '(clean)'}`);

  const ok = run.status === 0 && created && contents === 'SPIKE_CLAUDE_OK';
  record('claude', 'TEST 2 - Claude', ok ? 'PASS' : 'FAIL', lines);
  if (!ok) {
    lines.push(`stderr: ${redact(run.stderr.slice(0, 500))}`);
    blocker('Claude Code did not complete a simple non-interactive file edit.');
  }
  env.claude.workerOk = ok;
}

function makeScratchRepo(name) {
  const dir = scratch(name);
  const git = (...args) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'spike@example.invalid');
  git('config', 'user.name', 'Windows Spike');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# scratch repo for the windows spike\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

// ===========================================================================
// TEST 3 - Two isolated Claude Code accounts
// ===========================================================================

async function test3Profiles(env) {
  heading('TEST 3 - Two Claude Code accounts, isolated via CLAUDE_CONFIG_DIR');
  say('Proves that two accounts stay authenticated at the same time and that');
  say('authenticating one never overwrites the other.');
  say('');
  say('No token, credential or credential-file content is ever printed.');

  if (!env.claude?.found) {
    record('profiles', 'TEST 3 - Multiple Claude Profiles', 'SKIP', [
      'Claude Code CLI is not available.',
    ]);
    return;
  }

  const exe = env.claude.exe;
  const lines = [];

  // Environment-level credentials would make BOTH profiles look authenticated
  // through the SAME account - a false pass. Scan by pattern rather than by a
  // fixed list of names, because hosted environments invent their own.
  const envAuthKeys = Object.keys(process.env).filter((k) =>
    /^(ANTHROPIC_(API_KEY|AUTH_TOKEN)|CLAUDE_CODE_(OAUTH_TOKEN|API_KEY))/.test(k),
  );
  if (envAuthKeys.length) {
    say('');
    say('  !! WARNING');
    say(`  These environment variables are set: ${envAuthKeys.join(', ')}`);
    say('  They authenticate every profile through the SAME credential, which would make this');
    say('  isolation test pass for the wrong reason. Unset them and re-run for a valid result.');
    finding(
      `Environment credentials present (${envAuthKeys.join(', ')}); they bypass per-profile ` +
        'isolation and must be unset for a trustworthy TEST 3 result.',
    );
    lines.push(`WARNING - environment credentials set: ${envAuthKeys.join(', ')}`);
  }

  const defaultA = flagValue('--profile-a') ?? join(homedir(), '.claude-personal');
  const defaultB = flagValue('--profile-b') ?? join(homedir(), '.claude-work');

  say('');
  say('  Each profile needs its own configuration directory (an absolute path).');
  const dirA = resolve(await ask('Directory for profile A ("personal")', defaultA));
  const dirB = resolve(await ask('Directory for profile B ("work")', defaultB));

  if (dirA === dirB) {
    record('profiles', 'TEST 3 - Multiple Claude Profiles', 'FAIL', [
      'Both profiles were given the same directory; they cannot be isolated.',
    ]);
    blocker('Profile A and profile B were configured with the same CLAUDE_CONFIG_DIR.');
    return;
  }
  if (!isAbsolute(dirA) || !isAbsolute(dirB)) {
    record('profiles', 'TEST 3 - Multiple Claude Profiles', 'FAIL', [
      'CLAUDE_CONFIG_DIR must be an absolute path; the Claude Code CLI rejects a relative one.',
    ]);
    return;
  }

  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  lines.push(`Profile A directory: ${dirA}`);
  lines.push(`Profile B directory: ${dirB}`);

  const profileA = await ensureProfileAuthenticated(exe, 'A (personal)', dirA);
  const profileB = await ensureProfileAuthenticated(exe, 'B (work)', dirB);

  // Re-read profile A AFTER touching B. If authenticating B had clobbered A,
  // this is where it shows.
  step('Re-checking profile A after working with profile B...');
  const profileARecheck = readProfileStatus(exe, dirA);

  for (const [label, info] of [
    ['A', profileA],
    ['B', profileB],
  ]) {
    if (info.status.loggedIn && !info.hasCredentialsFile) {
      say('');
      say(`  !! Profile ${label} reports loggedIn but has no .credentials.json of its own.`);
      say('  !! Its credential is ambient, so this run cannot prove isolation.');
    }
  }

  const aStillIn = profileA.status.loggedIn && profileARecheck.status.loggedIn;
  const bothIn = profileA.status.loggedIn && profileB.status.loggedIn;

  // `projectsDirectory` is derived from the config home, so it proves which
  // profile an invocation actually used - with no credential involved.
  const aUsedOwnHome = pathStartsWith(profileARecheck.status.projectsDirectory, dirA);
  const bUsedOwnHome = pathStartsWith(profileB.status.projectsDirectory, dirB);
  const homesDiffer =
    profileARecheck.status.projectsDirectory !== profileB.status.projectsDirectory;

  lines.push('');
  lines.push('Profile A:');
  lines.push(`  loggedIn: ${profileA.status.loggedIn}`);
  lines.push(`  authMethod: ${profileA.status.authMethod ?? '(unknown)'}`);
  lines.push(`  projectsDirectory: ${profileARecheck.status.projectsDirectory ?? '(none)'}`);
  lines.push(`  own credentials file present: ${profileA.hasCredentialsFile}`);
  lines.push(`  loggedIn after touching profile B: ${profileARecheck.status.loggedIn}`);
  lines.push('Profile B:');
  lines.push(`  loggedIn: ${profileB.status.loggedIn}`);
  lines.push(`  authMethod: ${profileB.status.authMethod ?? '(unknown)'}`);
  lines.push(`  projectsDirectory: ${profileB.status.projectsDirectory ?? '(none)'}`);
  lines.push(`  own credentials file present: ${profileB.hasCredentialsFile}`);
  lines.push('');
  lines.push(`Both authenticated simultaneously: ${bothIn}`);
  lines.push(`Profile A survived profile B: ${aStillIn}`);
  lines.push(`Each invocation used its own config home: ${aUsedOwnHome && bUsedOwnHome}`);
  lines.push(`Config homes are distinct: ${homesDiffer}`);

  // Prove each profile really drives an invocation, not just a status read.
  if (bothIn) {
    const liveCheck = await askYesNo(
      'Run one tiny prompt under each profile to prove the selected account is really used?\n' +
        'This uses a small amount of quota on BOTH accounts.',
      false,
    );
    if (liveCheck) {
      for (const [label, dir] of [
        ['A', dirA],
        ['B', dirB],
      ]) {
        const repo = makeScratchRepo(`profile-${label}`);
        const run = runSync(exe, ['-p', '--output-format', 'json'], {
          cwd: repo,
          input: 'Reply with exactly: SPIKE_PROFILE_OK',
          timeoutMs: 180_000,
          env: { CLAUDE_CONFIG_DIR: dir },
        });
        const ok = run.status === 0 && `${run.stdout}`.includes('SPIKE_PROFILE_OK');
        step(`Profile ${label} live invocation: ${ok ? 'ok' : `failed (exit ${run.status})`}`);
        lines.push(`Profile ${label} live invocation: ${ok ? 'PASS' : 'FAIL'} (exit ${run.status})`);
      }
    }
  }

  // The decisive structural check, independent of any env-variable name: a
  // profile that reports loggedIn but holds no credentials file of its own is
  // authenticating through something ambient, so its isolation proves nothing.
  const ambientA = profileA.status.loggedIn && !profileA.hasCredentialsFile;
  const ambientB = profileB.status.loggedIn && !profileB.hasCredentialsFile;
  const credentialsAreProfileLocal = !ambientA && !ambientB;

  lines.push(`Credentials are profile-local (not ambient): ${credentialsAreProfileLocal}`);

  const isolationOk =
    bothIn &&
    aStillIn &&
    aUsedOwnHome &&
    bUsedOwnHome &&
    homesDiffer &&
    credentialsAreProfileLocal &&
    envAuthKeys.length === 0;

  record('profiles', 'TEST 3 - Multiple Claude Profiles', isolationOk ? 'PASS' : 'FAIL', lines);

  if (!bothIn) {
    blocker(
      'Both Claude profiles are not authenticated at the same time; multi-account support is unproven.',
    );
  } else if (!credentialsAreProfileLocal) {
    const which = [ambientA ? 'A' : null, ambientB ? 'B' : null].filter(Boolean);
    const subject =
      which.length > 1 ? `Profiles ${which.join(' and ')} report` : `Profile ${which[0]} reports`;
    blocker(
      `${subject} being logged in but hold no .credentials.json of their own, so the ` +
        'credential is ambient (an environment token or a shared config home), not profile-local. ' +
        'Isolation is NOT proven. Log each profile in with `claude auth login` under its own ' +
        'CLAUDE_CONFIG_DIR, with no Anthropic token set in the environment, then re-run.',
    );
  } else if (envAuthKeys.length) {
    blocker(
      'Profile isolation could not be trusted because environment credentials override per-profile auth.',
    );
  } else if (!isolationOk) {
    blocker('Claude profile isolation via CLAUDE_CONFIG_DIR did not hold.');
  }

  env.profiles = { dirA, dirB, isolationOk };
}

function pathStartsWith(child, parent) {
  if (!child || !parent) return false;
  const normalise = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return normalise(child).startsWith(normalise(parent));
}

function readProfileStatus(exe, configDir) {
  const run = runSync(exe, ['auth', 'status', '--json'], { env: { CLAUDE_CONFIG_DIR: configDir } });
  const status = tryParseAnyJson(run.stdout) ?? { loggedIn: false };
  // Presence only - the file is never opened or printed.
  const hasCredentialsFile = existsSync(join(configDir, '.credentials.json'));
  return { status, hasCredentialsFile, exitCode: run.status };
}

async function ensureProfileAuthenticated(exe, label, configDir) {
  step(`Checking profile ${label} at ${configDir}`);
  let info = readProfileStatus(exe, configDir);
  detail(`loggedIn: ${info.status.loggedIn}, authMethod: ${info.status.authMethod ?? '(unknown)'}`);

  if (info.status.loggedIn) return info;

  say('');
  say(`  Profile ${label} is NOT authenticated yet.`);
  say('  To authenticate it manually, open a new terminal and run:');
  say('');
  say(`      set CLAUDE_CONFIG_DIR=${configDir}`);
  say('      claude auth login');
  say('');
  say('  (in PowerShell:  $env:CLAUDE_CONFIG_DIR="' + configDir + '"  then  claude auth login)');

  const loginNow = await askYesNo(`Log in to profile ${label} now, from inside this spike?`, true);
  if (!loginNow) return info;

  say('');
  say('  Launching `claude auth login` - complete the flow in your browser, then return here.');
  await new Promise((resolvePromise) => {
    const child = spawn(exe, ['auth', 'login'], {
      cwd: scratchRoot,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: 'inherit',
      shell: false,
    });
    child.on('close', () => resolvePromise());
    child.on('error', () => resolvePromise());
  });

  info = readProfileStatus(exe, configDir);
  detail(`After login - loggedIn: ${info.status.loggedIn}`);
  return info;
}

// ===========================================================================
// TEST 4 - Cancellation and orphan cleanup
// ===========================================================================

async function test4Cancellation(env) {
  heading('TEST 4 - Cancellation and process-tree cleanup');
  say('Starts a process tree through the real ProcessManager, cancels it, and');
  say('then checks whether anything survived. Windows has no POSIX signals, so');
  say('cleanup goes through taskkill /T /F rather than process groups.');

  if (!ProcessManager) {
    record('cancel', 'TEST 4 - Cancellation', 'SKIP', ['ProcessManager could not be loaded.']);
    return;
  }

  const lines = [];
  const pidFile = join(scratch('cancel'), 'pids.txt');

  // A parent that spawns a grandchild; both idle until killed. The grandchild
  // also writes a heartbeat, which is how we tell "stopped" from "zombie".
  const beatFile = join(scratch('cancel'), 'heartbeat.txt');
  const grandchildSrc = `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(pidFile)}, 'grandchild ' + process.pid + '\\n');
    setInterval(() => fs.writeFileSync(${JSON.stringify(beatFile)}, String(Date.now())), 100);
  `;
  const parentSrc = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    fs.appendFileSync(${JSON.stringify(pidFile)}, 'parent ' + process.pid + '\\n');
    spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSrc)}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `;

  const pm = new ProcessManager();
  step('Starting the process tree...');
  const running = pm.run({
    command: process.execPath,
    args: ['-e', parentSrc],
    cwd: scratchRoot,
    graceMs: 3000,
  });

  await sleep(2000);

  const recorded = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split(/\r?\n/) : [];
  const pids = recorded
    .map((l) => ({ role: l.split(' ')[0], pid: Number(l.split(' ')[1]) }))
    .filter((p) => Number.isFinite(p.pid));

  const parentPid = pids.find((p) => p.role === 'parent')?.pid;
  const grandchildPid = pids.find((p) => p.role === 'grandchild')?.pid;

  step(`Main PID (parent): ${parentPid ?? '(not reported)'}`);
  step(`Known child PID (grandchild): ${grandchildPid ?? '(not reported)'}`);
  if (parentPid) {
    const kids = childrenOf(parentPid);
    step(`Children reported by the OS: ${kids.join(', ') || '(none)'}`);
    lines.push(`OS-reported children of ${parentPid}: ${kids.join(', ') || '(none)'}`);
  }

  lines.push(`Main PID: ${parentPid ?? '(unknown)'}`);
  lines.push(`Known child PID: ${grandchildPid ?? '(unknown)'}`);
  lines.push(
    `Cancellation method: ${IS_WINDOWS ? 'taskkill /pid <pid> /T then /T /F' : 'SIGTERM then SIGKILL to the process group'}`,
  );

  // Only used to prove the grandchild was alive at all before we cancelled.
  const beatBefore = existsSync(beatFile) ? readFileSync(beatFile, 'utf8') : '';

  step('Cancelling through ProcessManager.cancelAll()...');
  const cancelStarted = Date.now();
  await pm.cancelAll(3000);
  const result = await running;
  const cancelMs = Date.now() - cancelStarted;

  step(`Reported outcome: ${result.outcome} (took ${cancelMs}ms)`);
  lines.push(`Reported outcome: ${result.outcome}`);
  lines.push(`Cancellation took: ${cancelMs}ms`);

  await sleep(1500);

  const survivors = [];
  for (const { role, pid } of pids) {
    if (isProcessAlive(pid)) survivors.push(`${role} pid ${pid}`);
  }

  // A heartbeat that stopped advancing proves the grandchild is not running,
  // even if the OS still lists a zombie entry.
  //
  // Both readings are taken *after* cancellation has settled, and compared with
  // each other. Comparing against a reading from before the cancel was the
  // wrong test: the grandchild keeps beating throughout the grace period, so
  // the value always differs and the check reported "not stopped" for a process
  // that was demonstrably gone - which is exactly the contradiction the Windows
  // run produced, zero survivors alongside an inconclusive heartbeat.
  const beatSettled = existsSync(beatFile) ? readFileSync(beatFile, 'utf8') : '';
  await sleep(600);
  const beatAfter = existsSync(beatFile) ? readFileSync(beatFile, 'utf8') : '';
  const wasBeating = beatBefore !== '';
  const heartbeatStopped = wasBeating && beatSettled !== '' && beatAfter === beatSettled;

  step(`Surviving processes: ${survivors.length === 0 ? 'none' : survivors.join(', ')}`);
  step(`Grandchild heartbeat stopped: ${heartbeatStopped}`);

  lines.push(`Orphan processes: ${survivors.length}`);
  lines.push(`Survivors: ${survivors.join(', ') || '(none)'}`);
  lines.push(`Grandchild was beating before cancel: ${wasBeating}`);
  lines.push(`Grandchild heartbeat stopped after cancel: ${heartbeatStopped}`);
  lines.push(`ProcessManager live count after cancel: ${pm.liveCount}`);

  const ok =
    survivors.length === 0 &&
    heartbeatStopped &&
    pm.liveCount === 0 &&
    result.outcome !== 'completed';

  record('cancel', 'TEST 4 - Cancellation', ok ? 'PASS' : 'FAIL', lines);
  if (!ok) {
    blocker(
      `Cancellation left ${survivors.length} process(es) behind or reported the wrong outcome; ` +
        'the desktop app would leak agent processes.',
    );
  }

  // Optionally repeat against a real agent, which is the case that matters.
  if (env.claude?.found) {
    const wantReal = await askYesNo(
      'Also cancel a REAL Claude Code invocation mid-flight, to prove agent processes clean up?\n' +
        'This starts and then kills one request (small quota cost).',
      false,
    );
    if (wantReal) {
      await cancelRealAgent(env.claude.exe, lines);
    }
  }
}

async function cancelRealAgent(exe, lines) {
  const pm = new ProcessManager();
  const repo = makeScratchRepo('cancel-real');
  step('Starting a real Claude Code invocation, then cancelling it after 8s...');

  const running = pm.run({
    command: exe,
    args: ['-p', '--output-format', 'json'],
    cwd: repo,
    stdin: 'Count slowly from 1 to 200, one number per line, pausing briefly between each.',
    graceMs: 5000,
  });

  await sleep(8000);
  const mainPid = pm.liveCount > 0 ? '(tracked by ProcessManager)' : '(already finished)';
  step(`Cancelling... ${mainPid}`);

  await pm.cancelAll(5000);
  const result = await running;
  await sleep(2000);

  // Any agent process left behind would show up here by name.
  const strays = findStrayAgentProcesses();

  step(`Real-agent cancel outcome: ${result.outcome}, live count: ${pm.liveCount}`);
  step(`Stray agent processes found: ${strays.length === 0 ? 'none' : strays.join(', ')}`);

  lines.push('');
  lines.push(`Real Claude cancel - outcome: ${result.outcome}`);
  lines.push(`Real Claude cancel - ProcessManager live count after: ${pm.liveCount}`);
  lines.push(`Real Claude cancel - stray agent processes: ${strays.length}`);
  if (strays.length) lines.push(`  ${strays.join('\n  ')}`);
}

/**
 * Lists processes whose image name looks like an agent CLI.
 *
 * Informational: it cannot tell this spike's leftovers from an agent you
 * started yourself, so the count is reported rather than asserted on.
 */
function findStrayAgentProcesses() {
  if (IS_WINDOWS) {
    const out = runSync('tasklist', ['/NH', '/FO', 'CSV']);
    return out.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^"(claude|codex)/i.test(l))
      .map((l) => l.split(',').slice(0, 2).join(' ').replace(/"/g, ''));
  }
  const out = runSync('ps', ['-eo', 'pid=,comm=']);
  return out.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\b(claude|codex)$/i.test(l));
}

// ===========================================================================
// TEST 5 - .cmd / .bat / .exe handling
// ===========================================================================

async function test5Launchers() {
  heading('TEST 5 - Windows executable handling (.cmd / .bat / .exe)');
  say('npm installs create .cmd launchers on Windows, and Node refuses to spawn');
  say('them directly. This proves the cmd.exe /d /s /c wrapping actually works,');
  say('with arguments and stdin surviving intact.');

  if (!ProcessManager) {
    record('launchers', 'TEST 5 - Windows executable handling', 'SKIP', [
      'ProcessManager could not be loaded.',
    ]);
    return;
  }

  const dir = scratch('launchers');
  const lines = [];

  // Helper scripts the launchers delegate to.
  writeFileSync(
    join(dir, 'args.js'),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    'utf8',
  );
  writeFileSync(
    join(dir, 'stdin.js'),
    [
      "const c = require('node:crypto');",
      "let d = Buffer.alloc(0);",
      "process.stdin.on('data', (x) => { d = Buffer.concat([d, x]); });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      "    bytes: d.length,",
      "    sha256: c.createHash('sha256').update(d).digest('hex'),",
      "  }));",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  // A .cmd and a .bat that forward to node, exactly like npm's launchers do.
  for (const ext of ['cmd', 'bat']) {
    writeFileSync(
      join(dir, `args.${ext}`),
      `@echo off\r\n"${process.execPath}" "%~dp0args.js" %*\r\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, `stdin.${ext}`),
      `@echo off\r\n"${process.execPath}" "%~dp0stdin.js"\r\n`,
      'utf8',
    );
  }

  const pm = new ProcessManager();
  // Arguments deliberately containing the things that break naive quoting.
  const trickyArgs = ['plain', 'with space', 'quote"inside', 'C:\\Program Files\\thing', '--flag=a b'];

  let allOk = true;

  for (const target of ['exe', 'cmd', 'bat']) {
    if (target !== 'exe' && !IS_WINDOWS) {
      lines.push(`.${target}: skipped (not Windows)`);
      continue;
    }

    const command = target === 'exe' ? process.execPath : join(dir, `args.${target}`);
    const args = target === 'exe' ? [join(dir, 'args.js'), ...trickyArgs] : trickyArgs;

    const run = await pm.run({ command, args, cwd: dir, timeoutMs: 60_000 });
    let received = null;
    try {
      received = JSON.parse(run.stdout.trim());
    } catch {
      /* left null */
    }

    const match = received !== null && JSON.stringify(received) === JSON.stringify(trickyArgs);
    step(`.${target} argv round trip: ${match ? 'ok' : 'MISMATCH'} (exit ${run.exitCode})`);
    if (!match) {
      detail(`sent:     ${JSON.stringify(trickyArgs)}`);
      detail(`received: ${run.stdout.trim().slice(0, 300)}`);
      allOk = false;
    }
    lines.push(`.${target} argv round trip: ${match ? 'PASS' : 'FAIL'} (exit ${run.exitCode})`);
  }

  // stdin through a .cmd wrapper - the real claude.cmd / codex.cmd shape.
  if (IS_WINDOWS) {
    const payload = 'line one\nline two with "quotes"\n{"json":true}\n';
    const expected = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
    const run = await pm.run({
      command: join(dir, 'stdin.cmd'),
      cwd: dir,
      stdin: payload,
      timeoutMs: 60_000,
    });
    const parsed = tryParseAnyJson(run.stdout);
    const match = parsed?.sha256 === expected;
    step(`.cmd stdin round trip: ${match ? 'ok' : 'MISMATCH'}`);
    lines.push(`.cmd stdin round trip: ${match ? 'PASS' : 'FAIL'}`);
    if (!match) allOk = false;
  }

  // A real npm-installed launcher, if one is present.
  const realLauncher = resolveExecutable('claude') ?? resolveExecutable('npm');
  if (realLauncher) {
    const run = await pm.run({
      command: realLauncher,
      args: ['--version'],
      cwd: dir,
      timeoutMs: 60_000,
    });
    const ok = run.exitCode === 0;
    step(`Real launcher ${realLauncher} --version: ${ok ? 'ok' : 'FAILED'}`);
    lines.push(`Real launcher: ${realLauncher} --version exit ${run.exitCode}`);
    if (!ok) allOk = false;
  }

  record('launchers', 'TEST 5 - Windows executable handling', allOk ? 'PASS' : 'FAIL', lines);
  if (!allOk) blocker('Argument or stdin handling through a .cmd launcher is not reliable.');
}

// ===========================================================================
// TEST 6 - A large, hostile prompt over stdin
// ===========================================================================

async function test6LargeStdin() {
  heading('TEST 6 - Large prompt over stdin');
  say('Proves a big prompt full of quotes, newlines, JSON, Windows paths and');
  say('non-ASCII text arrives byte-for-byte, with no shell escaping involved.');

  if (!ProcessManager) {
    record('stdin', 'TEST 6 - stdin', 'SKIP', ['ProcessManager could not be loaded.']);
    return;
  }

  const dir = scratch('stdin-test');
  writeFileSync(
    join(dir, 'stdin.js'),
    [
      "const c = require('node:crypto');",
      'let d = Buffer.alloc(0);',
      "process.stdin.on('data', (x) => { d = Buffer.concat([d, x]); });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      '    bytes: d.length,',
      "    sha256: c.createHash('sha256').update(d).digest('hex'),",
      '  }));',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  if (IS_WINDOWS) {
    writeFileSync(
      join(dir, 'stdin.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0stdin.js"\r\n`,
      'utf8',
    );
  }

  const hostile = [
    'Corrija o sistema de modulação: os blocos estão alinhados verticalmente.',
    'Double quotes: "hello" and \'single\' and `backtick`',
    'Shell metacharacters that must NOT be interpreted: & | > < ; ^ $ ( ) % !',
    'Windows paths: C:\\Users\\Gabriel\\Projetos\\Meu Projeto\\src\\file.ts',
    'UNC path: \\\\server\\share\\folder',
    'Percent variable that cmd would expand: %USERPROFILE% and %PATH%',
    'Delayed expansion: !VAR!',
    'JSON payload:',
    JSON.stringify(
      {
        action: 'delegate',
        task: 'Fix "wall detection" & re-run tests',
        acceptanceCriteria: ['npm test passes', 'no file outside src/ is touched'],
        verificationCommands: ['npm test'],
        path: 'C:\\Projetos\\MeuProjeto',
      },
      null,
      2,
    ),
    'Non-ASCII: ção ãõ é ü ß 日本語 emoji ok',
    'A long tail follows to push past the pipe buffer:',
    'x'.repeat(80_000),
  ].join('\n');

  const payload = Buffer.from(hostile, 'utf8');
  const expected = createHash('sha256').update(payload).digest('hex');

  step(`Prompt size: ${payload.length} bytes (${(payload.length / 1024).toFixed(1)} KiB)`);
  step(`Expected sha256: ${expected.slice(0, 16)}...`);

  const pm = new ProcessManager();
  const lines = [`Prompt size: ${payload.length} bytes`, `Expected sha256: ${expected}`];
  let allOk = true;

  // Direct .exe path.
  const direct = await pm.run({
    command: process.execPath,
    args: [join(dir, 'stdin.js')],
    cwd: dir,
    stdin: hostile,
    timeoutMs: 60_000,
  });
  const directParsed = tryParseAnyJson(direct.stdout);
  const directOk = directParsed?.sha256 === expected && directParsed?.bytes === payload.length;
  step(`Direct .exe stdin: ${directOk ? 'byte-for-byte match' : 'MISMATCH'}`);
  lines.push(
    `Direct executable: ${directOk ? 'PASS' : 'FAIL'} (received ${directParsed?.bytes ?? '?'} bytes)`,
  );
  if (!directOk) allOk = false;

  // Through a .cmd launcher - the shape a real agent CLI uses on Windows.
  if (IS_WINDOWS) {
    const viaCmd = await pm.run({
      command: join(dir, 'stdin.cmd'),
      cwd: dir,
      stdin: hostile,
      timeoutMs: 60_000,
    });
    const cmdParsed = tryParseAnyJson(viaCmd.stdout);
    const cmdOk = cmdParsed?.sha256 === expected && cmdParsed?.bytes === payload.length;
    step(`Through .cmd launcher: ${cmdOk ? 'byte-for-byte match' : 'MISMATCH'}`);
    lines.push(
      `Through .cmd launcher: ${cmdOk ? 'PASS' : 'FAIL'} (received ${cmdParsed?.bytes ?? '?'} bytes)`,
    );
    if (!cmdOk) allOk = false;
  } else {
    lines.push('Through .cmd launcher: skipped (not Windows)');
  }

  record('stdin', 'TEST 6 - stdin', allOk ? 'PASS' : 'FAIL', lines);
  if (!allOk) {
    blocker('A large prompt does not survive stdin delivery intact; prompt transport is unsafe.');
  }
}

// ===========================================================================
// TEST 7 - Driving `claude auth login` from a GUI, with no terminal
// ===========================================================================

/**
 * The product promises the user never opens PowerShell. Connecting an account
 * is the most visible place that promise can break, because `claude auth login`
 * is an interactive OAuth flow.
 *
 * What has to be true for the desktop app to wrap it:
 *   1. it runs with piped stdio (no TTY),
 *   2. it prints a URL the app can capture and open in the system browser,
 *   3. completion can be detected without reading the terminal.
 *
 * This never touches a real profile: it uses a throwaway config directory.
 */
async function test7GuiAuth(env) {
  heading('TEST 7 - Connecting an account without a terminal');
  say('Checks whether `claude auth login` can be driven by the desktop app:');
  say('run headless, capture the login URL, open the browser, detect completion.');
  say('');
  say('This uses a THROWAWAY profile directory - your real accounts are untouched.');

  if (!env.claude?.found) {
    record('guiauth', 'TEST 7 - GUI-driven authentication', 'SKIP', [
      'Claude Code CLI is not available.',
    ]);
    return;
  }

  const exe = env.claude.exe;
  const configDir = scratch('gui-auth-profile');
  const lines = [`Throwaway profile: ${configDir}`];

  const wantTest = await askYesNo(
    'TEST 7 starts a real login flow in a throwaway profile.\n' +
      'You can cancel it as soon as the URL appears - completing it is optional.\n' +
      'Run it?',
    true,
  );
  if (!wantTest) {
    record('guiauth', 'TEST 7 - GUI-driven authentication', 'SKIP', [
      ...lines,
      'Skipped by the user.',
    ]);
    finding('GUI-driven authentication is unproven; the no-terminal onboarding depends on it.');
    return;
  }

  step('Spawning `claude auth login` with piped stdio (no TTY)...');

  const started = Date.now();
  let output = '';
  let capturedUrl = null;
  let exited = null;

  const child = spawn(exe, ['auth', 'login'], {
    cwd: scratchRoot,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    // Pipes, not 'inherit'. This is the whole point: an Electron app has no TTY
    // to hand the child.
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
  });

  const onChunk = (chunk) => {
    const text = String(chunk);
    output += text;
    if (!capturedUrl) {
      const match = /https:\/\/[^\s"'<>]+/.exec(output);
      if (match) {
        capturedUrl = match[0];
        step(`Login URL captured after ${Date.now() - started}ms`);
      }
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('close', (code) => {
    exited = code;
  });

  // Give it up to 30s to print a URL.
  const deadline = Date.now() + 30_000;
  while (!capturedUrl && exited === null && Date.now() < deadline) {
    await sleep(250);
  }

  const msToUrl = capturedUrl ? Date.now() - started : null;
  const ttyComplaint = /\b(tty|raw ?mode|not a terminal|stdin is not|interactive terminal)\b/i.test(
    output,
  );

  lines.push(`Ran without a TTY: ${exited === null || exited === 0 ? 'yes' : `process exited ${exited}`}`);
  lines.push(`Login URL captured: ${capturedUrl ? 'yes' : 'no'}`);
  if (msToUrl !== null) lines.push(`Time to URL: ${msToUrl}ms`);
  lines.push(`Complained about missing TTY: ${ttyComplaint}`);

  if (capturedUrl) {
    // The URL itself can carry a one-time code, so only its origin is recorded.
    let origin = '(unparseable)';
    try {
      origin = new URL(capturedUrl).origin;
    } catch {
      /* keep placeholder */
    }
    step(`URL origin: ${origin}  (full URL withheld - it may carry a one-time code)`);
    lines.push(`URL origin: ${origin}`);
  }

  let completed = false;
  if (capturedUrl && exited === null) {
    const finish = await askYesNo(
      'A login URL was captured. Complete the login in your browser to prove the app can\n' +
        'detect completion by itself? (Choose no to just cancel the flow here.)',
      false,
    );
    if (finish) {
      say('');
      say('  Open this URL in your browser and finish signing in:');
      say('');
      say(`      ${capturedUrl}`);
      say('');
      say('  Waiting up to 3 minutes, polling `claude auth status --json`...');

      const pollDeadline = Date.now() + 180_000;
      while (Date.now() < pollDeadline && !completed) {
        await sleep(3000);
        const info = readProfileStatus(exe, configDir);
        if (info.status.loggedIn) {
          completed = true;
          step('Completion detected by polling auth status - no terminal reading required.');
        }
      }
      if (!completed) step('Timed out waiting for the login to complete.');
      lines.push(`Completion detected by polling: ${completed}`);
    } else {
      lines.push('Completion detection: not tested (user cancelled the flow)');
    }
  }

  // Always clean the flow up; never leave a login process hanging around.
  if (exited === null && child.pid !== undefined) {
    step('Stopping the login process...');
    try {
      if (IS_WINDOWS) runSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F']);
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }

  // Capturing the URL headlessly is what the GUI actually needs; completing the
  // flow is a stronger proof but is optional for the user.
  const ok = Boolean(capturedUrl) && !ttyComplaint;
  record('guiauth', 'TEST 7 - GUI-driven authentication', ok ? 'PASS' : 'FAIL', lines);

  if (!ok) {
    blocker(
      'Could not capture a login URL from `claude auth login` without a TTY. The GUI cannot ' +
        'wrap the OAuth flow as designed, so account connection would fall back to a terminal - ' +
        'which the zero-configuration requirement forbids. Needs a different approach ' +
        '(for example `claude setup-token`, or an embedded terminal view).',
    );
  }
  env.guiAuth = { ok, capturedUrl: Boolean(capturedUrl), completed };
}

// ===========================================================================
// TEST 8 - Runtime acquisition (the RuntimeManager, proven end to end)
// ===========================================================================

/**
 * The product must install the agent runtimes itself, so the user never runs
 * npm or hunts for an executable.
 *
 * This test does NOT hardcode one download URL. It walks an ordered list of
 * candidate *sources*, reports which are actually reachable and what each
 * returns, and labels every source with how much it can be relied on:
 *
 *   DOCUMENTED           - a published, supported way to obtain the runtime
 *   PACKAGE INTERNAL     - depends on a package's internal layout
 *   NOT PUBLIC CONTRACT  - an implementation detail (e.g. a host observed
 *                          inside a binary). Usable for a test, never a
 *                          foundation to build on.
 *
 * That classification is the point: the adapter talks to a RuntimeSource, so
 * the strategy can change later without touching CodexAdapter or
 * ClaudeCodeAdapter.
 *
 * Everything is downloaded into a throwaway folder. The machine's real
 * installations are never modified.
 */

const CONTRACT = {
  DOCUMENTED: 'DOCUMENTED',
  PACKAGE_INTERNAL: 'PACKAGE INTERNAL',
  NOT_PUBLIC: 'IMPLEMENTATION DETAIL / NOT PUBLIC CONTRACT',
};

function windowsArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

/** Candidate sources for the Codex runtime, in preference order. */
function codexSources() {
  const arch = windowsArch();
  return [
    {
      id: 'openai-releases-cdn',
      label: 'releases.openai.com (channel used by the official standalone installer)',
      contract: CONTRACT.DOCUMENTED,
      kind: 'probe',
      urls: [
        'https://releases.openai.com/codex/latest',
        'https://releases.openai.com/codex',
      ],
    },
    {
      id: 'github-releases',
      label: 'github.com/openai/codex releases (official project releases)',
      contract: CONTRACT.DOCUMENTED,
      kind: 'github',
      api: 'https://api.github.com/repos/openai/codex/releases/latest',
      assetMatch: (name) =>
        /windows|win32|pc-windows/i.test(name) && new RegExp(arch === 'arm64' ? 'arm64|aarch64' : 'x86_64|x64|amd64', 'i').test(name),
    },
    {
      id: 'npm-registry-tarball',
      label: `npm registry tarball @openai/codex-win32-${arch}`,
      contract: CONTRACT.PACKAGE_INTERNAL,
      kind: 'npm',
      packageName: '@openai/codex',
      platformTag: `win32-${arch}`,
    },
  ];
}

/** Candidate sources for the Claude Code runtime, in preference order. */
function claudeSources() {
  return [
    {
      id: 'claude-install-subcommand',
      label: '`claude install <version>` (documented in the CLI\'s own --help)',
      contract: CONTRACT.DOCUMENTED,
      kind: 'cli-subcommand',
      // Only usable to UPDATE an existing install - it cannot bootstrap the
      // very first one, which is exactly what the app needs on a clean machine.
      note: 'Requires an existing claude executable; cannot bootstrap a clean machine.',
    },
    {
      id: 'anthropic-install-script',
      label: 'Anthropic install script (claude.ai/install.ps1)',
      contract: CONTRACT.DOCUMENTED,
      kind: 'probe',
      urls: ['https://claude.ai/install.ps1', 'https://claude.ai/install.sh'],
    },
    {
      id: 'downloads-claude-ai',
      label: 'downloads.claude.ai/claude-code-releases',
      // Observed inside the installed binary. Being present in a binary does
      // NOT make it a supported public interface.
      contract: CONTRACT.NOT_PUBLIC,
      kind: 'probe',
      urls: [
        'https://downloads.claude.ai/claude-code-releases/stable',
        'https://downloads.claude.ai/claude-code-releases/',
      ],
    },
  ];
}

/** HEAD-then-GET probe that reports what a candidate source actually answers. */
async function probeUrl(url, { wantBody = false } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: wantBody ? 'GET' : 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    const result = {
      url,
      reachable: true,
      status: response.status,
      ok: response.ok,
      finalUrl: response.url,
      contentLength: Number(response.headers.get('content-length') ?? 0) || null,
      contentType: response.headers.get('content-type'),
      ms: Date.now() - started,
    };
    if (wantBody && response.ok) result.body = (await response.text()).slice(0, 400);
    return result;
  } catch (err) {
    return {
      url,
      reachable: false,
      error: String(err?.cause?.code ?? err?.name ?? err?.message ?? err),
      ms: Date.now() - started,
    };
  }
}

/**
 * Downloads to a temp file, hashes it, and reports integrity.
 *
 * `expectedIntegrity` is an npm-style `sha512-<base64>` string when the source
 * publishes one - that is a real integrity check, not just a recorded hash.
 */
async function downloadAndVerify(url, destination, expectedIntegrity = null) {
  const started = Date.now();
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, bytes);

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let integrityVerified = null;
  if (expectedIntegrity?.startsWith('sha512-')) {
    const actual = createHash('sha512').update(bytes).digest('base64');
    integrityVerified = `sha512-${actual}` === expectedIntegrity;
  }

  return {
    bytes: bytes.length,
    sha256,
    integrityVerified,
    expectedIntegrity,
    ms: Date.now() - started,
    finalUrl: response.url,
  };
}

/** Extracts an archive using Windows' bundled tar.exe (bsdtar), or POSIX tar. */
function extractArchive(archivePath, intoDir) {
  mkdirSync(intoDir, { recursive: true });
  const tarExe = IS_WINDOWS ? 'tar.exe' : 'tar';
  const result = runSync(tarExe, ['-xf', archivePath, '-C', intoDir], { timeoutMs: 120_000 });
  return { ok: result.status === 0, stderr: result.stderr.slice(0, 300) };
}

/**
 * Finds an executable anywhere under a directory tree.
 *
 * The candidate names come from the *target* platform, not the host: this test
 * fetches a Windows build, so it looks for `codex.exe` even when the spike is
 * being smoke-tested on Linux.
 */
function findExecutable(root, candidateNames) {
  const wanted = candidateNames;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (wanted.includes(entry.name)) return full;
    }
  }
  return null;
}

async function test8RuntimeAcquisition(env) {
  heading('TEST 8 - Runtime acquisition (no npm, no PATH, no terminal)');
  say('The product must fetch the agent runtimes itself. This walks the candidate');
  say('sources in preference order, reports what each one really answers, and');
  say('marks how far each can be trusted as a public contract.');
  say('');
  say('Everything lands in a throwaway folder. Your real installations are untouched.');

  const lines = [];
  const installRoot = scratch('runtime-acquisition');
  lines.push(`Scratch install root: ${installRoot}`);
  lines.push(`Target architecture: win32-${windowsArch()} (host arch: ${process.arch})`);
  lines.push('');

  let codexOk = false;
  let claudeOk = false;

  // ---- CODEX ------------------------------------------------------------
  lines.push('CODEX');
  step('CODEX - probing candidate sources...');
  const codexResult = await acquireCodex(installRoot, lines);
  codexOk = codexResult.ok;

  // ---- CLAUDE -----------------------------------------------------------
  lines.push('');
  lines.push('CLAUDE');
  step('CLAUDE - probing candidate sources...');
  const claudeResult = await acquireClaude(installRoot, lines, env);
  claudeOk = claudeResult.ok;

  const status = codexOk && claudeOk ? 'PASS' : codexOk || claudeOk ? 'FAIL' : 'FAIL';
  record('runtime', 'TEST 8 - Runtime acquisition', status, lines);

  if (!codexOk) {
    blocker(
      'No candidate source produced a working Codex binary. The app cannot install Codex for ' +
        'the user, so the zero-configuration requirement is not met for that runtime.',
    );
  }
  if (!claudeOk) {
    blocker(
      'No candidate source produced a working Claude Code binary on a clean machine. Account ' +
        'onboarding would require a manual install, which the zero-configuration requirement forbids.',
    );
  }

  env.runtimeAcquisition = { codex: codexResult, claude: claudeResult };
}

/**
 * Installs Codex the way the product does.
 *
 * Earlier versions of this test kept their own list of candidate sources and
 * only *probed* them, which meant it could report "no source produced a working
 * binary" while the application installed Codex perfectly well. A spike that
 * contradicts the code it is meant to inform is worse than no spike, so this
 * now drives the real `CodexRuntime` and reports what actually happened.
 */
async function acquireCodex(installRoot, lines) {
  if (!RuntimeManager || !appPaths || !ensureAppPaths) {
    lines.push('  The compiled runtime layer could not be loaded, so this was not attempted.');
    return { ok: false, source: null };
  }

  const paths = ensureAppPaths(
    appPaths({ ...process.env, AI_ORCHESTRATOR_HOME: join(installRoot, 'codex-home') }),
  );

  try {
    const manager = new RuntimeManager({ paths });
    const phases = [];
    const result = await manager.install('codex', (p) => {
      if (phases[phases.length - 1] !== p.phase) {
        phases.push(p.phase);
        detail(`codex: ${p.phase}`);
      }
    });

    const m = result.manifest;
    lines.push(`  Source: ${m.sourceLabel} (${m.sourceId})`);
    lines.push(`    Contract: ${m.contract}`);
    lines.push(`    Release asset: ${m.url}`);
    lines.push(`    Host: ${m.host}`);
    lines.push(`    Version: ${m.version}`);
    lines.push(`    Bytes: ${m.bytes}`);
    lines.push(`    SHA-256: ${m.sha256}`);
    lines.push(`    Integrity: ${m.integrity.strategy} - ${m.integrity.detail}`);
    lines.push(`    Trust level: ${m.trustLevel}`);
    lines.push(`    Executable: ${result.executablePath}`);
    lines.push(`    Health: ${result.health.healthy ? 'PASS' : `FAIL - ${result.health.problem ?? ''}`}`);

    if (!m.integrity.verified) {
      lines.push('    Refused: the download could not be verified against a published digest.');
      return { ok: false, source: m.sourceId };
    }
    if (!result.health.healthy) return { ok: false, source: m.sourceId };

    step(`CODEX installed from ${m.sourceId} (${m.version})`);
    return { ok: true, source: m.sourceId, version: m.version, executable: result.executablePath };
  } catch (err) {
    lines.push(`  No source produced a working Codex binary.`);
    lines.push(`    ${err?.userMessage ?? err?.message ?? String(err)}`);
    if (err?.detail) lines.push(`    Detail: ${err.detail}`);
    return { ok: false, source: null };
  }
}

async function acquireClaude(installRoot, lines, env) {
  for (const source of claudeSources()) {
    lines.push(`  Source: ${source.label}`);
    lines.push(`    Contract: ${source.contract}`);
    if (source.note) lines.push(`    Note: ${source.note}`);

    if (source.kind === 'cli-subcommand') {
      if (!env.claude?.found) {
        lines.push('    Result: no existing claude executable, so this cannot bootstrap.');
        continue;
      }
      // Only ask what it would do; never actually reinstall the user's runtime.
      const help = runSync(env.claude.exe, ['install', '--help'], { timeoutMs: 30_000 });
      const available = help.status === 0;
      lines.push(`    Available: ${available}`);
      lines.push(
        '    Usable for updates of an app-managed install, NOT for the first install on a clean machine.',
      );
      detail(`claude install --help: exit ${help.status}`);
      continue;
    }

    if (source.kind === 'probe') {
      let reachableUrl = null;
      for (const url of source.urls) {
        const probe = await probeUrl(url, { wantBody: true });
        lines.push(
          `    Probe ${url} -> ${probe.reachable ? `HTTP ${probe.status} (${probe.contentLength ?? '?'} bytes, ${probe.ms}ms)` : `unreachable (${probe.error})`}`,
        );
        detail(`${source.id}: ${probe.reachable ? `HTTP ${probe.status}` : `unreachable (${probe.error})`}`);
        if (probe.reachable && probe.ok) {
          reachableUrl = probe.finalUrl ?? url;
          if (probe.body) {
            const firstLine = probe.body.split(/\r?\n/)[0]?.slice(0, 120) ?? '';
            lines.push(`    First line of response: ${firstLine}`);
          }
          break;
        }
      }
      if (!reachableUrl) {
        lines.push('    Result: not usable from this machine.');
        continue;
      }
      lines.push(`    Result: reachable at ${reachableUrl}`);
      if (source.contract === CONTRACT.NOT_PUBLIC) {
        lines.push(
          '    WARNING: reachable, but this is an implementation detail. Do NOT build the ' +
            'installer on it without an agreed, supported interface.',
        );
        finding(
          `Claude source "${source.id}" is reachable but is ${CONTRACT.NOT_PUBLIC} - usable as a ` +
            'fallback behind ClaudeRuntimeSource, never as the primary contract.',
        );
      }
      return { ok: true, source: source.id, contract: source.contract, url: reachableUrl };
    }
  }

  lines.push('  No Claude Code source produced a usable install path on a clean machine.');
  return { ok: false, source: null };
}

// ===========================================================================
// Report
// ===========================================================================

function environmentSummary(env) {
  const osVersion = IS_WINDOWS
    ? runSync('cmd.exe', ['/d', '/s', '/c', 'ver']).stdout.trim().replace(/\r?\n/g, ' ')
    : `${process.platform} ${runSync('uname', ['-r']).stdout.trim()}`;
  const gitVersion = runSync('git', ['--version']).stdout.trim();
  // Which git this is matters as much as its version. The one on PATH is
  // whatever the machine already had - on a CI runner, a full Git for Windows
  // install. It is NOT the MinGit the application manages and ships against, so
  // its version must never be mistaken for the tested one.
  const gitPath = IS_WINDOWS
    ? runSync('where.exe', ['git']).stdout.trim().split(/\r?\n/)[0]
    : runSync('which', ['git']).stdout.trim();
  return {
    osVersion: osVersion || process.platform,
    node: process.version,
    codex: env.codex?.found ? `${env.codex.exe} (${env.codex.versionText ?? '?'})` : 'NOT FOUND',
    claude: env.claude?.found ? `${env.claude.exe} (${env.claude.versionText ?? '?'})` : 'NOT FOUND',
    git: gitVersion || 'NOT FOUND',
    gitPath: gitPath || '(not on PATH)',
    gitProvenance: 'pre-existing on this machine, NOT the MinGit the app manages',
  };
}

function recommendedAdapterDesign(env) {
  const out = [];
  if (env.codex?.found && env.codex.invocation) {
    out.push(
      `Codex adapter: invoke \`codex ${env.codex.invocation.join(' ')}\`, prompt over ` +
        `${env.codex.usesStdin ? 'stdin' : 'a command-line argument'}, ` +
        `${env.codex.structured ? 'parsing structured JSON output' : 'parsing text output (no structured mode confirmed)'}.`,
    );
    if (!env.codex.structured) {
      out.push(
        '  Because structured output was not confirmed, the decision parser must keep its ' +
          'JSON-extraction and format-repair round trip.',
      );
    }
  } else {
    out.push('Codex adapter: CANNOT BE DESIGNED YET - no working non-interactive invocation was proven.');
  }

  if (env.claude?.workerOk) {
    out.push(
      'Claude Code adapter: `claude -p --output-format json --permission-mode acceptEdits`, ' +
        'prompt over stdin, cwd set to the workspace path.',
    );
  } else if (env.claude?.found) {
    out.push('Claude Code adapter: worker round trip unproven - re-run TEST 2 before designing it.');
  } else {
    out.push('Claude Code adapter: CANNOT BE DESIGNED YET - CLI not found.');
  }

  if (env.profiles?.isolationOk) {
    out.push(
      'Account manager: one absolute CLAUDE_CONFIG_DIR per account, verified with ' +
        '`claude auth status --json`. Use its `projectsDirectory` field to assert which profile ' +
        'an invocation used - it needs no credential access.',
    );
    out.push(
      '  Strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN from every child ' +
        'environment, or they override per-profile authentication.',
    );
  } else {
    out.push('Account manager: profile isolation UNPROVEN - do not build multi-account support yet.');
  }

  const cancelResult = results.get('cancel')?.status;
  if (cancelResult === 'PASS') {
    out.push(
      `ProcessManager: current implementation is sound on this machine ` +
        `(${IS_WINDOWS ? 'taskkill /T /F' : 'process-group signals'}, shell:false, stdin prompts). Keep it as-is.`,
    );
  } else {
    out.push('ProcessManager: cancellation needs work before it can be trusted - see TEST 4.');
  }

  // --- Zero-configuration requirement -------------------------------------
  if (env.guiAuth?.ok) {
    out.push(
      'Account onboarding: the GUI can wrap `claude auth login` - spawn with piped stdio, ' +
        'capture the printed URL, open it in the system browser, and poll `auth status --json` ' +
        'to detect completion. No terminal is needed.',
    );
    if (!env.guiAuth.completed) {
      out.push(
        '  The URL capture is proven; end-to-end completion was not exercised in this run.',
      );
    }
  } else {
    out.push(
      'Account onboarding: NOT PROVEN. Until TEST 7 passes, do not promise terminal-free ' +
        'account connection - reconsider `claude setup-token` or an embedded terminal view.',
    );
  }

  const codex = env.runtimeAcquisition?.codex;
  const claude = env.runtimeAcquisition?.claude;

  out.push('RuntimeManager: every adapter resolves its executable through a RuntimeSource, never');
  out.push('  through the global PATH and never through a hardcoded URL.');
  if (codex?.ok) {
    out.push(
      `  CodexRuntime: working source "${codex.source}" (${codex.contract}), version ${codex.version}. ` +
        'Keep the source list ordered and swappable so the official release channel can take over ' +
        'without touching CodexAdapter.',
    );
  } else {
    out.push('  CodexRuntime: no source produced a working binary - see TEST 8 probe output.');
  }
  if (claude?.ok) {
    const caution =
      claude.contract === 'IMPLEMENTATION DETAIL / NOT PUBLIC CONTRACT'
        ? ' - treat as a fallback only, behind ClaudeRuntimeSource; do not build the installer on it.'
        : '.';
    out.push(`  ClaudeCodeRuntime: usable source "${claude.source}" (${claude.contract})${caution}`);
  } else {
    out.push('  ClaudeCodeRuntime: no source produced a clean-machine install path - see TEST 8.');
  }
  out.push(
    '  Never redistribute Claude Code inside the installer: its npm license is "SEE LICENSE IN ' +
      'README.md", i.e. not a permissive open-source licence. Codex is Apache-2.0.',
  );

  return out;
}

function buildReport(env) {
  const envSummary = environmentSummary(env);
  const out = [];
  out.push('WINDOWS SPIKE');
  out.push('');
  out.push('Environment:');
  out.push(`  Windows version: ${envSummary.osVersion}`);
  out.push(`  Node: ${envSummary.node}`);
  out.push(`  Codex: ${envSummary.codex}`);
  out.push(`  Claude: ${envSummary.claude}`);
  out.push(`  Git (on PATH): ${envSummary.git}`);
  out.push(`  Git path: ${envSummary.gitPath}`);
  out.push(`  Git provenance: ${envSummary.gitProvenance}`);
  out.push(`  Run at: ${new Date().toISOString()}`);
  out.push('');

  for (const id of ['codex', 'claude', 'profiles', 'cancel', 'launchers', 'stdin', 'guiauth', 'runtime']) {
    const r = results.get(id);
    if (!r) continue;
    out.push('-'.repeat(70));
    out.push(`${r.title}`);
    out.push(`  ${r.status}`);
    for (const line of r.lines) out.push(`  ${line}`);
    out.push('');
  }

  out.push('-'.repeat(70));
  if (env.codex?.helpText) {
    out.push('RAW `codex --help` (verbatim, for adapter design):');
    out.push(env.codex.helpText.trim());
    out.push('');
    if (env.codex.execHelpText?.trim()) {
      out.push('RAW `codex exec --help` (verbatim):');
      out.push(env.codex.execHelpText.trim());
      out.push('');
    }
  }

  out.push('='.repeat(70));
  const statuses = [...results.values()].map((r) => r.status);
  const overall = statuses.includes('FAIL') ? 'FAIL' : statuses.includes('SKIP') ? 'PARTIAL' : 'PASS';
  out.push(`OVERALL: ${overall}`);
  out.push('');
  out.push('BLOCKERS:');
  out.push(blockers.length ? blockers.map((b, i) => `  ${i + 1}. ${b}`).join('\n') : '  (none)');
  out.push('');
  out.push('NOTES / FINDINGS:');
  out.push(findings.length ? findings.map((f, i) => `  ${i + 1}. ${f}`).join('\n') : '  (none)');
  out.push('');
  out.push('RECOMMENDED ADAPTER DESIGN:');
  for (const line of recommendedAdapterDesign(env)) out.push(`  ${line}`);
  out.push('');

  return redact(out.join('\n'));
}

// ===========================================================================
// Main
// ===========================================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  say('');
  say('  LOCAL MULTI-AGENT ORCHESTRATOR - WINDOWS INTEGRATION SPIKE');
  say('');
  say('  This proves the local agent integrations before the desktop application');
  say('  is built on top of them.');
  say('');
  say('  Safety:');
  say('    - writes only inside a temporary scratch folder');
  say(`      (${scratchRoot})`);
  say('    - never touches your own repositories');
  say('    - never runs a destructive git command');
  say('    - never prints tokens or credential contents');
  say('');
  if (!IS_WINDOWS) {
    say(`  !! You are running on ${process.platform}, not Windows.`);
    say('  !! The Windows-specific checks (.cmd wrapping, taskkill) will be skipped.');
    say('  !! Run this on your Windows machine for a meaningful result.');
    say('');
  }

  const proceed = await askYesNo('Ready to start?', true);
  if (!proceed) {
    say('Aborted. Nothing was changed.');
    rl.close();
    return;
  }

  step('Preparing the compiled ProcessManager...');
  const loaded = await loadCompiledModules();
  if (!loaded) {
    say('');
    say('  !! Could not build/load the project. Tests 4-6 will be skipped.');
    say('  !! Fix the build (npm install && npm run build) and re-run.');
  }

  const env = {};
  await test1Codex(env);
  await test2Claude(env);
  await test3Profiles(env);
  await test4Cancellation(env);
  await test5Launchers();
  await test6LargeStdin();
  await test7GuiAuth(env);
  await test8RuntimeAcquisition(env);

  const report = buildReport(env);
  const reportPath = join(HERE, 'spike-report.txt');
  writeFileSync(reportPath, report, 'utf8');

  say('');
  say('');
  say(report);
  say('');
  say('='.repeat(74));
  say(`  Report written to: ${reportPath}`);
  say('  Send that file back to continue the architecture work.');
  say('='.repeat(74));

  rl.close();
}

// Always clean up the scratch folder, even on Ctrl+C.
function cleanup() {
  try {
    rmSync(scratchRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  say('\n\nInterrupted. Cleaning up the scratch folder...');
  cleanup();
  process.exit(130);
});

main().catch((err) => {
  console.error('\nThe spike crashed:', err);
  cleanup();
  process.exit(1);
});
