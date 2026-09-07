# Handoff — central de agentes

Estado ao fim da segunda sessão da reorientação.

## Baseline

| | |
|---|---|
| Repositório | `Arcanjog1/Orquestrador` (público) |
| Branch | `claude/ai-orchestrator-reorientacao-ytlkw0` |
| HEAD do início desta sessão | `b69a880` |
| `main` | **não existe** neste repositório |

Sem reset, sem merge, sem force-push, sem apagar branch.

## O que existe hoje

### Backend

- `AgentProvider extends AgentRunner` — a fronteira. Um loop, um DoneGate.
- Adapters: Codex CLI, Claude Code CLI, OpenAI Responses API, Anthropic
  Messages API.
- `ProviderCapabilities.toolExecution` — a regra que impede "a API disse que
  editou" virar "arquivo alterado". Uma delegação com `requiresTools` para um
  worker que declara `false` é recusada **antes** da invocação.
- `ConnectionService` — conexões CLI e API, credencial criptografada em tabela
  própria, `api_enabled` começando em 0.
- Equipes com N workers (`slot`, `label`), delegação por `workerId` validado
  contra a equipe real.
- Projetos de conversa (`environment = 'conversation'`): sem pasta, sem git,
  sem processo. `evaluateConversationDone` é um gate próprio, não o de código
  afrouxado.
- `BudgetLedger` — verificação **antes** da chamada, `NEEDS_HUMAN` ao atingir
  o limite, falhas terminais (saldo, credencial) param em vez de repetir.
- Sessões: `claude -p --resume <id>`, com o id lido do envelope
  `--output-format json`. Chaveado por (conversa × conexão).

### Interface

- **Conexões** (Configurações → Contas): lista CLI e API juntas, assinatura
  primeiro; adicionar, testar, renomear, substituir chave, desconectar,
  escolher modelo do catálogo real; diálogo de confirmação antes de habilitar
  cobrança.
- **Equipe**: N workers, adicionar/remover, recusa duas na mesma conexão.
- **Novo projeto**: Conversa · Código · Nuvem, com Conversa primeiro.
- **Limites de gasto** por projeto (Configurações → Execution).
- **Detalhes da execução**: por invocation — provider, tipo de conexão, worker,
  modelo, raciocínio, tokens, custo, falha classificada.

### Testes

| Suíte | Resultado |
|---|---|
| Root (`npm test`) | **497 passando**, 1 pulado |
| Electron (`npm run desktop:test`) | **27 passando** |
| Packaged smoke | **7 passando** (schema 10) |
| Typecheck (4 projetos) | limpo |

## O loop automático — o que já é verdade

O fluxo que o usuário pediu **já é o loop existente**, não algo a construir:

```
objetivo → Codex decide → delega ao worker nomeado → worker executa
        → evidência (se houver workspace) → verificação → Codex revisa
        → nova delegação → … → DoneGate
```

Ninguém copia prompt nem relatório. O que esta sessão acrescentou foi
continuidade: o worker retoma a própria sessão entre delegações.

Provado por dois testes E2E determinísticos em `tests/orchestration-modes.test.ts`
— o de conversa (Claude 1 → revisão → Claude 2 → revisão → DONE, sem pasta) e o
de código (arquivo real, evidência do git, verificação re-executada).

**Um teste determinístico não é um teste real.** Ver o roteiro abaixo.

## Human gates

### 1. `LOCAL_REAL_AUTH_TEST_PENDING`

Não existem contas Codex/Claude legítimas no CI, e este ambiente não tem
Windows. O teste com as suas contas é o que falta, e é simples:

1. instalar o novo `AI-Orchestrator-Setup.exe` por cima da versão anterior;
2. abrir o aplicativo — a base é migrada no lugar, nada é reautenticado;
3. Configurações → Contas: confirmar Codex e Claude conectados (se já estavam,
   continuam);
4. adicionar uma segunda conta Claude, se quiser dois workers;
5. Equipe: orquestrador = Codex, Worker 1 = Claude Trabalho 1
   (+ "Adicionar worker" para o segundo);
6. escolher um projeto **de código** com pasta local;
7. enviar um objetivo pequeno e verificável — por exemplo *"crie hello.txt com
   o texto pronto e registre uma verificação que confira isso"*;
8. acompanhar a timeline: Codex analisando → delegou → Claude executando →
   evidência → verificação → Codex revisando → nova delegação → DONE;
9. abrir **Detalhes** e conferir invocations, modelo, duração e consumo.

Sem PowerShell. Sem instalar Node. Sem copiar credencial. Sem servidor. Sem
API paga.

### 2. `API_E2E_VERIFIED` — não declarado

Nenhuma chamada real a `api.openai.com` ou `api.anthropic.com` foi feita:
não havia credencial legítima e ativar billing gastaria dinheiro seu sem
autorização. Nada foi inventado, nenhum dólar foi gasto.

Para verificar barato: criar conexão → colar chave → **Testar** (faz só um
`GET /v1/models`) → habilitar → definir `maxCostUsd = 1` → projeto de conversa.

## Limitações que ficam, ditas na cara

**Streaming.** `ProviderCapabilities.streaming` é `false` nos dois adapters de
API, e isso é honesto: eles não fazem streaming. A timeline é construída sobre
invocations reais, sem evento falso. Ambas as APIs suportam SSE; é o próximo
incremento natural, e foi deixado de fora deliberadamente para não atrasar o
instalador.

**Listar sessões existentes.** Nenhum dos CLIs oferece listagem não
interativa, e a doc do Claude Code diz que o formato do transcrito é interno e
pode quebrar a cada release. O app oferece as sessões que ele mesmo iniciou.
Ver `docs/PROVIDER_AUTHENTICATION.md` §6.

**Conversas do Claude Desktop.** Histórico separado, retomadas no próprio app.
Não há caminho oficial pelo CLI e o produto não inventa um.

**Sessão do orquestrador.** `codex exec resume` existe e não é usado de
propósito: o orquestrador recebe um prompt auto-contido a cada volta, e é isso
que o mantém no objetivo.

**Custo do worker CLI.** Só aparece quando o build instalado suporta
`--output-format json`; sem isso a coluna fica nula e a interface mostra "não
informado", nunca zero.

## Segurança do repositório

Público. Nada de credencial, chave de exemplo ou dado pessoal foi adicionado.
A pendência de `docs/SECURITY_HISTORY_CLEANUP.md` **não foi tocada**:
reescrever histórico exige autorização explícita e um force-push, e nenhum dos
dois foi feito.

## Próximo passo menor e concreto

Rodar o roteiro do item 1 acima com o novo instalador e uma tarefa pequena de
código, e relatar em que passo parou — se parar.
