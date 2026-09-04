/**
 * The autonomous loop, against the real providers.
 *
 * The deterministic end-to-end test proves the mechanism with fake agents. This
 * proves the same path with the real ones, on a machine where the accounts have
 * been connected through the application. It builds nothing of its own: it uses
 * `AppServices` exactly as Electron does, so the runners are the real
 * CodexAdapter and ClaudeCodeAdapter reading the accounts the GUI signed in.
 *
 *   node scripts/real-loop-smoke.mjs                # one file, one iteration
 *   node scripts/real-loop-smoke.mjs --two-step     # forces a correction pass
 *
 * It works in a throwaway git repository under the system temp directory and
 * never touches a real project. Run `npm run desktop:build` first.
 *
 * No credential is read, written or printed here; the accounts already exist in
 * the application's own database.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const twoStep = process.argv.includes('--two-step');
const EXPECTED = 'Olá AI Orchestrator';

const built = new URL('../apps/desktop/dist/apps/desktop/src/main/services/app-services.js', import.meta.url);
if (!existsSync(built)) {
  console.error('Build the desktop application first: npm run desktop:build');
  process.exit(1);
}
const { AppServices } = await import(pathToFileURL(built.pathname).href);

/* A scratch repository with one registered verification. ------------------ */

const dir = mkdtempSync(join(tmpdir(), 'lao-real-loop-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'smoke@local');
git('config', 'user.name', 'smoke');

const checks = [
  "import { readFileSync } from 'node:fs';",
  'const want = ' + JSON.stringify(EXPECTED) + ';',
  'const read = (f) => { try { return readFileSync(f, "utf8").trim(); } catch { return null; } };',
  'const problems = [];',
  'const hello = read("hello.txt");',
  'if (hello !== want) problems.push(`hello.txt is ${JSON.stringify(hello)}, expected ${JSON.stringify(want)}`);',
];
if (twoStep) {
  checks.push(
    'const bye = read("bye.txt");',
    'if (bye !== "Tchau") problems.push(`bye.txt is ${JSON.stringify(bye)}, expected "Tchau"`);',
  );
}
checks.push(
  'if (problems.length) { for (const p of problems) console.error(p); process.exit(1); }',
  'console.log("ok");',
);
writeFileSync(join(dir, 'check.mjs'), checks.join('\n'));
git('add', '-A');
git('commit', '-q', '-m', 'baseline');

/* Drive the real services. ------------------------------------------------ */

const services = new AppServices();
let failed = false;
const say = (ok, name, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok' : 'not ok'} - ${name}: ${detail}`);
};

try {
  const accounts = services.accounts.list();
  const connected = accounts.filter((a) => a.state === 'connected');
  const openai = connected.find((a) => a.provider === 'openai');
  const anthropic = connected.find((a) => a.provider === 'anthropic');
  if (!openai || !anthropic) {
    console.log('# no connected account for both providers on this machine.');
    console.log('# Connect OpenAI and Anthropic in the application, then run this again.');
    console.log(`# found: ${accounts.map((a) => `${a.provider}=${a.state}`).join(', ') || '(none)'}`);
    process.exit(2);
  }
  say(true, 'accounts', `${openai.name} (openai), ${anthropic.name} (anthropic)`);

  const workspace = services.workspaces.create({ name: 'Real loop smoke', localPath: dir });
  services.database.verifications.upsert({
    id: 'content-exact',
    workspaceId: workspace.id,
    label: 'os arquivos combinados têm o conteúdo exato',
    command: 'node check.mjs',
  });
  const agents = services.agents.list();
  const orchestrator = agents.find((a) => a.role === 'ORCHESTRATOR' && a.accountId === openai.id);
  const worker = agents.find((a) => a.role === 'CODING_WORKER' && a.accountId === anthropic.id);
  if (!orchestrator || !worker) {
    say(false, 'agents', 'no agent bound to each connected account');
    process.exit(1);
  }
  services.workspaces.setAgents(workspace.id, orchestrator.id, worker.id);
  say(true, 'workspace', dir);

  const session = services.chat.createSession(workspace.id, 'Smoke');
  const objective = twoStep
    ? `Crie hello.txt contendo exatamente: ${EXPECTED}. Depois use a verificação registrada para confirmar que está tudo certo.`
    : `Crie um arquivo chamado hello.txt contendo exatamente: ${EXPECTED}. Depois verifique que o arquivo contém exatamente esse texto.`;

  // One message. Everything after this is the loop's own doing.
  const sent = services.chat.sendMessage(session.id, objective);
  say(true, 'run-started', sent.run.id);

  const seen = [];
  services.events.subscribe((channel, payload) => {
    if (channel === 'run:progress' && payload.runId === sent.run.id) {
      seen.push(payload.stage);
      console.log(`#   ${payload.stage}: ${payload.label}`);
    }
  });

  const run = await services.orchestration.waitFor(sent.run.id, 30 * 60_000);

  const invocations = services.database.runs.invocations(sent.run.id);
  const workerTurns = invocations.filter((i) => i.role === 'CODING_WORKER').length;
  const verifications = services.database.runs.verifications(sent.run.id);

  say(workerTurns >= 1, 'worker-invoked', `${workerTurns} turn(s)`);
  say(seen.includes('evidence'), 'evidence-collected', seen.includes('evidence') ? 'yes' : 'never reached');
  say(verifications.length > 0, 'verification-ran', `${verifications.length} result(s)`);
  if (twoStep) {
    say(workerTurns >= 2, 'second-prompt-was-automatic', `${workerTurns} worker turns from one user message`);
  }
  say(run.status === 'DONE', 'done-gate', `${run.status}${run.summary ? ` - ${run.summary}` : ''}`);

  const hello = existsSync(join(dir, 'hello.txt'))
    ? readFileSync(join(dir, 'hello.txt'), 'utf8').trim()
    : null;
  say(hello === EXPECTED, 'file-content', JSON.stringify(hello));
} finally {
  services.database.close();
  await services.processManager.cancelAll();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? '# fail' : '# pass');
process.exit(failed ? 1 : 0);
