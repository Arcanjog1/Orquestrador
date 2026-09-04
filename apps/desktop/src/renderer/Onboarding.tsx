/**
 * First run: the runtime checklist.
 *
 * Everything shown here comes from `RuntimeManager.diagnose()`. The React tree
 * decides nothing about whether a runtime is ready or whether it can be fixed —
 * duplicating that logic in the renderer is exactly how the two would drift.
 */

import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api, messageOf } from './api.js';
import type { DiagnosticView, RuntimeProgressEvent } from '../shared/ipc-contract.js';

type ProgressMap = Record<string, RuntimeProgressEvent | undefined>;

export function Onboarding({ onReady }: { onReady: () => void }): ReactElement {
  const [report, setReport] = useState<DiagnosticView | null>(null);
  const [progress, setProgress] = useState<ProgressMap>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setReport(await api.runtime.diagnose());
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return api.events.runtimeProgress((event) => {
      setProgress((current) => ({ ...current, [event.runtimeId]: event }));
    });
  }, [refresh]);

  const install = async (runtimeId: 'codex' | 'claude-code' | 'git'): Promise<void> => {
    setBusy(runtimeId);
    setError(null);
    try {
      const result = await api.runtime.install({ runtimeId });
      if (!result.ok) setError(result.message);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
      setProgress((current) => ({ ...current, [runtimeId]: undefined }));
      await refresh();
    }
  };

  if (!report) {
    return (
      <Centered>
        <h1>AI Orchestrator</h1>
        <p className="muted">Preparando aplicativo...</p>
      </Centered>
    );
  }

  return (
    <Centered>
      <h1>AI Orchestrator</h1>
      <p className="muted">
        {report.ready
          ? 'Tudo pronto.'
          : 'Alguns componentes ainda precisam ser configurados. O aplicativo faz isso sozinho.'}
      </p>

      <div className="col" style={{ width: 520, marginTop: 8 }}>
        {report.runtimes.map((runtime) => {
          const live = progress[runtime.runtimeId];
          const working = busy === runtime.runtimeId;
          return (
            <div key={runtime.runtimeId} className="card row" style={{ justifyContent: 'space-between' }}>
              <div className="col" style={{ gap: 2 }}>
                <div className="row">
                  <span className={`dot ${working ? 'busy' : runtime.ready ? 'ok' : 'warn'}`} />
                  <strong>{runtime.displayName}</strong>
                  {runtime.version ? <span className="muted">{runtime.version}</span> : null}
                </div>
                <span className="muted" data-testid={`detail-${runtime.runtimeId}`}>
                  {working && live ? `${live.label}: ${live.message}` : runtime.detail}
                </span>
                {working && live?.percent !== null && live?.percent !== undefined ? (
                  <progress max={100} value={live.percent} style={{ width: 240 }} />
                ) : null}
              </div>
              <div className="row">
                {runtime.ready ? (
                  <span className="muted">✓ Pronto</span>
                ) : working ? (
                  <button onClick={() => void api.runtime.cancelInstall({ runtimeId: runtime.runtimeId })}>
                    Cancelar
                  </button>
                ) : runtime.canAutoConfigure ? (
                  <button
                    className="primary"
                    data-testid={`install-${runtime.runtimeId}`}
                    onClick={() => void install(runtime.runtimeId)}
                    disabled={busy !== null}
                  >
                    Configurar automaticamente
                  </button>
                ) : (
                  <span className="muted">Indisponível</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error ? (
        <p style={{ color: 'var(--bad)' }} data-testid="onboarding-error">
          {error}
        </p>
      ) : null}

      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => void refresh()} disabled={busy !== null}>
          Verificar novamente
        </button>
        <button className="primary" onClick={onReady} data-testid="continue">
          {report.ready ? 'Continuar' : 'Continuar mesmo assim'}
        </button>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
      }}
    >
      {children}
    </div>
  );
}
