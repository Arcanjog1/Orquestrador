/**
 * The first-run screen.
 *
 * Deliberately small, and deliberately dumb: this screen holds no opinion
 * about what "ready" means. It asks `runtime.diagnose()` and renders the
 * answer. Every judgement - whether a runtime is healthy, whether the
 * application can fix it, what the remedy is called - is made by
 * `RuntimeManager`, which is the layer that was reviewed for it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { DiagnosticReport, RuntimeStatus } from '../../../../src/runtime/runtime-manager.js';
import type { RuntimeId } from '../../../../src/runtime/types.js';
import type { Account, AccountStatus } from '../../../../src/accounts/account-types.js';
import type {
  AppInfo,
  BootstrapState,
  InstallProgressEvent,
  LoginProgressEvent,
} from '../shared/ipc-contract.js';
import { bridge, call } from './bridge.js';
import { RuntimeCard } from './components/RuntimeCard.js';
import { AccountsPanel } from './components/AccountsPanel.js';
import { BootChecklist, type BootStep } from './components/BootChecklist.js';

type Phase = 'booting' | 'ready' | 'broken';

export function App(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('booting');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [boot, setBoot] = useState<BootstrapState | null>(null);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [progress, setProgress] = useState<Record<string, InstallProgressEvent>>({});
  const [login, setLogin] = useState<LoginProgressEvent | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AccountStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<RuntimeId | null>(null);

  /* -- live events ------------------------------------------------------- */

  useEffect(() => {
    const api = bridge();
    if (!api) return;
    const stopProgress = api.runtime.onProgress((event) => {
      setProgress((current) => ({ ...current, [event.runtimeId]: event }));
    });
    const stopLogin = api.accounts.onLoginProgress((event) => setLogin(event));
    return () => {
      stopProgress();
      stopLogin();
    };
  }, []);

  /* -- first run --------------------------------------------------------- */

  const refreshAccounts = useCallback(async () => {
    const result = await call((api) => api.accounts.list());
    if (result.ok) setAccounts(result.data);
  }, []);

  const runDiagnose = useCallback(async () => {
    const result = await call((api) => api.runtime.diagnose());
    if (result.ok) {
      setReport(result.data);
      return true;
    }
    setError(result.userMessage);
    return false;
  }, []);

  useEffect(() => {
    void (async () => {
      const infoResult = await call((api) => api.app.getInfo());
      if (!infoResult.ok) {
        setError(infoResult.userMessage);
        setPhase('broken');
        return;
      }
      setInfo(infoResult.data);

      const bootResult = await call((api) => api.app.getBootstrapState());
      if (!bootResult.ok || !bootResult.data.databaseReady) {
        setError(bootResult.ok ? (bootResult.data.problem ?? null) : bootResult.userMessage);
        setBoot(bootResult.ok ? bootResult.data : null);
        setPhase('broken');
        return;
      }
      setBoot(bootResult.data);

      const diagnosed = await runDiagnose();
      await refreshAccounts();
      setPhase(diagnosed ? 'ready' : 'broken');
    })();
  }, [runDiagnose, refreshAccounts]);

  /* -- actions ----------------------------------------------------------- */

  const configure = useCallback(
    async (runtimeId: RuntimeId) => {
      setBusy(runtimeId);
      setError(null);
      const result = await call((api) => api.runtime.install(runtimeId));
      if (!result.ok) setError(result.userMessage);
      setBusy(null);
      setProgress((current) => {
        const next = { ...current };
        delete next[runtimeId];
        return next;
      });
      await runDiagnose();
    },
    [runDiagnose],
  );

  const cancel = useCallback(async (runtimeId: RuntimeId) => {
    await call((api) => api.runtime.cancelInstall(runtimeId));
  }, []);

  /* -- render ------------------------------------------------------------ */

  const bootSteps = useMemo<BootStep[]>(() => {
    const database: BootStep = {
      label: 'Banco',
      state: boot?.databaseReady ? 'done' : phase === 'booting' ? 'running' : 'failed',
    };
    if (!report) {
      return [
        database,
        { label: 'Verificando Codex', state: phase === 'booting' ? 'running' : 'pending' },
        { label: 'Verificando Claude Code', state: 'pending' },
        { label: 'Verificando Git', state: 'pending' },
      ];
    }
    return [database, ...report.runtimes.map(toBootStep)];
  }, [boot, report, phase]);

  if (phase === 'booting') {
    return (
      <main className="shell">
        <header className="hero">
          <h1>AI Orchestrator</h1>
          <p>Preparando aplicativo...</p>
        </header>
        <BootChecklist steps={bootSteps} />
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="hero">
        <h1>AI Orchestrator</h1>
        <p>
          {report?.ready
            ? 'Tudo pronto para começar.'
            : 'Faltam alguns componentes. O aplicativo cuida disso para você.'}
        </p>
      </header>

      {error && (
        <div className="banner banner--error" role="alert">
          {error}
        </div>
      )}

      <section className="panel">
        <h2>Componentes</h2>
        {report?.runtimes.map((runtime) => (
          <RuntimeCard
            key={runtime.runtimeId}
            runtime={runtime}
            progress={progress[runtime.runtimeId] ?? null}
            busy={busy === runtime.runtimeId}
            disabled={busy !== null && busy !== runtime.runtimeId}
            onConfigure={() => void configure(runtime.runtimeId)}
            onCancel={() => void cancel(runtime.runtimeId)}
          />
        ))}
      </section>

      <AccountsPanel
        accounts={accounts}
        statuses={statuses}
        login={login}
        onChanged={refreshAccounts}
        onStatus={(accountId, status) =>
          setStatuses((current) => ({ ...current, [accountId]: status }))
        }
      />

      {info && (
        <footer className="footer">
          {info.name} {info.version}
        </footer>
      )}
    </main>
  );
}

function toBootStep(runtime: RuntimeStatus): BootStep {
  return {
    label: `Verificando ${runtime.displayName}`,
    state: runtime.health.healthy ? 'done' : 'failed',
  };
}
