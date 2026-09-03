/**
 * One runtime, as the user sees it.
 *
 * The card shows a name, a state and - when something is missing - the
 * remedy the runtime layer itself proposed. It never shows a path, a spawn
 * detail, an exit code or a source URL: those belong in a developer view that
 * this phase does not build yet.
 */

import type { JSX } from 'react';

import type { RuntimeStatus } from '../../../../../src/runtime/runtime-manager.js';
import type { InstallProgressEvent } from '../../shared/ipc-contract.js';

export interface RuntimeCardProps {
  runtime: RuntimeStatus;
  progress: InstallProgressEvent | null;
  busy: boolean;
  disabled: boolean;
  onConfigure: () => void;
  onCancel: () => void;
}

export function RuntimeCard({
  runtime,
  progress,
  busy,
  disabled,
  onConfigure,
  onCancel,
}: RuntimeCardProps): JSX.Element {
  const healthy = runtime.health.healthy;

  return (
    <article className={`card ${healthy ? 'card--ok' : 'card--pending'}`}>
      <div className="card__head">
        <h3>{runtime.displayName}</h3>
        <span className="card__state">
          {healthy ? '✓ Pronto' : (runtime.health.problem ?? 'Não configurado')}
        </span>
      </div>

      {busy && progress && (
        <div className="progress">
          <div className="progress__label">
            <span>{progress.step}</span>
            {typeof progress.percent === 'number' && <span>{progress.percent}%</span>}
          </div>
          <div className="progress__track">
            <div
              className="progress__bar"
              style={{ width: `${typeof progress.percent === 'number' ? progress.percent : 100}%` }}
            />
          </div>
          <p className="progress__message">{progress.message}</p>
        </div>
      )}

      <div className="card__actions">
        {!healthy && !busy && runtime.canAutoConfigure && (
          <button type="button" onClick={onConfigure} disabled={disabled}>
            {runtime.health.remedy ?? 'Configurar automaticamente'}
          </button>
        )}
        {!healthy && !busy && !runtime.canAutoConfigure && (
          <span className="card__note">
            Este componente precisa ser instalado antes de usar este agente.
          </span>
        )}
        {busy && (
          <button type="button" className="button--quiet" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
    </article>
  );
}
