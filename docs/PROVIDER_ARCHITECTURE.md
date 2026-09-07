# A arquitetura de providers

## A decisão de fronteira

A pergunta da auditoria era: *qual é o menor ponto de extensão para suportar
providers via API sem criar um segundo motor?*

A resposta estava no que o loop já usava. `OrchestrationService` conversa com
`AgentRunner`:

```ts
interface AgentRunner {
  readonly kind: AgentKind;
  readonly label: string;
  run(input: AgentInput): Promise<AgentResult>;
  cancel(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
}
```

Então `AgentProvider` **estende** essa interface em vez de substituí-la:

```ts
interface AgentProvider extends AgentRunner {
  readonly providerId: ProviderId;
  readonly connectionId: string | null;
  getCapabilities(): ProviderCapabilities;
  getAvailableModels(): Promise<ModelDescriptor[]>;
  getAuthenticationStatus(): Promise<AuthenticationStatus>;
  getUsage(): InvocationUsage;
}
```

Consequências, que eram o objetivo:

- **`OrchestrationService` não mudou de contrato.** Continua chamando `run`,
  `cancel` e `healthCheck`.
- **Não existe um segundo loop.** Não existe um segundo DoneGate.
- Os adapters de CLI que já existiam continuam válidos sem alteração: eles
  satisfazem `AgentRunner`, e `isAgentProvider()` distingue quem declara mais.
- Um runner que **não** declara capacidades devolve `null` — e o loop trata
  isso como "não sei", não como "não pode". Ausência de declaração não é
  declaração de ausência; só um `toolExecution: false` explícito recusa uma
  delegação.

`AgentResult` ganhou três campos opcionais — `usage`, `failure`,
`retryAfterSeconds` — e `AgentKind` ganhou `openai-api` e `anthropic-api`. Tudo
aditivo.

---

## O mapa

```
src/providers/
  provider-types.ts      AgentProvider, ProviderCapabilities, ProviderError
  provider-http.ts       o único caminho HTTP: timeout, cancelamento, classificação
  openai-provider.ts     Responses API
  anthropic-provider.ts  Messages API
  pricing.ts             estimativa de custo, com null honesto
  budget.ts              BudgetLedger: conta antes, registra depois

apps/desktop/src/main/
  adapters/codex-adapter.ts        Codex CLI      (preservado)
  adapters/claude-adapter.ts       Claude Code CLI (preservado)
  services/connection-service.ts   conexões e credenciais
  services/orchestration-service.ts o loop         (estendido, não substituído)
```

---

## ProviderCapabilities

Cada adapter declara o que **ele** faz. Nada aqui é uma promessa que o loop faz
em nome de um provider.

| campo | Codex CLI | Claude Code CLI | OpenAI API | Anthropic API |
|---|---|---|---|---|
| `connectionKind` | cli | cli | api | api |
| `conversation` | ✅ | ✅ | ✅ | ✅ |
| **`toolExecution`** | ✅ | ✅ | ❌ | ❌ |
| `workspaceRequired` | ✅ | ✅ | ❌ | ❌ |
| `structuredOutput` | ✅ | ✅ | ✅ | ❌ |
| `usageReporting` | — | ✅ (`--output-format json`) | ✅ | ✅ |
| `billing` | subscription | subscription | api-metered | api-metered |

`toolExecution` é o campo que sustenta o produto. Ver
`docs/ORCHESTRATION_MODES.md`.

---

## O adapter OpenAI

`POST {base}/responses`, `Authorization: Bearer`.

```jsonc
{
  "model": "<escolhido pela pessoa, do catálogo da conta>",
  "input": "<o prompt>",
  "instructions": "<a postura do papel>",
  "reasoning": { "effort": "low|medium|high|xhigh|max" },   // só se documentado
  "text": {
    "format": { "type": "json_schema", "name": "...", "schema": { }, "strict": false }
  }
}
```

Notas de contrato, verificadas contra os tipos do SDK oficial:

- `text.format` é **achatado** — `name`, `schema` e `strict` ficam direto sob
  `format`. O formato aninhado `json_schema: {...}` é da Chat Completions,
  não da Responses API.
- a resposta é lida por `output_text` e, na ausência dele, pelos blocos
  `message` → `output_text` / `refusal`. Uma recusa vira texto visível em vez
  de sumir como resposta vazia.
- `status: 'incomplete'` e `error` viram `exitCode: 1` com o motivo em `stderr`.
  Entregar meio JSON ao parser seria pior do que dizer que a resposta foi
  cortada.
