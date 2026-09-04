/**
 * The single door between the desktop shell and the orchestrator core.
 *
 * Every long relative path into `src/` is spelled once, here. Services import
 * from this file, so moving the core (or publishing it as a package) is a
 * one-file change, and a reader can see the entire core surface the desktop
 * depends on without grepping.
 */

export { RuntimeManager } from '../../../../src/runtime/runtime-manager.js';
export type { DiagnosticReport, RuntimeStatus } from '../../../../src/runtime/runtime-manager.js';
export { RuntimeError, RuntimeNotReadyError } from '../../../../src/runtime/types.js';
export type {
  HealthStatus,
  InstallPhase,
  InstallProgress,
  InstallResult,
  RuntimeDetection,
  RuntimeId,
  RuntimeManifest,
} from '../../../../src/runtime/types.js';
export { appPaths, ensureAppPaths } from '../../../../src/runtime/paths.js';
export type { AppPaths } from '../../../../src/runtime/paths.js';

export { Database } from '../../../../src/database/database.js';
export { nodeSqliteAvailable } from '../../../../src/database/driver.js';
export { newId, RecordNotFoundError } from '../../../../src/database/repositories.js';
export type {
  AccountRecord,
  AgentRecord,
  ChatSessionRecord,
  MessageRecord,
  RunRecord,
  RunStatus,
  WorkspaceWithAgents,
} from '../../../../src/database/repositories.js';

export { ClaudeAccountManager, isUsable } from '../../../../src/accounts/claude-account-manager.js';
export { AccountError } from '../../../../src/accounts/account-types.js';
export type {
  Account,
  AccountStatus,
  AuthState,
  LoginProgress,
} from '../../../../src/accounts/account-types.js';

export { ProcessManager } from '../../../../src/process/process-manager.js';
export type { ProcessResult } from '../../../../src/process/process-manager.js';

export { GitEvidenceCollector } from '../../../../src/git/git-evidence-collector.js';
export { screenCommand } from '../../../../src/git/git-safety.js';

export { AcceptanceCriteriaLedger } from '../../../../src/orchestrator/acceptance-criteria.js';
export { parseDecision, buildRepairPrompt } from '../../../../src/orchestrator/decision-parser.js';
export { evaluateDone, formatDoneRejection } from '../../../../src/orchestrator/done-gate.js';
export { Verifier, commandPassed } from '../../../../src/orchestrator/verifier.js';

export type {
  AgentInput,
  AgentResult,
  Baseline,
  CommandResult,
  Decision,
  DoneGateResult,
  GitEvidence,
  IterationRecord,
} from '../../../../src/core/types.js';
export type { AgentRunner } from '../../../../src/agents/agent-runner.js';
export { makeAgentResult } from '../../../../src/agents/agent-runner.js';
