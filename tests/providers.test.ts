/**
 * The API providers, failure by failure.
 *
 * Every case here runs against a scripted transport, so the whole matrix the
 * product must survive - an expired key, a rate limit, an empty balance, a
 * truncated answer, a body that is not JSON, a cancellation mid-flight - is
 * exercised on every run, deterministically, with no network and no money.
 *
 * The cases that matter most are the ones about *money*: an
 * `insufficient-credit` must be classified as such and must not be retryable,
 * because a loop that retries it burns an afternoon against a wall, and a
 * budget check must refuse the call **before** it is made rather than after.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiApiProvider } from '../src/providers/openai-provider.js';
import { AnthropicApiProvider } from '../src/providers/anthropic-provider.js';
import { classify, type HttpTransport, type HttpResponse } from '../src/providers/provider-http.js';
import { ProviderError } from '../src/providers/provider-types.js';
import { BudgetLedger } from '../src/providers/budget.js';
import { estimateCostUsd, priceOf } from '../src/providers/pricing.js';
import { parseDecision } from '../src/orchestrator/decision-parser.js';
import { DECISION_JSON_SCHEMA } from '../src/orchestrator/decision-schema.js';

/** One recorded call, so a test can assert what really went on the wire. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

/** A transport that answers from a script and records what it was asked. */
function scripted(...responses: Array<HttpResponse | (() => Promise<HttpResponse>)>): {
  transport: HttpTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const transport: HttpTransport = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? safeParse(init.body) : null,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error('no scripted response');
    return typeof next === 'function' ? next() : next;
  };
  return { transport, calls };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const INPUT = {
  prompt: 'OBJECTIVE: add a test',
  workingDirectory: '/tmp',
  timeoutMs: 5_000,
  runId: 'run-1',
  iteration: 1,
};

// -- OpenAI: the orchestrator's structured decision ------------------------

test('OpenAI returns a decision the existing parser accepts, and asks for it by schema', async () => {
  const decision = {
    action: 'delegate',
    task: 'Write the failing test first',
    acceptanceCriteria: ['npm test passes'],
    verificationCommands: ['tests'],
    summary: 'Começando pelo teste',
    workerRequirements: { capability: 'balanced', reasoning: 'medium', rationale: null },
  };
  const { transport, calls } = scripted(
    reply(200, {
      status: 'completed',
      output_text: JSON.stringify(decision),
      usage: {
        input_tokens: 1200,
        output_tokens: 300,
        total_tokens: 1500,
        input_tokens_details: { cached_tokens: 800 },
        output_tokens_details: { reasoning_tokens: 120 },
      },
    }),
  );
  const provider = new OpenAiApiProvider({
    connectionId: 'conn-openai',
    apiKey: () => 'sk-test',
    transport,
    model: 'gpt-test',
    reasoningEffort: 'high',
    outputSchema: { name: 'decision', schema: DECISION_JSON_SCHEMA },
    instructions: 'You supervise.',
  });

  const result = await provider.run(INPUT);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.exitCode, 0);

  // The whole point of the boundary: the same parser, the same gate.
  const parsed = parseDecision(result.stdout);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.equal(parsed.decision.action, 'delegate');
  assert.equal(parsed.decision.workerRequirements?.capability, 'BALANCED');

  const body = calls[0]!.body as Record<string, any>;
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.instructions, 'You supervise.');
  assert.equal(body.reasoning.effort, 'high');
  // The flattened `text.format` shape the Responses API documents.
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.name, 'decision');
  assert.equal(calls[0]!.headers.authorization, 'Bearer sk-test');

  assert.equal(result.usage?.billing, 'api-metered');
  assert.equal(result.usage?.inputTokens, 1200);
  assert.equal(result.usage?.cachedInputTokens, 800);
  assert.equal(result.usage?.reasoningTokens, 120);
});

