/**
 * The staged executable's health check, state by state.
 *
 * The Windows incident: "the executable did not report a version within
 * 180 s" for two identical downloads, and nothing to say whether the process
 * was refused, crashed, exited quietly or really hung. Every one of those is
 * a different state here, each proved with a fake executable that does
 * exactly that, on this platform's dialect (a shell script, or a .cmd).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager, type ProcessResult, type ProcessTrace } from '../src/process/process-manager.js';
import {
  classifyRun,
  describeProbe,
  inspectExecutable,
  isLocalExecutionFailure,
  probeExecution,
  readPe,
  summariseEnv,
} from '../src/runtime/execution-probe.js';
import { fakeExecutableName } from './helpers/fake-runtime-source.js';

const win = process.platform === 'win32';

/** A fake executable in this platform's dialect. */
function fakeExe(dir: string, base: string, body: { sh: string; cmd: string }): string {
  const path = join(dir, fakeExecutableName(base));
  writeFileSync(path, win ? `@echo off\r\n${body.cmd}\r\n` : `#!/bin/sh\n${body.sh}\n`, { mode: 0o755 });
  return path;
}

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `lao-probe-${prefix}-`));
}

/** A minimal PE header: MZ, e_lfanew, "PE\0\0", machine, optional header. */
function fakePe(machine: number, options: { is64?: boolean; signed?: boolean; subsystem?: number } = {}): Buffer {
  const is64 = options.is64 ?? true;
  const buffer = Buffer.alloc(1024);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\0\0', 0x80, 'latin1');
  buffer.writeUInt16LE(machine, 0x84);
  buffer.writeUInt16LE(240, 0x80 + 20); // SizeOfOptionalHeader
  const optional = 0x80 + 24;
  buffer.writeUInt16LE(is64 ? 0x20b : 0x10b, optional);
  buffer.writeUInt16LE(options.subsystem ?? 3, optional + 68);
  const directories = optional + (is64 ? 112 : 96);
  if (options.signed) buffer.writeUInt32LE(15_664, directories + 4 * 8 + 4);
  return buffer;
}

/* ---------------------------------------------------------------- static */

