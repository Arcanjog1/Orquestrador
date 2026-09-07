# Custos, limites e o que este aplicativo pode (e não pode) garantir

Começando pela frase mais importante deste documento, que também é a que a
interface mostra:

> **Um limite configurado aqui interrompe este aplicativo. Ele não é um teto
> cobrado pelo provider.**

Este processo pode se recusar a fazer a próxima chamada. Ele não pode fazer a
OpenAI ou a Anthropic recusarem uma. Só os controles de gasto da própria conta,
no painel do provider, fazem isso. Quem precisa de um teto financeiro real
configura lá — e o aplicativo não finge o contrário.

---

## 1. O modo API nasce desligado

Três passos separados, de propósito:

1. **criar a conexão e colar a chave** — a chave é guardada, e nada mais;
2. **habilitar a conexão** (`api_enabled`) — um ato deliberado;
3. **usar a conexão numa equipe**.

Entre 1 e 2 não sai uma única chamada paga. Uma chave salva não começa a custar
por ter sido salva. Em código: `apiProviderFor()` devolve `null` para uma
conexão com `api_enabled != 1`, e a verificação de prontidão diz, em português,
que a conexão existe mas não foi habilitada.

Testes que fixam isso: *"a metered connection can be enabled only once it has a
key"* e *"a key is stored encrypted"* (que checa `apiEnabled === false` logo
após salvar).

---

## 2. Nenhum fallback automático de assinatura para API paga

Se o limite da assinatura acabar, a execução **para** em `NEEDS_HUMAN` com a
explicação. Ela não "continua na API" por conta própria.

Isso não é uma omissão: é uma ausência deliberada. Não existe caminho no código
que troque uma conexão CLI por uma conexão de API quando a primeira falha. A
troca é uma escolha da pessoa, sempre.

---

## 3. O que é medido, e o que fica nulo

Cada invocation grava, quando o provider informa:

`provider_id`, `connection_kind`, `worker_id`, `billing`, `input_tokens`,
`output_tokens`, `total_tokens`, `cost_usd`, `failure_kind`.

E o run soma: `invocation_count`, `total_tokens`, `total_cost_usd`.

**Nulo continua nulo.** Um provider que não informou tokens deixa a coluna
`NULL`, e a interface mostra "não informado" — nunca zero. Um run que gastou
algo desconhecido não pode parecer um run que não gastou nada.

O mesmo vale para modelo sem preço conhecido: `estimateCostUsd` devolve `null`,
a chamada é contada como **`unpricedInvocations`**, e o resumo diz "N sem preço
conhecido" em vez de somar zero.

### A estimativa erra para cima, de propósito

`docs`/`src/providers/pricing.ts` cobra tokens de cache pela tarifa cheia de
input, embora ambos os vendors cobrem uma fração. Entre errar para menos e
errar para mais num alerta de orçamento, errar para mais é o lado seguro.

Uma cifra informada pelo próprio provider (o `total_cost_usd` do Claude Code
CLI, por exemplo) vence a tabela.

---

## 4. Os limites disponíveis

Por projeto (`workspaces.budget_*`), todos opcionais e todos `NULL` por padrão
— nenhum projeto existente muda de comportamento:

| limite | efeito |
|---|---|
| `maxInvocations` | teto de chamadas por execução |
| `maxTokens` | teto de tokens por execução |
| `maxCostUsd` | teto de dólares estimados, **só para chamadas medidas** |

### Verificado *antes* da chamada

```
budget.check()   ← aqui
     ↓ allowed
provider.run()
     ↓
budget.record(usage)
```

Depois da chamada o dinheiro já foi. O `check()` acontece antes de pedir a
decisão ao orquestrador e antes de cada delegação.

### Uma chamada de assinatura nunca é cobrada de um limite em dólares

Ela não tem custo em dólares para cobrar, e fingir que tem faria o modo conversa
parecer caro — empurrando a pessoa para o caminho pago. Limites de chamadas e de
tokens continuam valendo para ela.

### Parar por orçamento é `NEEDS_HUMAN`, não `FAILED`

Nada quebrou. Um limite que a pessoa configurou foi atingido, e o que vem a
seguir é decisão dela. A diferença muda o que a interface oferece: "aumente o
limite e continue", não "algo deu errado".

### O aviso aparece uma vez

Aos 80% (`warnAt`), uma frase, por limite. Um aviso repetido a cada iteração
vira ruído e é ignorado — o oposto do que um alerta de orçamento serve para
fazer.

---

## 5. Falhas que param a execução em vez de repetir

Classificadas por `ProviderFailureKind`, não por *match* de string:

| falha | é retentável? | o que o loop faz |
|---|---|---|
| `insufficient-credit` | **não** | para em `NEEDS_HUMAN` |
| `authentication` | **não** | para em `NEEDS_HUMAN` |
| `permission` | **não** | para em `NEEDS_HUMAN` |
| `rate-limit` | sim | espera; **nunca** escala de modelo |
| `timeout` / `network` / `provider-error` | sim | conforme a lógica de retry existente |
| `model-unavailable` | — | tenta o próximo candidato do roteador |
| `invalid-request` / `schema` | não | reporta com o trecho da resposta |

Insistir numa chamada recusada por falta de saldo é como um loop queima uma
tarde contra uma parede — e cada tentativa pode custar. Escalar para um modelo
mais caro por causa de rate limit é gastar mais para ser recusado igual.

Ambos os vendors escrevem "sem saldo" de formas diferentes (`insufficient_quota`,
`credit balance is too low`, `billing_error` num 403, um 402 seco). Todas caem no
mesmo lugar — teste *"an empty balance stops the run and is never retried"*.

---

## 6. Cancelamento

Cancelar um run:

- aborta o sinal, então o loop para entre fases;
- chama `cancel()` nos runners, que aborta o `AbortController` da chamada HTTP
  em voo;
- impede novas delegações;
- preserva o histórico;
- libera o ambiente exatamente uma vez;
- **não** usa `cancelAll` global e não toca em outras sessões.

Uma chamada em voo cancelada vira `outcome: 'cancelled'`, não um erro de
provider — teste *"cancelling a run stops the call in flight and does not report
an outage"*.

---

## 7. O que ainda é um human gate

Os testes determinísticos provam o loop, o contrato, os gates e a classificação
de falhas — sem rede e sem custo.

Eles **não** provam que a OpenAI ou a Anthropic respondem como este código
espera. Só uma chamada real prova isso, e uma chamada real gasta dinheiro do
usuário.

Portanto:

- nenhuma credencial foi inventada;
- nenhum billing foi ativado;
- nenhum dólar foi gasto;
- **`API_E2E_VERIFIED` não é declarado.**

O primeiro teste real é do usuário: criar uma conexão, colar a chave, habilitar,
definir um `maxCostUsd` baixo (US$ 1 já basta) e mandar um objetivo de conversa.