- `usage` traz `input_tokens`, `output_tokens`, `total_tokens`,
  `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`.

O schema de decisão é o **mesmo** `DECISION_JSON_SCHEMA` que o Codex CLI recebe:
um contrato, dois transportes.

---

## O adapter Anthropic

`POST {base}/messages`, `x-api-key`, `anthropic-version: 2023-06-01`.

```jsonc
{
  "model": "<escolhido pela pessoa>",
  "max_tokens": 8000,            // obrigatório na Messages API
  "system": "<a postura do papel>",
  "output_config": { "effort": "low|medium|high|xhigh|max" },  // só se documentado
  "messages": [{ "role": "user", "content": "<o prompt>" }]
}
```

- `stop_reason: 'refusal'` e `'max_tokens'` viram `exitCode: 1` com a
  explicação. Uma recusa e uma resposta cortada são ambas "não é o que foi
  pedido", e ambas precisam ser visíveis.
- `usage` traz `input_tokens`, `output_tokens`, `cache_read_input_tokens`.
- `max_tokens` é uma alavanca de orçamento, não só um limite técnico.

---

## Classificação de falhas

Escrita uma vez, em `provider-http.ts`, porque duas delas carregam dinheiro:

```
402, ou 400/403/429 cujo corpo fala de saldo/cota  →  insufficient-credit  (NÃO retentável)
401                                                →  authentication       (NÃO retentável)
403                                                →  permission           (NÃO retentável)
429                                                →  rate-limit           (esperar, nunca escalar)
404 / "model not found"                            →  model-unavailable
400 / 413 / 422                                    →  invalid-request
>= 500                                             →  provider-error
corpo que não é JSON                               →  schema
```

Os dois envelopes de erro são lidos: o da Anthropic
(`{"type":"error","error":{...}}`) e o da OpenAI (`{"error":{...}}`).

`retry-after` é aceito em segundos ou como data HTTP, e vira segundos.

---

## Descoberta de modelos

Nenhum adapter carrega lista de modelos. `getAvailableModels()` pergunta:

- OpenAI: `GET /v1/models` → `{ data: [{ id, created }] }`
- Anthropic: `GET /v1/models?limit=100` → `{ data: [{ id, display_name, created_at }] }`

Isso resolve duas coisas de uma vez: uma conta sem acesso a um modelo não é
oferecida a ele, e um modelo lançado depois deste build não fica escondido de
quem tem acesso.

`src/providers/pricing.ts` **tem** uma tabela — mas só para estimar custo, e um
modelo que ela não conhece devolve `null`, nunca um palpite.

---

## Como uma credencial é lida

Nunca guardada em um campo. O adapter recebe uma **função**:

```ts
new AnthropicApiProvider({ apiKey: () => this.readKey(account.id), /* ... */ })
```

Assim uma chave revogada ou trocada vale já na próxima chamada, e nenhum objeto
de vida longa segura um segredo. `readKey` é o único caminho que descriptografa,
e ele existe para a chamada que está prestes a acontecer.

Um store que não consegue descriptografar (máquina nova, keychain resetado)
devolve string vazia — o adapter reporta "sem chave salva" e a pessoa cola de
novo. Não é um crash.

---

## Persistência

Migração **9**, `provider-connections-and-run-kinds`, inteiramente aditiva.

| tabela | o que ganhou |
|---|---|
| `accounts` | `connection_kind` (default `'cli'`), `secret_ref`, `key_hint`, `base_url`, `default_model`, `default_reasoning`, `api_enabled` (default `0`) |
| `provider_secrets` | **nova**: `account_id`, `ciphertext` — separada para que listar conexões nunca toque em segredo |
| `runs` | `kind` (default `'coding'`), `invocation_count`, `total_tokens`, `total_cost_usd` |
| `agent_invocations` | `provider_id`, `connection_kind`, `worker_id`, `billing`, `input_tokens`, `output_tokens`, `total_tokens`, `cost_usd`, `failure_kind` |
| `workspace_agents` | `slot`, `label` |
| `workspaces` | `budget_max_invocations`, `budget_max_tokens`, `budget_max_cost_usd` |

Nenhum `DROP`, nenhum `DELETE`, nenhuma coluna removida. Todo default preserva o
comportamento anterior: contas viram `cli`, runs viram `coding`, orçamentos
ficam `NULL`. Contas, equipes, projetos, sessões, runs, histórico, credenciais e
workspaces existentes sobrevivem intactos.