test('static check: a missing, empty or still-growing file is not an executable', async () => {
  const dir = temp('static');
  try {
    const missing = await inspectExecutable(join(dir, 'nope.exe'), { platform: 'win32' });
    assert.equal(missing.exists, false);
    assert.match(missing.problem ?? '', /not there/);

    const empty = join(dir, 'empty.exe');
    writeFileSync(empty, '');
    const emptyResult = await inspectExecutable(empty, { platform: 'win32', sleep: async () => {} });
    assert.match(emptyResult.problem ?? '', /empty/);

    // Grows between the two readings: someone is still writing it.
    const growing = join(dir, 'growing.exe');
    writeFileSync(growing, fakePe(0x8664));
    const grown = await inspectExecutable(growing, {
      platform: 'win32',
      sleep: async () => {
        writeFileSync(growing, Buffer.concat([fakePe(0x8664), Buffer.alloc(10)]));
      },
    });
    assert.equal(grown.stableSize, false);
    assert.match(grown.problem ?? '', /still being written \(1024 then 1034 bytes\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('static check: the PE header says machine, subsystem and signature; the wrong machine is refused', async () => {
  const dir = temp('pe');
  try {
    const good = join(dir, 'codex.exe');
    writeFileSync(good, fakePe(0x8664, { signed: true }));
    const ok = await inspectExecutable(good, { platform: 'win32', arch: 'x64', sleep: async () => {} });
    assert.equal(ok.problem, null);
    assert.equal(ok.format, 'pe');
    assert.deepEqual(ok.pe, { machine: 'x64', is64: true, subsystem: 'console', signed: true });
    assert.equal(ok.sha256?.length, 64);
    assert.equal(ok.openForWrite, true, 'nothing else holds the file');

    const arm = join(dir, 'arm.exe');
    writeFileSync(arm, fakePe(0xaa64));
    const wrong = await inspectExecutable(arm, { platform: 'win32', arch: 'x64', sleep: async () => {} });
    assert.equal(wrong.problem, 'built for arm64, this machine runs x64');

    const text = join(dir, 'text.exe');
    writeFileSync(text, 'this is not a program\n');
    const notPe = await inspectExecutable(text, { platform: 'win32', sleep: async () => {} });
    assert.match(notPe.problem ?? '', /no MZ\/PE header \(starts with 74 68 69 73\)/);

    // Not hashing is the cheap mode routine health checks use.
    const light = await inspectExecutable(good, { platform: 'win32', sleep: async () => {}, hash: false });
    assert.equal(light.sha256, null);

    // The real codex.exe's header facts, read the same way (0.153.4, x64, console, signed).
    assert.deepEqual(readPe(fakePe(0x8664, { signed: true })), { machine: 'x64', is64: true, subsystem: 'console', signed: true });
    assert.equal(readPe(Buffer.from('MZ')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- classify */

function fakeResult(partial: Partial<ProcessResult>, trace: Partial<ProcessTrace> = {}): ProcessResult {
  return {
    outcome: 'completed',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 10,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    truncated: false,
    trace: {
      pid: 4242,
      spawnedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      firstStdoutAt: null,
      firstStderrAt: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      exitedAt: null,
      closedAt: null,
      errorAt: null,
      errorCode: null,
      streamsLingered: false,
      survivedTermination: false,
      termination: null,
      ...trace,
    },
    ...partial,
  };
}

test('every failure has its own state, and a local one is told from a source one', () => {
  const table: Array<[string, ProcessResult, string | null, string]> = [
    ['refused', fakeResult({ outcome: 'spawn-error' }, { errorCode: 'EACCES', pid: null }), null, 'ACCESS_DENIED'],
    ['refused (EPERM)', fakeResult({ outcome: 'spawn-error' }, { errorCode: 'EPERM', pid: null }), null, 'ACCESS_DENIED'],
    ['locked', fakeResult({ outcome: 'spawn-error' }, { errorCode: 'EBUSY', pid: null }), null, 'FILE_LOCKED'],
    ['vanished', fakeResult({ outcome: 'spawn-error' }, { errorCode: 'ENOENT', pid: null }), null, 'FILE_MISSING'],
    ['other spawn failure', fakeResult({ outcome: 'spawn-error' }, { errorCode: 'UNKNOWN', pid: null }), null, 'SPAWN_FAILED'],
    ['silent for the whole timeout', fakeResult({ outcome: 'timeout' }), null, 'PROCESS_STARTED_NO_OUTPUT'],
    ['stderr only, then timeout', fakeResult({ outcome: 'timeout' }, { stderrBytes: 12 }), null, 'PROCESS_STARTED_STDERR_ONLY'],
    ['printed, never ended', fakeResult({ outcome: 'timeout' }, { stdoutBytes: 12 }), 'codex-cli 0.153.4', 'PROCESS_HUNG'],
    ['cancelled', fakeResult({ outcome: 'cancelled' }), null, 'PROCESS_KILLED'],
    ['signalled', fakeResult({ exitCode: null, signal: 'SIGKILL' }), null, 'PROCESS_KILLED'],
    ['exit 0, nothing said', fakeResult({ exitCode: 0 }), null, 'PROCESS_EXITED_NO_VERSION'],
    ['exit 1', fakeResult({ exitCode: 1 }), null, 'PROCESS_EXITED_NONZERO'],
    ['access violation', fakeResult({ exitCode: 3221225477 }), null, 'PROCESS_CRASHED'],
    ['missing DLL', fakeResult({ exitCode: -1073741515 }), null, 'PROCESS_CRASHED'],
    ['fine', fakeResult({ exitCode: 0, stdout: 'codex-cli 0.153.4\n' }, { stdoutBytes: 18 }), 'codex-cli 0.153.4', 'OK'],
  ];
  for (const [label, result, version, expected] of table) {
    assert.equal(classifyRun(result, version), expected, label);
  }
  assert.equal(isLocalExecutionFailure('PROCESS_STARTED_NO_OUTPUT'), true);
  assert.equal(isLocalExecutionFailure('ACCESS_DENIED'), true);
  assert.equal(isLocalExecutionFailure('INVALID_EXECUTABLE'), false, 'a truncated file is the source or the extraction, not the machine');
  assert.equal(isLocalExecutionFailure('FILE_MISSING'), false);
  assert.equal(isLocalExecutionFailure('OK'), false);
});

test('the environment record has names and safe values: paths yes, proxy URLs no, PATH as a count', () => {
  const entries = win ? ['C:\\Windows', 'C:\\Users\\x\\AppData\\Roaming\\npm', 'C:\\tools\\codex-cli'] : ['/usr/bin', '/home/x/.npm/bin', '/tools/codex-cli'];
  const env = summariseEnv(
    {
      CODEX_HOME: 'C:\\Users\\x\\.codex',
      HTTPS_PROXY: 'http://user:secret@proxy:8080',
      PATH: entries.join(win ? ';' : ':'),
    } as NodeJS.ProcessEnv,
  );
  assert.equal(env.CODEX_HOME, 'C:\\Users\\x\\.codex');
  assert.equal(env.HTTPS_PROXY, 'definido');
  assert.equal(env.HTTP_PROXY, '(não definido)');
  assert.equal(env.RUST_LOG, '(não definido)');
  assert.equal(env.PATH, `3 entradas, codex em: ${entries[2]}`);
  assert.ok(!JSON.stringify(env).includes('secret'));
});

/* ---------------------------------------------------------------- execute */

test('a working executable: OK, the version line, PID, exit 0, argv exactly --version', async () => {
  const dir = temp('ok');
  try {
    const argvFile = join(dir, 'argv.txt');
    const exe = fakeExe(dir, 'codex', {
      sh: `printf '%s\\n' "$@" > "${argvFile}"; echo "codex-cli 0.153.4"`,
      cmd: `echo %*> "${argvFile}"\r\necho codex-cli 0.153.4`,
    });
    const probe = await probeExecution({ executablePath: exe, cwd: dir, processManager: new ProcessManager(), timeoutMs: 10_000, thorough: true });
    assert.equal(probe.state, 'OK');
    assert.equal(probe.versionLine, 'codex-cli 0.153.4');
    assert.equal(probe.runs.length, 1, 'a fast success needs no comparison run');
    const run = probe.runs[0]!;
    assert.deepEqual(run.argv, ['--version']);
    assert.equal(typeof run.pid, 'number');
    assert.equal(run.exitCode, 0);
    assert.equal(run.cwd, dir);
    // A .exe gets argv straight from CreateProcess; the .cmd fixture on
    // Windows sees the quotes cmd.exe was handed, so they are peeled here.
    assert.equal(readFileSync(argvFile, 'utf8').trim().replace(/^"(.*)"$/, '$1'), '--version', 'the process received exactly one argument');
    assert.equal(probe.static.format, 'script');
    const text = describeProbe(probe, process.platform);
    assert.match(text, /^O executável respondeu \(codex-cli 0\.153\.4\)\./m);
    assert.match(text, /estado: OK/);
    assert.match(text, /argv \["--version"\]/);
    assert.match(text, /ambiente: OPENSSL_ia32cap=.* · CODEX_HOME=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a process that starts and never writes: PROCESS_STARTED_NO_OUTPUT, killed, with every comparison run recorded', async () => {
  const dir = temp('hang');
  try {
    const seen = join(dir, 'homes.txt');
    const exe = fakeExe(dir, 'codex', {
      sh: `echo "$CODEX_HOME" >> "${seen}"; sleep 30`,
      cmd: `echo %CODEX_HOME%>> "${seen}"\r\nping -n 31 127.0.0.1 >nul`,
    });
    const steps: string[] = [];
    const probe = await probeExecution({
      executablePath: exe,
      cwd: dir,
      processManager: new ProcessManager(),
      timeoutMs: 1500,
      followUpTimeoutMs: 1000,
      thorough: true,
      scratchRoot: dir,
      homeEnvVar: 'CODEX_HOME',
      onStep: (m) => steps.push(m),
    });
    assert.equal(probe.state, 'PROCESS_STARTED_NO_OUTPUT');
    assert.equal(probe.recovered, false);
    assert.equal(isLocalExecutionFailure(probe.state), true);

    const labels = probe.runs.map((r) => r.label);
    assert.match(labels[0]!, /primeira execução/);
    assert.match(labels[1]!, /segunda execução/);
    assert.match(labels[2]!, /child_process direto/);
    assert.ok(labels.some((l) => /CODEX_HOME vazio/.test(l)), labels.join(' | '));
    assert.ok(labels.some((l) => /cópia em/.test(l)), labels.join(' | '));
    for (const run of probe.runs) {
      assert.equal(run.state, 'PROCESS_STARTED_NO_OUTPUT', run.label);
      assert.equal(run.stdoutBytes, 0);
      assert.equal(typeof run.pid, 'number', `${run.label} has a PID`);
      assert.ok(run.termination, `${run.label} records how it was stopped`);
    }
    const first = probe.runs[0]!;
    // The timeout, plus on Windows the polite taskkill's grace before /F.
    assert.ok(first.durationMs >= 1400 && first.durationMs < 12_000, `first run took the timeout: ${first.durationMs}`);
    assert.match(first.termination!, win ? /taskkill .*→ saiu/ : /SIG(TERM|KILL) \(process group\) → saiu/);

    // The empty-profile run really passed the scratch directory to the process.
    const homes = readFileSync(seen, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.ok(homes.some((h) => h.includes('probe-home-')), `scratch home seen: ${homes.join(', ')}`);
    // And the scratch folders are gone afterwards.
    assert.ok(!existsSync(join(dir, 'probe-home-')));
    assert.deepEqual(
      (await import('node:fs')).readdirSync(dir).filter((n) => n.startsWith('probe-')),
      [],
      'scratch folders cleaned up',
    );
    assert.ok(steps.some((s) => /Testando de novo/.test(s)) && steps.some((s) => /execução direta/.test(s)), steps.join(' | '));
    assert.match(probe.conclusions.join('\n'), /nenhuma variação .* respondeu/);

    const text = describeProbe(probe, 'win32');
    assert.match(text, /^Codex foi baixado e verificado\. O Windows iniciou o executável \(PID \d+\), mas ele permaneceu ativo sem produzir saída por \d+(\.\d)? s\./m);
    assert.match(text, /estado: PROCESS_STARTED_NO_OUTPUT/);
    // POSIX: killed by signal, no exit code. Windows: taskkill /F reports 1.
    assert.match(text, /stdout nada · stderr nada · saída (nenhuma|código 1)/);
    assert.match(text, /encerramento: /);
    assert.match(text, /conclusão: nenhuma variação/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a first start that is slow and a second that is fast: recovered, antivirus delay suspected', async () => {
  const dir = temp('slow');
  try {
    const marker = join(dir, 'ran-once');
    const exe = fakeExe(dir, 'codex', {
      sh: `if [ ! -f "${marker}" ]; then touch "${marker}"; sleep 30; fi; echo "codex-cli 0.153.4"`,
      cmd: `if not exist "${marker}" (echo.> "${marker}" & ping -n 31 127.0.0.1 >nul)\r\necho codex-cli 0.153.4`,
    });
    const probe = await probeExecution({
      executablePath: exe,
      cwd: dir,
      processManager: new ProcessManager(),
      timeoutMs: 1500,
      followUpTimeoutMs: 5000,
      thorough: true,
      scratchRoot: dir,
    });
    assert.equal(probe.state, 'PROCESS_STARTED_NO_OUTPUT', 'the verdict stays what the first run was');
    assert.equal(probe.recovered, true);
    assert.equal(probe.antivirusDelaySuspected, true);
    assert.equal(probe.versionLine, 'codex-cli 0.153.4');
    assert.equal(probe.runs.length, 2, 'once the second start answers, no further comparison is needed');
    assert.match(probe.conclusions[0]!, /a segunda execução respondeu em .* depois de a primeira ficar \d+(\.\d)? s sem resposta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stderr only, non-zero exit, and exit 0 with nothing said are three different states', async () => {
  const dir = temp('states');
  try {
    const pm = new ProcessManager();
    const stderrOnly = fakeExe(dir, 'stderr-only', {
      sh: `echo "warming up" >&2; sleep 30`,
      cmd: `echo warming up 1>&2\r\nping -n 31 127.0.0.1 >nul`,
    });
    const a = await probeExecution({ executablePath: stderrOnly, cwd: dir, processManager: pm, timeoutMs: 1200, thorough: false });
    assert.equal(a.state, 'PROCESS_STARTED_STDERR_ONLY');
    assert.equal(a.runs[0]!.stderrFirstLine, 'warming up');
    assert.match(describeProbe(a), /escreveu só em stderr e não terminou/);

    const nonzero = fakeExe(dir, 'nonzero', {
      sh: `echo "error: config.toml: unknown field" >&2; exit 2`,
      cmd: `echo error: config.toml: unknown field 1>&2\r\nexit /b 2`,
    });
    const b = await probeExecution({ executablePath: nonzero, cwd: dir, processManager: pm, timeoutMs: 5000, thorough: false });
    assert.equal(b.state, 'PROCESS_EXITED_NONZERO');
    assert.equal(b.runs[0]!.exitCode, 2);
    assert.match(describeProbe(b), /saiu com código 2 sem informar a versão: "error: config.toml: unknown field"/);

    const quiet = fakeExe(dir, 'quiet', { sh: `exit 0`, cmd: `exit /b 0` });
    const c = await probeExecution({ executablePath: quiet, cwd: dir, processManager: pm, timeoutMs: 5000, thorough: false });
    assert.equal(c.state, 'PROCESS_EXITED_NO_VERSION');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused start is ACCESS_DENIED with the code, not a timeout', { skip: win || process.getuid?.() === 0 }, async () => {
  const dir = temp('denied');
  try {
    const exe = fakeExe(dir, 'codex', { sh: `echo x`, cmd: `echo x` });
    chmodSync(exe, 0o644);
    const probe = await probeExecution({ executablePath: exe, cwd: dir, processManager: new ProcessManager(), timeoutMs: 5000, thorough: false });
    assert.equal(probe.state, 'ACCESS_DENIED');
    assert.equal(probe.runs[0]!.errorCode, 'EACCES');
    assert.ok(probe.runs[0]!.durationMs < 2000, 'answered at once, no waiting for a timeout');
    assert.match(describeProbe(probe, 'win32'), /^O Windows recusou iniciar o executável \(EACCES\)/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a synthetic refusal on any platform: the sentence names the system and the code', () => {
  const probe = {
    executable: 'C:\\x\\codex.exe',
    static: { path: 'C:\\x\\codex.exe', exists: true, bytes: 295_408_944, stableSize: true, sha256: '444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b', format: 'pe' as const, pe: { machine: 'x64', is64: true, subsystem: 'console' as const, signed: true }, openForWrite: true, openError: null, zoneIdentifier: null, problem: null },
    runs: [{ label: 'ProcessManager, primeira execução', via: 'process-manager' as const, argv: ['--version'], cwd: 'C:\\x', env: {}, state: 'ACCESS_DENIED' as const, startedAt: '', durationMs: 12, pid: null, exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0, stdoutFirstLine: null, stderrFirstLine: null, versionLine: null, firstOutputAfterMs: null, error: 'spawn EACCES', errorCode: 'EACCES', termination: null, notes: [], capability: null }],
    state: 'ACCESS_DENIED' as const,
    recovered: false,
    versionLine: null,
    antivirusDelaySuspected: false,
    environmentPolicy: null,
    conclusions: [],
  };
  const text = describeProbe(probe, 'win32');
  assert.match(text, /^O Windows recusou iniciar o executável \(EACCES\): antivírus, política de aplicativos/m);
  assert.match(text, /295\.408\.944 bytes · sha256 444a3f00…518b · PE x64 console · assinado: sim · sem outro handle aberto · Zone.Identifier: não/);
  assert.match(text, /PID nenhum · estado ACCESS_DENIED/);

  const crashed = { ...probe, state: 'PROCESS_CRASHED' as const, runs: [{ ...probe.runs[0]!, state: 'PROCESS_CRASHED' as const, pid: 77, exitCode: 3221225477, error: null, errorCode: null }] };
  assert.match(describeProbe(crashed, 'win32'), /iniciou e morreu com código 0xC0000005 \(STATUS_ACCESS_VIOLATION\)/);
});

/* ------------------------------------------------- the AWS-LC capability abort */

import { cpuOverridesIn, dropEnvKeys, parseCapabilityAbort, probeFailedLocally } from '../src/runtime/execution-probe.js';

const USER_STDERR =
  'Fatal Error: HW capability found: 0x178BFBFF 0x7EF8320B, but HW capability requested: 0x20000000 0x00.\n';

test('the exact AWS-LC signature is parsed, and beats the exit code in classification', () => {
  assert.deepEqual(parseCapabilityAbort(USER_STDERR), {
    found: ['0x178BFBFF', '0x7EF8320B'],
    requested: ['0x20000000', '0x00'],
  });
  assert.equal(parseCapabilityAbort('HW capability: nothing like it'), null);
  assert.equal(parseCapabilityAbort(''), null);

  // Windows: abort() reports 0xC0000409. Linux: SIGABRT. Same state.
  const windows = fakeResult({ exitCode: 3221226505, stderr: USER_STDERR }, { stderrBytes: USER_STDERR.length });
  assert.equal(classifyRun(windows, null), 'CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE');
  const linux = fakeResult({ exitCode: null, signal: 'SIGABRT', stderr: USER_STDERR }, { stderrBytes: USER_STDERR.length });
  assert.equal(classifyRun(linux, null), 'CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE');
  // Without the signature, the same exit code is an ordinary crash.
  assert.equal(classifyRun(fakeResult({ exitCode: 3221226505 }), null), 'PROCESS_CRASHED');
  assert.equal(isLocalExecutionFailure('CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE'), true, 'no second download for it');
});

test('the override variables are found whatever their casing, and dropped by their real keys', () => {
  const env = { OPENSSL_IA32CAP: '0x20000000', Path: 'x', CODEX_HOME: 'y' } as NodeJS.ProcessEnv;
  assert.deepEqual(cpuOverridesIn(env), [{ key: 'OPENSSL_IA32CAP', value: '0x20000000' }]);
  assert.deepEqual(dropEnvKeys(env, ['OPENSSL_ia32cap', 'OPENSSL_armcap']), { OPENSSL_IA32CAP: undefined });
  assert.deepEqual(dropEnvKeys({ Path: 'x' } as NodeJS.ProcessEnv, ['OPENSSL_ia32cap']), {});
  const summary = summariseEnv(env);
  assert.equal(summary.OPENSSL_ia32cap, '0x20000000', 'the record shows the value under the canonical name');
});

test('the capability abort: named, proved to be the variable by a run without it, and turned into a policy', async () => {
  const dir = temp('ia32cap');
  const previous = process.env.OPENSSL_ia32cap;
  process.env.OPENSSL_ia32cap = '0x20000000';
  try {
    // What codex.exe 0.153.4 does on the person's machine: AWS-LC's static
    // initializer reads OPENSSL_ia32cap, finds a bit the CPU lacks, aborts.
    const exe = fakeExe(dir, 'codex', {
      sh: `if [ -n "$OPENSSL_ia32cap" ]; then echo "Fatal Error: HW capability found: 0x178BFBFF 0x7EF8320B, but HW capability requested: $OPENSSL_ia32cap 0x00." >&2; exit 134; fi; echo "codex-cli 0.153.4"`,
      cmd: `if defined OPENSSL_ia32cap (echo Fatal Error: HW capability found: 0x178BFBFF 0x7EF8320B, but HW capability requested: %OPENSSL_ia32cap% 0x00. 1>&2 & exit /b -1073740791)\r\necho codex-cli 0.153.4`,
    });
    const steps: string[] = [];
    const probe = await probeExecution({
      executablePath: exe,
      cwd: dir,
      processManager: new ProcessManager(),
      timeoutMs: 10_000,
      followUpTimeoutMs: 10_000,
      thorough: true,
      scratchRoot: dir,
      homeEnvVar: 'CODEX_HOME',
      onStep: (m) => steps.push(m),
    });
    assert.equal(probe.state, 'CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE');
    assert.equal(probe.recovered, true);
    assert.equal(probe.versionLine, 'codex-cli 0.153.4');
    assert.equal(probeFailedLocally(probe), false, 'recovered: the build is usable under the policy');
    assert.deepEqual(probe.runs.map((r) => r.label), ['ProcessManager, primeira execução', 'ProcessManager, sem OPENSSL_ia32cap']);
    const [first, without] = probe.runs as [typeof probe.runs[0], typeof probe.runs[0]];
    assert.deepEqual(first.capability, { found: ['0x178BFBFF', '0x7EF8320B'], requested: ['0x20000000', '0x00'] });
    assert.equal(first.env.OPENSSL_ia32cap, '0x20000000');
    assert.equal(without.env.OPENSSL_ia32cap, '(não definido)', 'the comparison run really ran without it');
    assert.equal(without.state, 'OK');
    assert.ok(probe.environmentPolicy);
    assert.deepEqual(probe.environmentPolicy.drop, ['OPENSSL_ia32cap', 'OPENSSL_armcap']);
    assert.match(probe.environmentPolicy.reason, /OPENSSL_ia32cap=0x20000000 faz a AWS-LC abortar \(pede 0x20000000 0x00, a CPU tem 0x178BFBFF 0x7EF8320B\)/);
    assert.ok(steps.some((s) => /Testando sem OPENSSL_ia32cap/.test(s)), steps.join(' | '));
    assert.equal(process.env.OPENSSL_ia32cap, '0x20000000', 'the machine environment was not touched');

    const text = describeProbe(probe, 'win32');
    assert.match(text, /^Esta versão do Codex não consegue iniciar neste computador com a variável de ambiente OPENSSL_ia32cap: a biblioteca criptográfica \(AWS-LC\) aborta ao iniciar porque a variável pede a capacidade 0x20000000 0x00 e a CPU informa 0x178BFBFF 0x7EF8320B\. Não é o processador; é a variável\. Sem a variável, só no processo do Codex, o executável respondeu\./m);
    assert.match(text, /estado: CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE \(recuperado na segunda execução\)/);
    assert.match(text, /política: o Codex gerenciado roda sem OPENSSL_ia32cap, OPENSSL_armcap no seu ambiente/);
    assert.doesNotMatch(text, /timeout|180 s/);
  } finally {
    if (previous === undefined) delete process.env.OPENSSL_ia32cap;
    else process.env.OPENSSL_ia32cap = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