test('an effort the API does not document is dropped, not sent, and is reported', async () => {
  const { transport, calls } = scripted(reply(200, { status: 'completed', output_text: 'ok' }));
  const provider = new OpenAiApiProvider({
    connectionId: 'c',
    apiKey: () => 'k',
    transport,
    model: 'gpt-test',
  });
  // "MAX" is an internal tier. It must never reach a provider by that name.
  const result = await provider.run({ ...INPUT, routing: { model: 'gpt-test', reasoning: 'MAX' } });
  assert.equal((calls[0]!.body as Record<string, unknown>).reasoning, undefined);
  assert.equal(result.applied?.reasoning, null);
  assert.equal(result.applied?.fallbackUsed, true);
  assert.match(result.applied?.note ?? '', /não aceita o nível "MAX"/);
});

test('no model configured is a stated problem, never a model name we invented', async () => {
  const { transport, calls } = scripted(reply(200, {}));
  const provider = new OpenAiApiProvider({ connectionId: 'c', apiKey: () => 'k', transport });
  const result = await provider.run(INPUT);
  assert.equal(calls.length, 0, 'nothing may be sent without a chosen model');
  assert.equal(result.outcome, 'spawn-error');
  assert.equal(result.failure, 'invalid-request');
  assert.match(result.error ?? '', /Escolha um modelo/);
});

test('the model catalogue comes from the account, not from a constant', async () => {
  const { transport } = scripted(
    reply(200, { data: [{ id: 'model-b', created: 1 }, { id: 'model-a', created: 2 }] }),
  );
  const provider = new OpenAiApiProvider({ connectionId: 'c', apiKey: () => 'k', transport });
  const models = await provider.getAvailableModels();
  assert.deepEqual(
    models.map((m) => m.id),
    ['model-a', 'model-b'],
  );
});

// -- Anthropic: the conversation worker ------------------------------------

test('Anthropic answers as a worker, reports usage, and declares it cannot edit files', async () => {
  const { transport, calls } = scripted(
    reply(200, {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Aqui está a análise.' }],
      usage: { input_tokens: 900, output_tokens: 250, cache_read_input_tokens: 100 },
    }),
  );
  const provider = new AnthropicApiProvider({
    connectionId: 'claude-1',
    apiKey: () => 'sk-ant-1',
    transport,
    model: 'claude-sonnet-5',
    system: 'You are the worker.',
  });

  const result = await provider.run(INPUT);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.stdout, 'Aqui está a análise.');
  assert.equal(calls[0]!.headers['x-api-key'], 'sk-ant-1');
  assert.equal(calls[0]!.headers['anthropic-version'], '2023-06-01');
  const body = calls[0]!.body as Record<string, any>;
  assert.equal(body.system, 'You are the worker.');
  assert.ok(body.max_tokens > 0, 'the Messages API requires max_tokens');

  // The rule the product turns on: this connection cannot change a file.
  const capabilities = provider.getCapabilities();
  assert.equal(capabilities.toolExecution, false);
  assert.equal(capabilities.conversation, true);
  assert.equal(capabilities.workspaceRequired, false);
  assert.equal(capabilities.billing, 'api-metered');

  // Cost is an estimate over input + cached input, erring high.
  const expected = estimateCostUsd('claude-sonnet-5', 1000, 250);
  assert.equal(result.usage?.costUsd, expected);
});

test('two Claude connections are two credentials and never share context', async () => {
  const one = scripted(reply(200, { content: [{ type: 'text', text: 'de um' }], usage: { input_tokens: 10, output_tokens: 5 } }));
  const two = scripted(reply(200, { content: [{ type: 'text', text: 'de dois' }], usage: { input_tokens: 20, output_tokens: 7 } }));
  const worker1 = new AnthropicApiProvider({
    connectionId: 'claude-trabalho-1',
    apiKey: () => 'key-one',
    transport: one.transport,
    model: 'claude-sonnet-5',
  });
  const worker2 = new AnthropicApiProvider({
    connectionId: 'claude-trabalho-2',
    apiKey: () => 'key-two',
    transport: two.transport,
    model: 'claude-sonnet-5',
  });

  await worker1.run({ ...INPUT, prompt: 'segredo do worker 1' });
  await worker2.run({ ...INPUT, prompt: 'tarefa do worker 2' });

  assert.equal(one.calls[0]!.headers['x-api-key'], 'key-one');
  assert.equal(two.calls[0]!.headers['x-api-key'], 'key-two');
  // Each invocation is self-contained; nothing from one account's prompt can
  // appear in the other's request.
  const sentToTwo = JSON.stringify(two.calls[0]!.body);
  assert.ok(!sentToTwo.includes('segredo do worker 1'));
  // And their ledgers are separate.
  assert.equal(worker1.getUsage().inputTokens, 10);
  assert.equal(worker2.getUsage().inputTokens, 20);
});

