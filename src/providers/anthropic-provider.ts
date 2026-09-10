/**
 * Anthropic, through the Messages API.
 *
 * This is the **conversation / analysis** worker. It reads a task, thinks, and
 * answers. That is the whole of what it can do, and this adapter says so:
 * `toolExecution: false`.
 *
 * The line this file exists to hold: *the Messages API does not execute code.*
 * It can describe an edit in convincing prose. It cannot make one. So a
 * delegation that needs files changed is refused for this connection rather
 * than answered with a description, and no answer from here ever becomes
 * evidence that a file changed. The coding worker is a different connection
 * with a real executor behind it - the official Claude Code CLI - and
 * `docs/ORCHESTRATION_MODES.md` says which is which.
 *
 * Two accounts, one adapter. "Claude Trabalho 1" and "Claude Trabalho 2" are
 * two instances of this class with two credentials and two connection ids.
 * There is no second class, and there is no shared state between instances:
 * each invocation is self-contained, so one account's context can never reach
 * the other's.
 */

import type { AgentInput, AgentResult, HealthStatus } from '../core/types.js';
import { makeAgentResult } from '../agents/agent-runner.js';
import { estimateCostUsd } from './pricing.js';
import { getJson, postJson, type HttpTransport } from './provider-http.js';
import {
  ProviderError,
  addUsage,
  emptyUsage,
  type AgentProvider,
  type AuthenticationStatus,
  type InvocationUsage,
  type ModelDescriptor,
  type ProviderCapabilities,
} from './provider-types.js';

/** The API version header the Messages API documents. Sent on every call. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** Effort values `output_config.effort` documents. Nothing else is sent. */
export const ANTHROPIC_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface AnthropicProviderOptions {
  connectionId: string | null;
  /** Reads the key at call time, so a revoked key is never held in a field. */
  apiKey: () => string;
  baseUrl?: string;
  transport: HttpTransport;
  model?: string | null;
  reasoningEffort?: string | null;
  /** Role instructions, sent as `system` rather than buried in the prompt. */
  system?: string | null;
  /**
   * Output cap. The Messages API requires `max_tokens`, so unlike the OpenAI
   * side this cannot be left to the provider; the default is generous enough
   * for a plan or a review and is a budget lever the person can lower.
   */
  maxTokens?: number;
}

interface MessagesBody {
  id?: string;
  model?: string;
  stop_reason?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const DEFAULT_MAX_TOKENS = 8_000;

export class AnthropicApiProvider implements AgentProvider {
  readonly kind = 'anthropic-api' as const;
  readonly label = 'Claude (API)';
  readonly providerId = 'anthropic' as const;
  readonly connectionId: string | null;

  private readonly controllers = new Set<AbortController>();
  private total: InvocationUsage = emptyUsage('api-metered');

  constructor(private readonly options: AnthropicProviderOptions) {
    this.connectionId = options.connectionId;
  }

  async describeCapabilities():Promise<import('../routing/provider-policy.js').WorkerRuntimeCapabilities> {
    return {modelFlag:true,effortFlag:true,declaredModels:(await this.getAvailableModels()).map(m=>m.id),declaredModelsComplete:false,declaredEfforts:ANTHROPIC_EFFORTS};
  }

  getCapabilities(): ProviderCapabilities {
    return {
      providerId: 'anthropic',
      connectionKind: 'api',
      conversation: true,
      // The whole point of this field. See the file comment.
      toolExecution: false,
      workspaceRequired: false,
      streaming: false,
      structuredOutput: false,
      usageReporting: true,
      modelSelection: true,
      reasoningSelection: true,
      billing: 'api-metered',
    };
  }

  getUsage(): InvocationUsage {
    return this.total;
  }

  async run(input: AgentInput): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const model = input.routing?.model ?? this.options.model ?? null;
    if (!model) {
      return this.failure(
        startedAt,
        new ProviderError(
          'invalid-request',
          'Escolha um modelo para esta conexão Anthropic em Equipe antes de executar.',
        ),
      );
    }

    const requested = input.routing?.reasoning ?? this.options.reasoningEffort ?? null;
    const effort = requested && ANTHROPIC_EFFORTS.includes(requested) ? requested : null;
    if (input.strictRouting && requested && !effort) return this.failure(startedAt,new ProviderError('invalid-request','A API não aceita o raciocínio necessário para garantir o teto.'));
    const notes: string[] = [];
    if (requested && !effort) {
      notes.push(`a API da Anthropic não aceita o nível "${requested}"; enviado sem nível`);
    }

    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await postJson<MessagesBody>({
        url: `${this.baseUrl()}/messages`,
        headers: this.headers(),
        body: {
          model,
          max_tokens: this.options.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(this.options.system ? { system: this.options.system } : {}),
          ...(effort ? { output_config: { effort } } : {}),
          messages: [{ role: 'user', content: input.prompt }],
        },
        timeoutMs: input.timeoutMs,
        signal: controller.signal,
        transport: this.options.transport,
        providerLabel: 'a Anthropic',
      });

