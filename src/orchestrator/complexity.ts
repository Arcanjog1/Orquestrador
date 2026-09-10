import { classifyObjective, normalizeObjective, objectiveInstructions } from './objective-intent.js';
import type { MissionContract } from './mission-contract.js';

import type { ComplexityClass, OrchestrationPlan } from './complexity-types.js';
export type { ComplexityClass, OrchestrationPlan, OrchestrationMetrics } from './complexity-types.js';

/** Conservative upper bounds come from requested risk and uncertainty, never
 * from the size of the configured team. Literal contents are not instructions. */
export function classifyComplexity(contract: MissionContract): OrchestrationPlan {
  const text = normalizeObjective(objectiveInstructions(contract.objective));
  const intent = classifyObjective(contract.objective);
  const make = (complexityClass:ComplexityClass, plannedAgents:string[], reason:string):OrchestrationPlan => ({
    complexityClass, plannedAgents, expectedWorkerInvocations:plannedAgents.length,
    expectedModelInvocations:complexityClass === 'TRIVIAL' || complexityClass === 'SIMPLE' ? 1 + plannedAgents.length : 2 + plannedAgents.length, reason});
  if (/\b(arquitetura|architecture|subsistemas|subsystems|paralelismo|parallel|migracao|migration|alto risco|high risk|refatoracao grande|large refactor)\b/.test(text))
    return make('COMPLEX',['ANALYST','CODING_WORKER','TESTER'],'Arquitetura, risco ou múltiplos subsistemas explicitamente solicitados.');
  if (/\b(desconhecid[ao]|unknown|investig\w*|causa|cause|diagnos\w*|redesign|refaca|refactor|refatore|varios modulos|multiple modules)\b/.test(text))
    return make('STANDARD',intent.requiresChanges ? ['ANALYST','CODING_WORKER','TESTER'] : ['ANALYST'],'Investigação ou julgamento semântico necessário.');
  if (!intent.requiresChanges && !intent.requiresExecution && !/\b(analise|analyze|review|explique|explain|audit|compare|comparar)\b/.test(text) && (contract.filePaths.length > 0 || /\b(repo|repositorio|repository|github|arquivos|files|arvore|tree)\b/.test(text)))
    return make('TRIVIAL',[],'Consulta diretamente mensurável pelo aplicativo.');
  if (intent.requiresChanges && !intent.requiresExecution && contract.filePaths.length <= 1 &&
      (contract.exactLiterals.length === 1 || /\b(crie|criar|create|leia|read|existe|exists|altere a string|replace the string)\b/.test(text) && /\b(arquivo|file)\b|\.txt\b/.test(text)))
    return make('TRIVIAL',['CODING_WORKER'],'Arquivo ou literal delimitado; verificação determinística suficiente.');
  if (intent.requiresChanges && contract.filePaths.length <= 3 && /\b(localizado|localized|pequen[ao]|small|funcao|function|string|simples|simple)\b/.test(text))
    return make('SIMPLE',['CODING_WORKER'],'Mudança localizada com verificação automática.');
  return make('STANDARD',intent.requiresChanges ? ['CODING_WORKER'] : ['ANALYST'],'Escopo exige planejamento; selecionar somente as funções necessárias.');
}

/** Promotion needs a diagnosis backed by failed bytes/tests, never missing proof. */
export function promoteComplexity(plan: OrchestrationPlan, measuredFailure: string): OrchestrationPlan {
  const levels: ComplexityClass[] = ['TRIVIAL','SIMPLE','STANDARD','COMPLEX'];
  const complexityClass = levels[Math.min(levels.indexOf(plan.complexityClass)+1,3)]!;
  const plannedAgents = complexityClass === 'SIMPLE' ? ['CODING_WORKER'] : ['ANALYST','CODING_WORKER','TESTER'];
  return {...plan,complexityClass,plannedAgents,expectedWorkerInvocations:plannedAgents.length + 1,
    expectedModelInvocations:plannedAgents.length + 3,reason:measuredFailure};
}
