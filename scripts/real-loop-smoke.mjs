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
 *   node scripts/real-loop-smoke.mjs --two-step     # a second iteration by construction
 *
 * `--two-step` registers a verification in two stages (scripts/lib/
 * two-stage-check.mjs): the objective asks for hello.txt only; the check also
 * requires bye.txt, and says so only once hello.txt is right. The script sits
 * outside the workspace and the orchestrator is shown a verification's id and
 * label, never its command, so a first attempt that follows the objective
 * perfectly still fails verification - and the second worker prompt can only
 * come from the orchestrator reading that failure. Nothing here composes it.
 *
 * It works in a scratch git repository under the system temp directory and
 * never touches a real project. Once a workspace has been registered for it,
 * the directory (and the check next to it) is kept, so the run stays
 * reviewable in the application's history instead of pointing at a folder
 * that no longer exists.
 * Run `npm run desktop:build` first.
 *
 * No credential is read, written or printed here; the accounts already exist in
 * the application's own database.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { collectLoopEvidence, printLoopEvidence } from './lib/loop-evidence.mjs';
import { writeTwoStageCheck } from './lib/two-stage-check.mjs';

const twoStep = process.argv.includes('--two-step');
const EXPECTED = 'Olá AI Orchestrator';
/** The second stage. Known to the check script and to nothing the agents see. */
const SECOND_STAGE = { file: 'bye.txt', content: 'Tchau' };

const built = new URL('../apps/desktop/dist/apps/desktop/src/main/services/app-services.js', import.meta.url);
if (!existsSync(built)) {
  console.error('Build the desktop application first: npm run desktop:build');
  process.exit(1);
}
const { AppServices } = await import(pathToFileURL(built.pathname).href);

/* A scratch repository, and a verification kept outside it. ---------------- */

const dir = mkdtempSync(join(tmpdir(), 'lao-real-loop-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'smoke@local');
git('config', 'user.name', 'smoke');
writeFileSync(join(dir, 'README.md'), '# scratch workspace for the real-loop smoke\n');
git('add', '-A');
git('commit', '-q', '-m', 'baseline');

const check = writeTwoStageCheck({
  hello: EXPECTED,
  then: twoStep ? SECOND_STAGE : null,
  prefix: 'lao-real-loop-check-',
});

/* Drive the real services. ------------------------------------------------ */

const services = new AppServices();
let failed = false;
/** Set once the application knows this directory; from then on it is kept. */
let registered = false;
/**
 * Leaving early has to go through the cleanup below, which `process.exit`
 * inside the `try` would skip - and leave the scratch directories behind.
 */
class EarlyExit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}
let exitCode = 0;
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
    throw new EarlyExit(2);
  }
  say(true, 'accounts', `${openai.name} (openai), ${anthropic.name} (anthropic)`);

  const workspace = services.workspaces.create({ name: 'Real loop smoke', localPath: dir });
  services.database.verifications.upsert({
    id: 'registered-check',
    workspaceId: workspace.id,
    label: 'o workspace passa na verificação registrada',
    command: check.command,
  });
  // The team is bound by account, exactly as the interface binds it.
  services.workspaces.setTeam(
    workspace.id,
    { accountId: openai.id },
    { accountId: anthropic.id },
  );
  registered = true;
  say(true, 'workspace', dir);

  const session = services.chat.createSession(workspace.id, 'Smoke');
  const objective = twoStep
    ? `Crie um arquivo chamado hello.txt contendo exatamente: ${EXPECTED}. ` +
      'A verificação registrada neste workspace é o critério de aceitação completo: peça-a por id ' +
      'em toda iteração e, se ela falhar, delegue exatamente a correção que ela reportar. ' +
      'Só responda done quando ela passar.'
    : `Crie um arquivo chamado hello.txt contendo exatamente: ${EXPECTED}. Depois verifique se o arquivo existe e contém exatamente esse texto.`;
  if (twoStep) {
    const leaks = new RegExp(`${SECOND_STAGE.file}|${SECOND_STAGE.content}`).test(objective);
    say(!leaks, 'objective-omits-second-stage', leaks ? 'the objective reveals it' : 'the user message names hello.txt only');
    say(!existsSync(join(dir, 'check.mjs')), 'check-outside-workspace', check.command);
  }

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
    const first = verifications.find((v) => v.iteration === 1);
    say(first !== undefined && first.passed === 0, 'first-verification-failed', first ? `it1 exit=${first.exit_code}` : 'no verification on iteration 1');

    // The second stage cannot be satisfied by an attempt that only knows the
    // objective, so one worker turn means the loop never reached a review of
    // a failure - reported as partial rather than folded into PASS or FAIL.
    if (workerTurns >= 2) {
      say(true, 'second-prompt-was-automatic', `${workerTurns} worker turns from one user message`);
    } else {
      say(false, 'second-prompt-was-automatic', `only ${workerTurns} worker turn; two-step not exercised (PARTIAL, run again)`);
    }

    // The proof itself: the second prompt the loop handed the worker is the
    // orchestrator's decision.task, and it names the file the objective never
    // mentioned - which it can only have read from the verification's output.
    const prompts = invocations.filter((i) => i.role === 'CODING_WORKER').map((i) => i.task);
    const second = prompts[1] ?? null;
    const fromReview =
      second !== null && second !== objective && new RegExp(`${SECOND_STAGE.file}|${SECOND_STAGE.content}`).test(second);
    say(fromReview, 'second-prompt-from-review', second ? JSON.stringify(second.slice(0, 300)) : 'no second prompt');
    const bye = existsSync(join(dir, SECOND_STAGE.file)) ? readFileSync(join(dir, SECOND_STAGE.file), 'utf8').trim() : null;
    say(bye === SECOND_STAGE.content, 'second-stage-file', JSON.stringify(bye));
  }
  say(run.status === 'DONE', 'done-gate', `${run.status}${run.summary ? ` - ${run.summary}` : ''}`);

  const hello = existsSync(join(dir, 'hello.txt'))
    ? readFileSync(join(dir, 'hello.txt'), 'utf8').trim()
    : null;
  say(hello === EXPECTED, 'file-content', JSON.stringify(hello));

  // The record, read back from the database rather than from anything the
  // agents said: every turn, every prompt the loop handed the worker, every
  // verdict, and the gate. This is what makes the run reviewable afterwards.
  printLoopEvidence(collectLoopEvidence(services.database, sent.run.id, session.id));
} catch (err) {
  if (!(err instanceof EarlyExit)) throw err;
  exitCode = err.code;
} finally {
  services.database.close();
  await services.processManager.cancelAll();
  if (registered) {
    console.log(`# scratch workspace kept at ${dir} so the run stays reviewable in the app`);
    console.log(`# its verification kept at ${check.path}`);
  } else {
    rmSync(dir, { recursive: true, force: true });
    rmSync(check.dir, { recursive: true, force: true });
  }
}

if (exitCode === 0) console.log(failed ? '# fail' : '# pass');
process.exit(failed ? 1 : exitCode);