      const usage = this.readUsage(response, model);
      this.total = addUsage(this.total, usage);

      // A refusal and a truncation are both "the answer is not what was asked
      // for", and both must be visible rather than parsed as an empty result.
      const stop = response.stop_reason ?? null;
      const problem =
        stop === 'refusal'
          ? 'O modelo recusou a solicitação.'
          : stop === 'max_tokens'
            ? 'A resposta foi cortada no limite de tokens desta conexão.'
            : '';

      return makeAgentResult({
        startedAt,
        outcome: 'completed',
        exitCode: problem ? 1 : 0,
        stdout: textOf(response),
        stderr: problem,
        executable: `${this.baseUrl()}/messages`,
        observed:{model:response.model??null,reasoning:null},
        applied: {
          model,
          reasoning: effort,
          fallbackUsed: notes.length > 0,
          note: notes.length > 0 ? notes.join('; ') : null,
        },
        usage,
      });
    } catch (error) {
      return this.failure(startedAt, error);
    } finally {
      this.controllers.delete(controller);
    }
  }

  async cancel(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
  }

  async healthCheck(): Promise<HealthStatus> {
    const status = await this.getAuthenticationStatus();
    return status.authenticated
      ? { healthy: true, executable: this.baseUrl() }
      : {
          healthy: false,
          executable: this.baseUrl(),
          ...(status.problem ? { problem: status.problem } : {}),
          ...(status.remedy ? { hint: status.remedy } : {}),
        };
  }

  async getAvailableModels(): Promise<ModelDescriptor[]> {
    const body = await getJson<{
      data?: Array<{ id?: string; display_name?: string; created_at?: string }>;
    }>({
      url: `${this.baseUrl()}/models?limit=100`,
      headers: this.headers(),
      timeoutMs: 30_000,
      transport: this.options.transport,
      providerLabel: 'a Anthropic',
    });
    return (body.data ?? [])
      .filter((row): row is { id: string; display_name?: string; created_at?: string } =>
        typeof row.id === 'string',
      )
      .map((row) => ({
        id: row.id,
        displayName: row.display_name ?? row.id,
        createdAt: row.created_at ?? null,
      }));
  }

  async getAuthenticationStatus(): Promise<AuthenticationStatus> {
    const base = {
      connectionId: this.connectionId,
      providerId: 'anthropic' as const,
      connectionKind: 'api' as const,
      checkedAt: new Date().toISOString(),
    };
    let key = '';
    try {
      key = this.options.apiKey();
    } catch {
      key = '';
    }
    if (!key) {
      return {
        ...base,
        authenticated: false,
        problem: 'Esta conexão ainda não tem uma chave de API salva.',
        remedy: 'Adicionar chave',
      };
    }
    try {
      await this.getAvailableModels();
      return { ...base, authenticated: true, method: 'api-key' };
    } catch (error) {
      const provider = error instanceof ProviderError ? error : null;
      return {
        ...base,
        authenticated: false,
        problem: provider?.userMessage ?? 'Não foi possível verificar esta conexão.',
        remedy: provider?.kind === 'authentication' ? 'Trocar a chave' : 'Tentar de novo',
      };
    }
  }

  private baseUrl(): string {
    return (this.options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.options.apiKey(),
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  private readUsage(response: MessagesBody, model: string): InvocationUsage {
    const usage = response.usage;
    const input = usage?.input_tokens ?? null;
    const output = usage?.output_tokens ?? null;
    const cached = usage?.cache_read_input_tokens ?? null;
    const total = input === null && output === null ? null : (input ?? 0) + (output ?? 0);
    return {
      billing: 'api-metered',
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
      reasoningTokens: null,
      totalTokens: total,
      // Cached reads are billed at a fraction of the input rate; charging them
      // at the full rate keeps the estimate on the safe side of a budget.
      costUsd: estimateCostUsd(model, (input ?? 0) + (cached ?? 0), output),
      costReported: false,
    };
  }

  private failure(startedAt: string, error: unknown): AgentResult {
    const provider =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            'provider-error',
            'A chamada à Anthropic falhou.',
            error instanceof Error ? error.message : String(error),
          );
    return makeAgentResult({
      startedAt,
      outcome:
        provider.kind === 'timeout'
          ? 'timeout'
          : provider.kind === 'cancelled'
            ? 'cancelled'
            : 'spawn-error',
      exitCode: provider.status,
      stdout: '',
      stderr: provider.userMessage,
      error: provider.userMessage,
      executable: this.baseUrl(),
      failure: provider.kind,
      ...(provider.retryAfterSeconds !== null ? { retryAfterSeconds: provider.retryAfterSeconds } : {}),
    });
  }
}

/** The assistant's text: every text block, in order. */
function textOf(response: MessagesBody): string {
  return (response.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}
