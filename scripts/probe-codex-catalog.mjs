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
 * The turn is the adapter's turn: the decision schema is passed with
 * `--output-schema`, and the fake backend checks what arrives the way the
 * real Responses API does - `text.format.strict` is true on every exec
 * turn, so the schema must satisfy strict structured-output rules (every
 * property required, objects closed) or the real API answers 400 before
 * any decision exists.
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
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
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
/**
 * The decision the fake backend answers the turn with.
 *
 * Deliberately a `verify` carrying a `fileChecks` entry, and deliberately the
 * whole contract rather than a handful of fields: this is the shape a strict
 * schema *forces* - every property present, unasserted ones null - and the
 * probe's job is to prove that shape survives the round trip through a real
 * binary and comes back out of `--output-last-message` intact.
 */
const DECISION = {
  action: 'verify',
  task: null,
  acceptanceCriteria: [
    'hello.txt existe e contém exatamente os bytes UTF-8 70 72 6F 6E 74 6F, sem BOM e sem quebra de linha.',
  ],
  verificationCommands: [],
  fileChecks: [
    {
      path: 'hello.txt',
      mustExist: true,
      expectBytesHex: '70726F6E746F',
      expectText: null,
      expectSizeBytes: 6,
      forbidBom: true,
      forbidTrailingNewline: true,
      criteria: [
        'hello.txt existe e contém exatamente os bytes UTF-8 70 72 6F 6E 74 6F, sem BOM e sem quebra de linha.',
      ],
    },
  ],
  workerId: null,
  requiresTools: false,
  satisfiedCriteria: [],
  relevantFiles: ['hello.txt'],
  summary: 'Verificar diretamente os seis bytes de hello.txt.',
  reason: null,
  workerRequirements: {
    capability: 'fast',
    reasoning: 'low',
    rationale: 'Comparação direta dos bytes de um arquivo.',
  },
};

/** The application's own decision schema and strict-mode check, from dist. */
async function loadDecisionSchema() {
  const dist = new URL('../dist/orchestrator/decision-schema.js', import.meta.url);
  try {
    const mod = await import(dist.href);
    return { schema: mod.DECISION_JSON_SCHEMA, problemsOf: mod.strictSchemaProblems };
  } catch {
    return null;
  }
}

/**
 * The application's own parser, so the round trip is closed.
 *
 * Sending a schema the CLI accepts is half the claim; the other half is that
 * what comes back out of `--output-last-message` is something the application
 * can act on. Checking only for the string `"action"` would have missed the
 * case this probe now covers: strict mode requires every property, so an
 * unasserted field arrives as `null`, and a parser that read `null` as "wrong
 * type" would refuse a decision the schema itself demanded.
 */
async function loadDecisionParser() {
  try {
    const mod = await import(new URL('../dist/orchestrator/decision-parser.js', import.meta.url).href);
    return mod.parseDecision;
  } catch {
    return null;
  }
}

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

/** The request body as text, whatever Content-Encoding the client chose. */
function decodeBody(raw, encoding) {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'zstd':
      return zstdDecompressSync(raw).toString('utf8');
    case 'gzip':
      return gunzipSync(raw).toString('utf8');
    case 'br':
      return brotliDecompressSync(raw).toString('utf8');
    case 'deflate':
      return inflateSync(raw).toString('utf8');
    default:
      return raw.toString('utf8');
  }
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
  const decisionSchema = await loadDecisionSchema();
  /** What the fake saw in `text.format` of the turn request, if anything. */
  let format = null;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    seen.push(`${req.method} ${url.pathname}`);
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"probe"' });
      res.end(catalogue);
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/responses')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        // The CLI compresses the turn request (zstd, seen on 0.153.x); the
        // fake reads it the way the real backend does, by Content-Encoding.
        let body = '';
        try {
          body = decodeBody(Buffer.concat(chunks), req.headers['content-encoding']);
        } catch (error) {
          if (process.env.AI_ORCHESTRATOR_PROBE_DUMP === '1') log(`# request body could not be decoded: ${String(error)}`);
        }
        try {
          const parsed = JSON.parse(body);
          format = parsed?.text?.format ?? null;
          if (process.env.AI_ORCHESTRATOR_PROBE_DUMP === '1') {
            log(`# request keys: ${Object.keys(parsed ?? {}).join(', ')}`);
            log(`# request text: ${JSON.stringify(parsed?.text ?? null).slice(0, 600)}`);
          }
        } catch (error) {
          format = null;
          if (process.env.AI_ORCHESTRATOR_PROBE_DUMP === '1') {
            log(`# request body not JSON (${String(error).slice(0, 80)}); headers: ${JSON.stringify(req.headers)}; head: ${body.slice(0, 200)}`);
          }
        }
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
  if (decisionSchema) {
    const schemaPath = join(home, 'decision.schema.json');
    writeFileSync(schemaPath, JSON.stringify(decisionSchema.schema, null, 2), 'utf8');
    args.push('--output-schema', schemaPath);
  }
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

  // And the application can read it. A decision the parser refuses is not a
  // decision, whatever the transport did.
  const parseDecision = await loadDecisionParser();
  let decisionParsed = null;
  let decisionParseError = null;
  if (parseDecision && decision !== null) {
    const parsed = parseDecision(decision);
    decisionParsed = parsed.ok;
    if (!parsed.ok) decisionParseError = parsed.error;
    else if ((parsed.decision.fileChecks ?? []).length === 0) {
      decisionParsed = false;
      decisionParseError = 'the file check did not survive the round trip';
    }
  }

  // The schema check: when the application's schema was sent, the CLI must
  // have forwarded it in strict mode, and it must satisfy the strict rules
  // the real API enforces. Both are asserted against what the fake received,
  // not against what was written to disk.
  const schemaSent = decisionSchema !== null;
  const schemaStrict = format?.type === 'json_schema' && format?.strict === true;
  const schemaProblems =
    schemaSent && format?.schema ? decisionSchema.problemsOf(format.schema) : schemaSent ? ['the schema did not reach the request'] : [];
  const schemaOk = !schemaSent || (schemaStrict && schemaProblems.length === 0);

  return {
    exitCode: result.code,
    signal: result.signal,
    unknownVariant,
    catalogueRequested,
    turnRequested,
    producedDecision,
    decision,
    schemaSent,
    schemaStrict,
    schemaProblems,
    decisionParsed,
    decisionParseError,
    requests: seen,
    stderrTail: result.stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-6),
    pass:
      !unknownVariant &&
      catalogueRequested &&
      turnRequested &&
      producedDecision &&
      schemaOk &&
      decisionParsed !== false,
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
  console.log(`# schema sent: ${result.schemaSent}; strict: ${result.schemaStrict}; problems: ${result.schemaProblems.join('; ') || 'none'}`);
  console.log(`# decision parsed by the application: ${result.decisionParsed ?? 'not checked'}${result.decisionParseError ? ` (${result.decisionParseError})` : ''}`);
  for (const line of result.stderrTail) console.log(`#   stderr: ${line}`);
  console.log(result.pass ? '# PASS: the catalogue with max was accepted and the decision came back' : '# FAIL');
  process.exit(result.pass ? 0 : 1);
}
