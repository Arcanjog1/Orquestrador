/**
 * OpenAI, through the Responses API.
 *
 * This is the orchestrator's API-backed connection. It answers with a decision
 * in the same JSON contract the Codex CLI answers with, so the loop's
 * `parseDecision` and its DONE gate are the same code on both paths - one
 * orchestrator, one gate, two ways of reaching a model.
 *
 * What this adapter is careful about:
 *
 *  - **It invents no model names.** `getAvailableModels` asks `GET /v1/models`
 *    with this connection's own key, so the person picks from what their
 *    account really has. "Codex" the CLI, "Codex" the SDK and a coding model
 *    served by the API are three different things, and the only one this
 *    adapter can speak to is the third.
 *  - **It sends only what the request supports.** `reasoning.effort` goes out
 *    only when the caller asked for a level the API's documented set contains;
 *    an internal tier is resolved before it ever gets here, so the string
 *    "MAX" never reaches a provider.
 *  - **It cannot edit a file, and says so.** `toolExecution: false`. A coding
 *    delegation to this connection is refused by the loop rather than
 *    answered with a model's description of an edit it did not make.
 */

import type { AgentInput, AgentResult } from '../core/types.js';
import { makeAgentResult } from '../agents/agent-runner.js';
import type { HealthStatus } from '../core/types.js';
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

