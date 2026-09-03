/** The first thing the user sees while the application prepares itself. */

import type { JSX } from 'react';

export interface BootStep {
  label: string;
  state: 'pending' | 'running' | 'done' | 'failed';
}

const MARKS: Record<BootStep['state'], string> = {
  pending: ' ',
  running: '●',
  done: '✓',
  failed: '!',
};

export function BootChecklist({ steps }: { steps: BootStep[] }): JSX.Element {
  return (
    <ul className="checklist">
      {steps.map((step) => (
        <li key={step.label} className={`checklist__item checklist__item--${step.state}`}>
          <span className="checklist__mark" aria-hidden="true">
            [{MARKS[step.state]}]
          </span>
          <span>{step.label}</span>
        </li>
      ))}
    </ul>
  );
}
