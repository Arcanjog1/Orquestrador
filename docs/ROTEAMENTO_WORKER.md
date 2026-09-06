# Roteamento automático do worker (Claude Code)

Registrado em 2026-09-06, branch `claude/lovable-on-latest-core`.

## O que é

O orquestrador (Codex) tem modelo e raciocínio **fixos**, escolhidos pela
pessoa em *Equipe* (ou o padrão do CLI). O worker (Claude Code) tem
**Seleção: Automático**: o AI Orchestrator escolhe o modelo e o nível de
raciocínio **para cada tarefa delegada** — não por projeto, não por conversa,
não por execução. Uma execução pode rodar a primeira delegação em `opus` e a
segunda em `haiku`.

## Contrato da decisão

Toda decisão do Codex traz, além de `action`/`task`/critérios, um bloco de
requisitos em **camadas**, nunca em nomes de modelo:

```json
"workerRequirements": {
  "capability": "fast" | "balanced" | "strong" | "max",
  "reasoning":  "low" | "medium" | "high" | "max",
  "rationale":  "uma linha, ou null"
}
```

O esquema (`DECISION_JSON_SCHEMA`, versão 3) segue o modo estrito da API de
Responses. Uma decisão antiga, sem o bloco, continua válida: o roteador cai
em `BALANCED/MEDIUM` e registra "decisão sem requisitos".

## Camadas (internas)

| capacidade | uso                                                    |
|------------|--------------------------------------------------------|
| FAST       | edições triviais/mecânicas, um arquivo, tarefas de git |
| BALANCED   | recurso ou correção comum dentro de um módulo          |
| STRONG     | depuração entre módulos, bugs sutis, refatorações      |
| MAX        | arquitetura crítica, dados, segurança, irreversível    |

Raciocínio: LOW / MEDIUM / HIGH / MAX, na mesma escala. Os nomes internos
nunca chegam a um CLI: `MAX` de raciocínio vira `max` **só** se o `--help`
do Claude Code declarou `max`; senão vira o mais forte declarado
(`xhigh`, depois `high`). Para o Codex, um nível fixo salvo (`max`) só é
enviado a um build ≥ 0.140.0; antes disso vira `xhigh`, e a execução avisa:
*"Este nível não é suportado pela versão atual."*

## O roteador (`src/routing/model-router.ts`)

Entrada, por invocação: provedor, conta, texto da tarefa, requisitos do
Codex, tentativas anteriores da execução, capacidades do CLI, estratégia da
pessoa. Saída: `resolvedModel`, `resolvedReasoning`, `selectionMode`,
`selectionReason` (uma linha), `fallbackUsed`, alternativas.

Ordem da decisão:

1. **Manual** → exatamente o que a pessoa digitou, validado contra o CLI.
2. **Pedido do Codex** (ou o padrão, se a decisão não trouxe requisitos).
3. **Piso de sanidade** (`task-assessment.ts`): sinais no texto da tarefa —
   esquema/banco, autenticação/segredos, concorrência, depuração entre
   módulos, arquitetura, impacto crítico — sobem a camada. Só promove;
   nunca rebaixa. Dois sinais distintos sobem mais um degrau ("mudança
   crítica de arquitetura" → MAX).
4. **Escalada** por falta de progresso: contada a partir das tentativas
   anteriores desta execução — uma sem progresso: +1 raciocínio; duas: +1
   modelo e +2 raciocínio. Falha mecânica (binário ausente, login, cota,
   rede) e modelo recusado **não** contam. A escalada é recalculada a cada
   delegação: uma tarefa simples depois de uma difícil volta a FAST.
5. **Estratégia**: *Priorizar velocidade* desce um degrau só em tarefas sem
   sinal de risco e sem escalada; *Priorizar qualidade* sobe um degrau.
6. **Política do provedor** (`provider-policy.ts`, versão 1): camada →
   candidatos por alias (`haiku`, `sonnet`, `opus`, `fable`); um modelo
   recusado pelo CLI nesta execução é pulado e o próximo candidato
   (primeiro os mais fortes) é tentado, com registro. Flag ausente no
   `--help` → o valor simplesmente não é enviado.

## Descoberta de capacidades

Prioridade: **CLI** (`--help` do binário instalado, lido no ambiente da
conta: `--model`, `--effort` e os valores que a página enumera) > política
central versionada. Nada de chamada à API do provedor com credenciais da
máquina. Metadado desconhecido não derruba nada: `null` significa "a ajuda
não disse", e só os valores universais (`low`, `medium`, `high`) são
enviados. As capacidades são lidas uma vez por execução — trocar a conta do
worker faz a leitura de novo.

## Registro

`agent_invocations` (migração 4): `requested_capability`,
`requested_reasoning`, `resolved_model`, `resolved_reasoning`,
`selection_mode` (`auto` | `manual` | `fixed`), `selection_reason`,
`fallback_used`. O orquestrador grava `fixed` com o que o adapter
realmente enviou. A linha de tempo mostra, no cartão de cada invocação do
worker, o modelo, o raciocínio e "Seleção automática: <motivo>";
*Detalhes* lista Modelo · Raciocínio · Seleção · Pedido · Motivo.

Ao Codex, o feedback da iteração anterior inclui `WORKER OF THIS ITERATION:
requested / ran as / outcome / progressed`, para que o próximo pedido seja
informado pelo anterior.

## Interface

*Equipe → Coding worker*: Provider Anthropic · Account · **Seleção:
Automático** · **Estratégia: Balanceado** (Priorizar velocidade / Priorizar
qualidade). Texto: *"O AI Orchestrator escolhe o modelo e o nível de
raciocínio para cada tarefa."* **Configuração avançada** abre a seleção
manual (Model / Reasoning, enviados exatamente). O orquestrador mantém
Provider OpenAI · Account · Model · Reasoning (`low` … `max`, validado
contra o build).

## Testes

- `tests/model-router.test.ts`: git simples → FAST; trivial → FAST; comum →
  BALANCED; depuração entre módulos → STRONG; arquitetura crítica → MAX
  (interno, `fable`); MAX nunca vira `max` sem declaração (Claude e Codex);
  manual exato; indisponível → fallback; sem progresso repetido → escalada;
  simples após difícil → desescalada; STRONG e FAST na mesma execução;
  capacidades como entrada; decisão sem requisitos → padrão; piso promove
  e nunca rebaixa; velocidade ignora tarefa sensível.
- `tests/desktop-routing.test.ts` (loop real, git real, DONE gate real):
  STRONG depois FAST numa execução, ambos no registro e na conversa; sem
  requisitos → BALANCED/MEDIUM; modelo recusado → próximo candidato, duas
  invocações na mesma iteração; escalada e desescalada dentro da execução;
  troca de conta relê capacidades; seleção manual persistida; nível fixo do
  orquestrador não suportado dito uma vez, nas palavras prometidas.
- `tests/desktop-adapters.test.ts`: Claude Code por invocação e só valores
  declarados; Codex `max` → `xhigh` em build antigo; leitura do `--help`.
- `tests/database.test.ts`: banco anterior à migração 4 sobe no lugar.
