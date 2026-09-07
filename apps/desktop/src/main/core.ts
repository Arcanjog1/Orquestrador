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
export { versionNumberOf } from '../../../../src/runtime/managed-runtime.js';
export type { AppPaths } from '../../../../src/runtime/paths.js';

export { Database } from '../../../../src/database/database.js';
export { nodeSqliteAvailable } from '../../../../src/database/driver.js';
export { newId, RecordNotFoundError } from '../../../../src/database/repositories.js';
export type {
  AccountRecord,
  AgentRecord,
  ChatSessionRecord,
  ListSessionsOptions,
  ProjectRecord,
  MessageRecord,
  RunRecord,
  RunStepRecord,
  RunStatus,
  VerificationDefinitionRecord,
  WorkspaceWithAgents,
} from '../../../../src/database/repositories.js';

export { ClaudeAccountManager, isUsable } from '../../../../src/accounts/claude-account-manager.js';
export { CodexAccountManager } from '../../../../src/accounts/codex-account-manager.js';
export { AccountError } from '../../../../src/accounts/account-types.js';
export type {
  Account,
  AccountStatus,
  AuthState,
  LoginProgress,
} from '../../../../src/accounts/account-types.js';

/**
 * What the account service needs from a provider's manager.
 *
 * Both managers already satisfy this; naming it keeps the service from
 * branching on a vendor and makes the next provider a matter of adding one.
 */
export interface ProviderAccountManager {
  profileDirectory(accountId: string): string;
  createAccount(account: import('../../../../src/accounts/account-types.js').Account): unknown;
  removeAccount(accountId: string): void;
  getStatus(
    account: import('../../../../src/accounts/account-types.js').Account,
  ): Promise<import('../../../../src/accounts/account-types.js').AccountStatus>;
  connect(
    account: import('../../../../src/accounts/account-types.js').Account,
    options?: {
      onProgress?: (
        progress: import('../../../../src/accounts/account-types.js').LoginProgress,
      ) => void;
      openUrl?: (url: string) => void | Promise<void>;
      signal?: AbortSignal;
    },
  ): Promise<import('../../../../src/accounts/account-types.js').AccountStatus>;
  buildEnvironment(accountId: string): Record<string, string | undefined>;
}

export { ProcessManager } from '../../../../src/process/process-manager.js';
export type { ProcessRunner, ExecutionEnvironment } from '../../../../src/execution/process-runner.js';
export { localEnvironment } from '../../../../src/execution/process-runner.js';
export type { ProcessResult, RunProcessOptions } from '../../../../src/process/process-manager.js';

export { GitEvidenceCollector, parseStatusShort } from '../../../../src/git/git-evidence-collector.js';
export { redact } from '../../../../src/security/secret-redactor.js';
export { screenCommand } from '../../../../src/git/git-safety.js';

export { AcceptanceCriteriaLedger } from '../../../../src/orchestrator/acceptance-criteria.js';
export { parseDecision, buildRepairPrompt } from '../../../../src/orchestrator/decision-parser.js';
export { evaluateDone, formatDoneRejection } from '../../../../src/orchestrator/done-gate.js';
export { DECISION_JSON_SCHEMA } from '../../../../src/orchestrator/decision-schema.js';

export { routeWorkerModel, noProgressStreak } from '../../../../src/routing/model-router.js';
export type { PreviousAttempt, RouterInput, RouterOutput } from '../../../../src/routing/model-router.js';
export {
  codexSupportedEfforts,
  resolveFixedEffort,
  ROUTING_POLICY_VERSION,
} from '../../../../src/routing/provider-policy.js';
export type { RoutingProvider, WorkerRuntimeCapabilities } from '../../../../src/routing/provider-policy.js';
export { isMechanicalFailure, modelUnavailableIn } from '../../../../src/routing/task-assessment.js';
export {
  CAPABILITY_TIERS,
  DEFAULT_REQUIREMENTS,
  REASONING_TIERS,
  WORKER_SELECTIONS,
  isWorkerSelection,
} from '../../../../src/routing/tiers.js';
export type {
  CapabilityTier,
  ReasoningTier,
  WorkerRequirements,
  WorkerSelection,
} from '../../../../src/routing/tiers.js';
export { Verifier, commandPassed } from '../../../../src/orchestrator/verifier.js';

export type {
  AgentInput,
  AgentResult,
  Baseline,
  CommandResult,
  Decision,
  DoneGateResult,
  GitEvidence,
  InvocationRouting,
  IterationRecord,
  RoutingRecord,
} from '../../../../src/core/types.js';
export type { AgentRunner } from '../../../../src/agents/agent-runner.js';
export { makeAgentResult } from '../../../../src/agents/agent-runner.js';

export {
  GitHubClient,
  GitHubError,
  gitAuthEnvironment,
  isGitHubHttpsRemote,
  parseGitHubRemote,
} from '../../../../src/github/github-client.js';
export type {
  CheckSummary,
  DeviceCode,
  GitHubClientOptions,
  GitHubRepository,
  GitHubToken,
  PullRequest,
} from '../../../../src/github/github-client.js';