test('a refusal and a truncation are surfaced, not swallowed as an empty answer', async () => {
  const refusal = scripted(reply(200, { stop_reason: 'refusal', content: [] }));
  const truncated = scripted(
    reply(200, { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'metade' }] }),
  );
  const make = (t: HttpTransport) =>
    new AnthropicApiProvider({ connectionId: 'c', apiKey: () => 'k', transport: t, model: 'claude-sonnet-5' });

  const a = await make(refusal.transport).run(INPUT);
  assert.equal(a.exitCode, 1);
  assert.match(a.stderr, /recusou/);

  const b = await make(truncated.transport).run(INPUT);
  assert.equal(b.exitCode, 1);
  assert.match(b.stderr, /cortada no limite/);
});

// -- Failure classification ------------------------------------------------

test('an expired key is an authentication failure and is not retryable', async () => {
  const { transport } = scripted(
    reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
  );
  const provider = new AnthropicApiProvider({
    connectionId: 'c',
    apiKey: () => 'bad',
    transport,
    model: 'claude-sonnet-5',
  });
  const result = await provider.run(INPUT);
  assert.equal(result.failure, 'authentication');
  assert.equal(result.outcome, 'spawn-error');
  assert.equal(new ProviderError('authentication', 'x').retryable, false);
});

test('a rate limit is retryable and carries the wait the provider asked for', () => {
  const error = classify(429, JSON.stringify({ error: { type: 'rate_limit_error' } }), '30', 'a Anthropic');
  assert.equal(error.kind, 'rate-limit');
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSeconds, 30);
});

test('an empty balance stops the run and is never retried', () => {
  // Both vendors phrase it differently; both must land in the same place.
  const anthropic = classify(
    400,
    JSON.stringify({
      error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the API' },
    }),
    null,
    'a Anthropic',
  );
  const openai = classify(
    429,
    JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }),
    null,
    'a OpenAI',
  );
  const paymentRequired = classify(402, '{}', null, 'a OpenAI');

  for (const error of [anthropic, openai, paymentRequired]) {
    assert.equal(error.kind, 'insufficient-credit', error.message);
    assert.equal(error.retryable, false, 'retrying an empty balance is how a loop burns time');
  }
});

test('a body that is not JSON is a schema failure naming what came back', async () => {
  const { transport } = scripted(reply(200, '<html>gateway</html>'));
  const provider = new OpenAiApiProvider({
    connectionId: 'c',
    apiKey: () => 'k',
    transport,
    model: 'm',
  });
  const result = await provider.run(INPUT);
  assert.equal(result.failure, 'schema');
  assert.match(result.error ?? '', /não é JSON/);
});

test('a 403 that names billing is treated as credit, not as a permission problem', () => {
  const error = classify(403, JSON.stringify({ error: { type: 'billing_error' } }), null, 'a Anthropic');
  assert.equal(error.kind, 'insufficient-credit');
});

test('cancelling a run stops the call in flight and does not report an outage', async () => {
  const controller = new AbortController();
  const transport: HttpTransport = (_url, init) =>
    new Promise((_resolve, rejectCall) => {
      init.signal?.addEventListener('abort', () => rejectCall(new Error('aborted')), { once: true });
      controller.abort();
    });
  const provider = new AnthropicApiProvider({
    connectionId: 'c',
    apiKey: () => 'k',
    transport,
    model: 'claude-sonnet-5',
  });
  const running = provider.run(INPUT);
  await provider.cancel();
  const result = await running;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.failure, 'cancelled');
});

