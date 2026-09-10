export type ComplexityClass = 'TRIVIAL' | 'SIMPLE' | 'STANDARD' | 'COMPLEX';
export interface OrchestrationPlan {
  complexityClass: ComplexityClass;
  plannedAgents: string[];
  expectedModelInvocations: number;
  expectedWorkerInvocations: number;
  reason: string;
}
export interface OrchestrationMetrics extends OrchestrationPlan {
  actualModelInvocations: number;
  actualWorkerInvocations: number;
  deterministicSteps: number;
  retries: number;
  stagnationCount: number;
}
