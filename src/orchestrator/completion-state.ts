import type { DoneGateResult } from '../core/types.js';

export type RejectionKind = 'MISSING_PROOF' | 'FAILED_CRITERION' | 'IMPLEMENTATION_MISMATCH' |
  'UNVERIFIED_OUTPUT' | 'MECHANICAL_FAILURE' | 'PERMISSION_REQUIRED' | 'USER_INPUT_REQUIRED' | 'VERIFICATION_STALLED';
export interface GateRejection {
  kind: RejectionKind;
  message: string;
  path?: string;
  criterion?: string;
}
export interface CompletionState {
  implementation: 'PENDING' | 'COMPLETE' | 'INCOMPLETE';
  verification: 'PENDING' | 'INCOMPLETE' | 'PASSED' | 'STALLED';
}

/** Only a measured failure can reopen implementation. Missing proof is a system job. */
export function recoveryAction(gate: DoneGateResult): 'collect-proof' | 'implement' | 'repair' | 'ask-permission' | 'ask-user' | 'stop' | 'done' {
  if (gate.passed) return 'done';
  const kinds = (gate.rejections ?? []).map(r => r.kind);
  if (kinds.includes('VERIFICATION_STALLED')) return 'stop';
  if (kinds.includes('PERMISSION_REQUIRED')) return 'ask-permission';
  if (kinds.includes('USER_INPUT_REQUIRED')) return 'ask-user';
  if (kinds.includes('MECHANICAL_FAILURE')) return 'repair';
  if (kinds.some(k => k === 'IMPLEMENTATION_MISMATCH' || k === 'FAILED_CRITERION')) return 'implement';
  return 'collect-proof';
}