test('a provider that never answers times out at the invocation timeout', async () => {
  const transport: HttpTransport = (_url, init) =>
    new Promise((_resolve, rejectCall) => {
      init.signal?.addEventListener('abort', () => rejectCall(new Error('aborted')), { once: true });
    });
  const provider = new OpenAiApiProvider({ connectionId: 'c', apiKey: () => 'k', transport, model: 'm' });
  const result = await provider.run({ ...INPUT, timeoutMs: 20 });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.failure, 'timeout');
});

test('a connection with no key saved says so without calling anything', async () => {
  const { transport, calls } = scripted(reply(200, {}));
  const provider = new AnthropicApiProvider({ connectionId: 'c', apiKey: () => '', transport });
  const status = await provider.getAuthenticationStatus();
  assert.equal(status.authenticated, false);
  assert.equal(calls.length, 0);
  assert.match(status.problem ?? '', /chave de API/);
});

// -- The ledger ------------------------------------------------------------

test('a cost limit refuses the next call before it is made', () => {
  const ledger = new BudgetLedger({ maxCostUsd: 0.1 });
  assert.equal(ledger.check().allowed, true);
  ledger.record({
    billing: 'api-metered',
    inputTokens: 1000,
    outputTokens: 1000,
    totalTokens: 2000,
    costUsd: 0.12,
  });
  const verdict = ledger.check();
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed === false ? verdict.reason : '', /Nenhuma nova chamada foi feita/);
  // And it never claims to be a cap the provider enforces.
  assert.match(
    verdict.allowed === false ? verdict.reason : '',
    /não é um teto cobrado pelo provider/,
  );
});

test('a subscription invocation is counted but never charged against a dollar budget', () => {
  const ledger = new BudgetLedger({ maxCostUsd: 0.01, maxInvocations: 3 });
  for (let i = 0; i < 2; i += 1) {
    ledger.record({
      billing: 'subscription',
      inputTokens: 5_000,
      outputTokens: 5_000,
      totalTokens: 10_000,
      costUsd: null,
    });
  }
  assert.equal(ledger.snapshot.costUsd, 0);
  assert.equal(ledger.snapshot.tokens, 20_000);
  assert.equal(ledger.check().allowed, true, 'a plan call must not trip a dollar limit');
  ledger.record({ billing: 'subscription', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null });
  assert.equal(ledger.check().allowed, false, 'but the invocation limit still applies');
});

test('a metered call with no known price is flagged rather than counted as free', () => {
  const ledger = new BudgetLedger({ maxCostUsd: 5 });
  ledger.record({
    billing: 'api-metered',
    inputTokens: 100,
    outputTokens: 100,
    totalTokens: 200,
    costUsd: null,
  });
  assert.equal(ledger.snapshot.unpricedInvocations, 1);
  assert.match(ledger.describe(), /sem preço conhecido/);
});

test('the budget warns once, near the limit, and then stops repeating itself', () => {
  const ledger = new BudgetLedger({ maxInvocations: 10, warnAt: 0.8 });
  const warningOf = (): string | null => {
    const verdict = ledger.check();
    return verdict.allowed ? verdict.warning : null;
  };
  for (let i = 0; i < 7; i += 1) ledger.record(null);
  assert.equal(warningOf(), null);
  ledger.record(null);
  assert.match(warningOf() ?? '', /Orçamento desta execução/);
  assert.equal(warningOf(), null, 'a warning repeated every turn is noise');
});

test('a ledger with no limits only counts', () => {
  const ledger = new BudgetLedger();
  assert.equal(ledger.unlimited, true);
  for (let i = 0; i < 100; i += 1) ledger.record(null);
  assert.equal(ledger.check().allowed, true);
});

test('an unknown model has no price rather than a guessed one', () => {
  assert.equal(priceOf('some-model-we-never-heard-of'), null);
  assert.equal(estimateCostUsd('some-model-we-never-heard-of', 1000, 1000), null);
  // A dated snapshot is priced by its family, longest prefix first.
  assert.equal(estimateCostUsd('claude-opus-5-20260401', 1_000_000, 0), 5);
  assert.equal(estimateCostUsd('claude-sonnet-5', 0, 1_000_000), 10);
});
