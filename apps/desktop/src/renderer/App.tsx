import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Onboarding } from './Onboarding.js';
import { Workbench } from './Workbench.js';
import type { AppInfo } from '../shared/ipc-contract.js';

/**
 * Onboarding until the runtimes are ready, then the workbench.
 *
 * The decision is the diagnostic's, not the renderer's: the first screen is
 * skipped only when `diagnose()` says everything is ready.
 */
export function App(): ReactElement {
  const [screen, setScreen] = useState<'loading' | 'onboarding' | 'workbench'>('loading');
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void (async () => {
      const [appInfo, report] = await Promise.all([api.app.info(), api.runtime.diagnose()]);
      setInfo(appInfo);
      setScreen(report.ready ? 'workbench' : 'onboarding');
    })();
  }, []);

  if (screen === 'loading') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <span className="muted">Preparando aplicativo...</span>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        {screen === 'onboarding' ? (
          <Onboarding onReady={() => setScreen('workbench')} />
        ) : (
          <Workbench onBack={() => setScreen('onboarding')} />
        )}
      </div>
      {info ? (
        <footer
          className="muted"
          style={{ padding: '4px 12px', borderTop: '1px solid var(--line)', fontSize: 11 }}
          data-testid="app-info"
        >
          Electron {info.electronVersion} · Node {info.nodeVersion} · Chromium {info.chromeVersion} ·
          SQLite {info.sqliteAvailable ? 'ok' : 'indisponível'}
        </footer>
      ) : null}
    </div>
  );
}