/** Effort values the Responses API documents. Nothing outside this is sent. */
export const OPENAI_EFFORTS: readonly string[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export interface OpenAiProviderOptions {
  /** The connection (account) this speaks for. Recorded on every invocation. */
  connectionId: string | null;
  /** Reads the key at call time, so a revoked key is never held in a field. */
  apiKey: () => string;
  /** Overridable for a compatible gateway; defaults to the documented host. */
  baseUrl?: string;
  transport: HttpTransport;
  /** Default model when an invocation carries no routing. Required to run. */
  model?: string | null;
  /** Default effort when an invocation carries no routing. */
  reasoningEffort?: string | null;
  /** The decision contract, when the caller wants structured output. */
  outputSchema?: { name: string; schema: Record<string, unknown> } | null;
  /** Role instructions, sent as `instructions` rather than inside the prompt. */
  instructions?: string | null;
  /** Bounded output. Absent leaves the provider's own default alone. */
  maxOutputTokens?: number | null;
}

interface ResponsesBody {
  id?: string;
  status?: string;
  model?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string; code?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

export class OpenAiApiProvider implements AgentProvider {
  readonly kind = 'openai-api' as const;
  readonly label = 'OpenAI (API)';
  readonly providerId = 'openai' as const;
  readonly connectionId: string | null;

  private readonly controllers = new Set<AbortController>();
  private total: InvocationUsage = emptyUsage('api-metered');

  constructor(private readonly options: OpenAiProviderOptions) {
    this.connectionId = options.connectionId;
  }

  async describeCapabilities():Promise<import('../routing/provider-policy.js').WorkerRuntimeCapabilities> {
    return {modelFlag:true,effortFlag:true,declaredModels:(await this.getAvailableModels()).map(m=>m.id),declaredModelsComplete:false,declaredEfforts:OPENAI_EFFORTS};
  }

  getCapabilities(): ProviderCapabilities {
    return {
      providerId: 'openai',
      connectionKind: 'api',
      conversation: true,
      // A model API produces text and tool calls. It does not touch a disk.
      toolExecution: false,
      workspaceRequired: false,
      streaming: false,
      structuredOutput: true,
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
      // Better than defaulting to a name we invented: the person picks from
      // the catalogue their account actually returned.
      return this.failure(
        startedAt,
        new ProviderError(
          'invalid-request',
          'Escolha um modelo para esta conexão OpenAI em Equipe antes de executar.',
        ),
      );
    }

    const requested = input.routing?.reasoning ?? this.options.reasoningEffort ?? null;
    const effort = requested && OPENAI_EFFORTS.includes(requested) ? requested : null;
    if (input.strictRouting && requested && !effort) return this.failure(startedAt,new ProviderError('invalid-request','A API não aceita o raciocínio necessário para garantir o teto.'));
    const notes: string[] = [];
    if (requested && !effort) {
      notes.push(`a API da OpenAI não aceita o nível "${requested}"; enviado sem nível`);
    }

    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const body: Record<string, unknown> = {
        model,
        input: input.prompt,
        ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        ...(effort ? { reasoning: { effort } } : {}),
        ...(this.options.maxOutputTokens ? { max_output_tokens: this.options.maxOutputTokens } : {}),
        ...(this.options.outputSchema
          ? {
              text: {
                format: {
                  type: 'json_schema',
                  name: this.options.outputSchema.name,
                  schema: this.options.outputSchema.schema,
                  strict: false,
                },
              },
            }
          : {}),
      };

      const response = await postJson<ResponsesBody>({
        url: `${this.baseUrl()}/responses`,
        headers: this.headers(),
        body,
        timeoutMs: input.timeoutMs,
        signal: controller.signal,
        transport: this.options.transport,
        providerLabel: 'a OpenAI',
      });

      const usage = this.readUsage(response, model);
      this.total = addUsage(this.total, usage);

      const text = textOf(response);
      // A response that ran out of room is not a valid decision; saying so is
      // more useful than handing the parser half a JSON object.
      const incomplete = response.status === 'incomplete' ? response.incomplete_details?.reason : null;
      const stderr = incomplete
        ? `A resposta foi interrompida pela API (${incomplete}).`
        : (response.error?.message ?? '');

      return makeAgentResult({
        startedAt,
        outcome: 'completed',
        exitCode: incomplete || response.error ? 1 : 0,
        stdout: text,
        stderr,
        executable: `${this.baseUrl()}/responses`,
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

  /**
   * The models this key really has.
   *
   * The catalogue is the account's, not a constant in this file: an account
   * without access to a model must not be offered it, and a model released
   * after this build must not be hidden from someone who has it.
   */
  async getAvailableModels(): Promise<ModelDescriptor[]> {
    const body = await getJson<{ data?: Array<{ id?: string; created?: number }> }>({
      url: `${this.baseUrl()}/models`,
      headers: this.headers(),
      timeoutMs: 30_000,
      transport: this.options.transport,
      providerLabel: 'a OpenAI',
    });
    return (body.data ?? [])
      .filter((row): row is { id: string; created?: number } => typeof row.id === 'string')
      .map((row) => ({
        id: row.id,
        displayName: row.id,
        createdAt: row.created ? new Date(row.created * 1000).toISOString() : null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async getAuthenticationStatus(): Promise<AuthenticationStatus> {
    const base = {
      connectionId: this.connectionId,
      providerId: 'openai' as const,
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
    return (this.options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.apiKey()}` };
  }

  private readUsage(response: ResponsesBody, model: string): InvocationUsage {
    const usage = response.usage;
    const input = usage?.input_tokens ?? null;
    const output = usage?.output_tokens ?? null;
    return {
      billing: 'api-metered',
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? null,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
      costUsd: estimateCostUsd(model, input, output),
      costReported: false,
    };
  }

  /** A provider failure, as the loop's process-shaped result. */
  private failure(startedAt: string, error: unknown): AgentResult {
    const provider =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            'provider-error',
            'A chamada à OpenAI falhou.',
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

/**
 * The assistant's text.
 *
 * `output_text` is the convenience field; when it is absent the message blocks
 * are walked, and a refusal block is surfaced as text rather than dropped -
 * a silent empty answer would look like a parse failure instead of a refusal.
 */
function textOf(response: ResponsesBody): string {
  if (typeof response.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text;
  }
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const block of item.content ?? []) {
      if (typeof block.text === 'string') parts.push(block.text);
      else if (typeof block.refusal === 'string') parts.push(block.refusal);
    }
  }
  return parts.join('\n');
}
