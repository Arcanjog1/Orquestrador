/**
 * Connecting an Anthropic account, without a terminal.
 *
 * The user types a name and presses Conectar. The main process creates the
 * profile, starts the sign-in, opens the browser and polls until the CLI
 * reports success. This panel only renders what comes back - it never sees
 * the sign-in URL, the profile directory or the environment behind them.
 */

import { useCallback, useState } from 'react';
import type { JSX } from 'react';
import type { Account, AccountStatus } from '../../../../../src/accounts/account-types.js';
import type { LoginProgressEvent } from '../../shared/ipc-contract.js';
import { call } from '../bridge.js';

const STATE_LABELS: Record<AccountStatus['state'], string> = {
  connected: '✓ Conectado',
  disconnected: 'Não conectado',
  'ambient-credential': 'Precisa entrar nesta conta',
  'runtime-missing': 'Aguardando o Claude Code',
};

export interface AccountsPanelProps {
  accounts: Account[];
  statuses: Record<string, AccountStatus>;
  login: LoginProgressEvent | null;
  onChanged: () => Promise<void>;
  onStatus: (accountId: string, status: AccountStatus) => void;
}

export function AccountsPanel({
  accounts,
  statuses,
  login,
  onChanged,
  onStatus,
}: AccountsPanelProps): JSX.Element {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  const create = useCallback(async () => {
    setError(null);
    const result = await call((api) => api.accounts.create('anthropic', name));
    if (!result.ok) {
      setError(result.userMessage);
      return;
    }
    setName('');
    await onChanged();
  }, [name, onChanged]);

  const connect = useCallback(
    async (accountId: string) => {
      setError(null);
      setConnecting(accountId);
      const result = await call((api) => api.accounts.connect(accountId));
      if (result.ok) onStatus(accountId, result.data);
      else setError(result.userMessage);
      setConnecting(null);
      await onChanged();
    },
    [onChanged, onStatus],
  );

  const check = useCallback(
    async (accountId: string) => {
      const result = await call((api) => api.accounts.status(accountId));
      if (result.ok) onStatus(accountId, result.data);
      else setError(result.userMessage);
    },
    [onStatus],
  );

  const cancel = useCallback(async (accountId: string) => {
    await call((api) => api.accounts.cancelConnect(accountId));
  }, []);

  return (
    <section className="panel">
      <h2>Contas</h2>
      <p className="panel__hint">Anthropic</p>

      {error && (
        <div className="banner banner--error" role="alert">
          {error}
        </div>
      )}

      <div className="row">
        <input
          type="text"
          value={name}
          maxLength={64}
          placeholder="Nome da conta, por exemplo Claude Trabalho"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="button" onClick={() => void create()} disabled={name.trim().length === 0}>
          Adicionar conta
        </button>
      </div>

      {accounts.length === 0 && (
        <p className="panel__empty">Nenhuma conta ainda. Adicione uma para conectar.</p>
      )}

      {accounts.map((account) => {
        const status = statuses[account.id];
        const busy = connecting === account.id;
        return (
          <article key={account.id} className="card">
            <div className="card__head">
              <h3>{account.displayName}</h3>
              <span className="card__state">
                {status ? STATE_LABELS[status.state] : 'Estado desconhecido'}
              </span>
            </div>

            {busy && login?.accountId === account.id && (
              <p className="progress__message">
                {login.message}
                {login.browserOpened && ' (conclua no navegador que abrimos)'}
              </p>
            )}

            <div className="card__actions">
              {!busy && (
                <>
                  <button type="button" onClick={() => void connect(account.id)}>
                    Conectar conta
                  </button>
                  <button
                    type="button"
                    className="button--quiet"
                    onClick={() => void check(account.id)}
                  >
                    Verificar
                  </button>
                </>
              )}
              {busy && (
                <button
                  type="button"
                  className="button--quiet"
                  onClick={() => void cancel(account.id)}
                >
                  Cancelar
                </button>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}
