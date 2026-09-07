/** Re-exports so the adapters read cleanly and the core stays the source. */
export type {
  AgentInput,
  AgentResult,
  AgentRunner,
  ProcessManager,
  ProcessRunner,
} from '../core.js';
export type { HealthStatus as HealthStatusCore } from '../../../../../src/core/types.js';
