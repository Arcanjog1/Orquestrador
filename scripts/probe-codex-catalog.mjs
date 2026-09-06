/**
 * Does this Codex binary survive the model catalogue the real backend serves?
 *
 * The incident: on a Windows machine, `codex exec` died at start-up with
 *
 *   failed to refresh available models: ... failed to decode models response:
 *   unknown variant `max`, expected one of `none`, `minimal`, `low`, `medium`,
 *   `high`, `xhigh`
 *
 * and the orchestrator loop, seeing an empty answer, reported a parse failure.
 * The catalogue is served by OpenAI, so the only thing the application can
 * choose is the binary. This probe puts a binary in front of a catalogue that
 * carries `max` and `ultra` - the entries the real backend returns, taken
 * from the CLI's own bundled catalogue - and reports whether it crashes.
 *
 * Nothing external is contacted: a fake ChatGPT backend runs on localhost,
 * `chatgpt`-mode credentials are forged in a throwaway CODEX_HOME (no real
 * account is involved or touched), and `codex exec` is driven exactly as the
 * adapter drives it - prompt on stdin, `--output-last-message`, sandbox
 * read-only. When the catalogue is accepted, the fake answers the model turn
 * with a structured decision, so a passing run ends with the decision in
 * the last-message file: the adapter's whole path, on a real binary.
 *
 * Usage:
 *   node scripts/probe-codex-catalog.mjs --codex <path-to-codex>
 *   node scripts/probe-codex-catalog.mjs --managed   (the app's installed runtime)
 *
 * Exit code 0 when the binary accepted the catalogue and produced the
 * decision; 1 when it printed `unknown variant` or produced nothing.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const FIXTURE = join(here, 'fixtures', 'codex-models-with-max.json');
const DECISION = {
  action: 'delegate',
  task: 'Create hello.txt containing exactly: Olá AI Orchestrator',
  acceptanceCriteria: ['hello.txt exists with the exact content'],
  verificationCommands: [],
  summary: 'probe decision',
};

async function resolveCodex() {
  const explicit = arg('--codex');
  if (explicit) return explicit;
  if (argv.includes('--managed')) {
    const dist = new URL('../dist/', import.meta.url);
    const { RuntimeManager } = await import(new URL('runtime/runtime-manager.js', dist).href);
    const { appPaths } = await import(new URL('runtime/paths.js', dist).href);
    const manager = new RuntimeManager({ paths: appPaths(process.env) });
    return manager.getExecutablePath('codex');
  }
  throw new Error('pass --codex <path> or --managed');
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A JWT the CLI parses locally for claims and never verifies. */
function fakeJwt(claims) {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.sig`;
}

export async function probeCodexCatalog(codexPath, { log = () => {} } = {}) {
  const catalogue = readFileSync(FIXTURE, 'utf8');
  const seen = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    seen.push(`${req.method} ${url.pathname}`);
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"probe"' });
      res.end(catalogue);
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/responses')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const item = {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(DECISION) }],
          },
        };
        const completed = { type: 'response.completed', response: { id: 'resp-probe', usage: null } };
        res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-probe' } })}\n\n`);
        res.write(`event: response.output_item.done\ndata: ${JSON.stringify(item)}\n\n`);
        res.write(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
        res.end();
      });
      return;
    }
    // Anything else (telemetry, rate limits, feature flags) is not part of
    // the probe: answered empty so the binary moves on.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const home = mkdtempSync(join(tmpdir(), 'lao-codex-catalog-'));
  const codexHome = join(home, 'codex-home');
  const work = join(home, 'work');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(work, { recursive: true });

  // The built-in provider cannot be redefined in config.toml; its base URL
  // comes from OPENAI_BASE_URL, and must end with /backend-api/codex for the
  // CLI to use its ChatGPT routes - the ones that refresh the catalogue.
  writeFileSync(
    join(codexHome, 'config.toml'),
    [
      'model = "gpt-probe"',
      `chatgpt_base_url = "${base}/backend-api"`,
      `openai_base_url = "${base}/backend-api/codex"`,
      '',
    ].join('\n'),
    'utf8',
  );
  const claims = {
    email: 'probe@example.invalid',
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'pro',
      chatgpt_account_id: 'acct-probe',
      chatgpt_user_id: 'user-probe',
    },
  };
  writeFileSync(
    join(codexHome, 'auth.json'),
    JSON.stringify(
      {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: fakeJwt(claims),
          access_token: fakeJwt({ ...claims, scope: 'probe' }),
          refresh_token: 'probe-refresh',
          account_id: 'acct-probe',
        },
        last_refresh: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  const lastMessage = join(home, 'last-message.txt');
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', lastMessage];
  log(`# ${codexPath} ${args.join(' ')}`);

  const result = await new Promise((resolve) => {
    const child = spawn(codexPath, args, {
      cwd: work,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENAI_BASE_URL: `${base}/backend-api/codex`,
        // No proxy between the binary and the fake on localhost.
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        http_proxy: '',
        https_proxy: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end('Reply with the decision.');
  });

  let decision = null;
  try {
    decision = readFileSync(lastMessage, 'utf8').trim();
  } catch {
    decision = null;
  }
  server.close();
  rmSync(home, { recursive: true, force: true });

  const unknownVariant = /unknown variant/i.test(result.stderr) || /unknown variant/i.test(result.stdout);
  const catalogueRequested = seen.some((s) => s.endsWith('/models'));
  const turnRequested = seen.some((s) => s.endsWith('/responses'));
  const producedDecision = decision !== null && decision.includes('"action"');
  return {
    exitCode: result.code,
    signal: result.signal,
    unknownVariant,
    catalogueRequested,
    turnRequested,
    producedDecision,
    decision,
    requests: seen,
    stderrTail: result.stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-6),
    pass: !unknownVariant && catalogueRequested && turnRequested && producedDecision,
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const codex = await resolveCodex();
  const result = await probeCodexCatalog(codex, { log: console.log });
  console.log(`# requests: ${result.requests.join(' | ')}`);
  console.log(`# exit ${result.exitCode}${result.signal ? ` (${result.signal})` : ''}`);
  console.log(`# unknown variant: ${result.unknownVariant}`);
  console.log(`# catalogue requested: ${result.catalogueRequested}`);
  console.log(`# turn requested: ${result.turnRequested}`);
  console.log(`# decision produced: ${result.producedDecision}`);
  for (const line of result.stderrTail) console.log(`#   stderr: ${line}`);
  console.log(result.pass ? '# PASS: the catalogue with max was accepted and the decision came back' : '# FAIL');
  process.exit(result.pass ? 0 : 1);
}
