# Handoff — reorientação para central de agentes

Estado ao fim desta sessão, e o que a próxima precisa saber.

## Baseline

| | |
|---|---|
| Repositório | `Arcanjog1/Orquestrador` (público) |
| Branch desta sessão | `claude/ai-orchestrator-reorientacao-ytlkw0` |
| HEAD de partida | `b53120c` |
| `main` | **não existe** neste repositório |

A branch designada estava em `5ca6062`, um ancestral estrito e sem commits
próprios. `claude/ai-orchestrator-implementation-y7xw98` @ `b53120c` era o
superconjunto de tudo (119 commits; `lovable-on-latest-core` e
`continuation-grblen` já estavam contidos nela), então a branch foi avançada
por fast-forward para lá. Nada foi resetado, nada foi apagado, nada foi
forçado, `main` não foi tocada e nenhum merge foi feito.

## O que foi feito

1. **Pesquisa de autenticação** → `docs/PROVIDER_AUTHENTICATION.md`
2. **Fronteira de providers** → `AgentProvider extends AgentRunner`
3. **Adapter OpenAI** (Responses API) e **Anthropic** (Messages API)
4. **Conexões e credenciais** → `ConnectionService`, migração 9
5. **Modo conversa** → projeto sem pasta, gate próprio
6. **Equipes com N workers** → `slot` + `label`, delegação por `workerId`
7. **Recusa por capacidade** → `toolExecution: false` bloqueia edição
8. **Controles de custo** → `BudgetLedger`, `NEEDS_HUMAN`, falhas terminais
9. **Testes** → 40 novos casos, 495 no total, todos verdes

## O que **não** foi feito, e por quê

### Telas de UI (React)

O `ConnectionService` está completo e exposto por IPC
(`connections.list/addApi/replaceKey/rename/setEnabled/setPreferences/disconnect/test/models`),
com validação e contrato tipado. **As telas do renderer ainda não foram
escritas.** Faltam:

- uma tela de conexões que liste CLI e API juntas, com o aviso de cobrança
  separada e o switch de habilitar;
- a tela de equipe com N workers (hoje o `TeamForm` é orquestrador + 1 worker);
- o botão "novo projeto de conversa" na tela inicial;
- os campos de orçamento por projeto;
- a timeline nomeando o worker por `workerLabel` (o evento já carrega).

A camada de baixo está pronta e testada; é trabalho de renderer.

### `run.usage` na timeline

`RunProgressEvent` já tem `usage?: RunUsageView`, e o evento de parada por
orçamento o emite. Os eventos de progresso comuns ainda não — o consumo aparece
como mensagem de sistema no fim do run.

### Streaming real

`ProviderCapabilities.streaming` é `false` nos dois adapters de API, e isso é
honesto: eles não fazem streaming ainda. A timeline é baseada nas invocations
reais, sem evento falso. Ambas as APIs suportam SSE; é o próximo incremento
natural.

### Probes reais e release

Ver abaixo.

## Human gates

### 1. Chamada real de API (bloqueia `API_E2E_VERIFIED`)

Não havia credencial de teste legítima disponível nesta sessão, e ativar
billing gastaria dinheiro do usuário sem autorização. Nada foi inventado, nada
foi ativado.

Como o usuário verifica, com risco baixo:

1. Contas → adicionar conexão OpenAI, colar chave, **testar conexão**;
2. adicionar as duas conexões Anthropic do mesmo jeito;
3. habilitar as três;
4. definir `maxCostUsd` = 1 no projeto;
5. criar um projeto de conversa e mandar um objetivo.

O teste de conexão faz um `GET /v1/models` — barato, e já prova credencial,
host e cabeçalho.

### 2. Release

Nenhuma pre-release foi publicada. O CI do Windows e o instalador NSIS não
foram executados nesta sessão (não há runner Windows aqui). O último instalador
publicado continua sendo `desktop-dev-f169c80`, e ele **não** contém este
trabalho.

## Onde continuar

**O próximo passo menor e concreto:** escrever a tela de conexões no renderer
(`apps/desktop/src/renderer/pages/Settings.tsx`, ao lado do `GitHubCard`),
consumindo `connections.list` e `connections.addApi`, mostrando `keyHint` e
nunca a chave, com o aviso de cobrança separada ao lado do switch de habilitar.

Tudo de que ela precisa já existe e está testado.

## Regressões conhecidas

Nenhuma. 495 testes, 494 passando, 1 pulado (o mesmo de antes); 23 testes
Electron passando; typecheck limpo nos quatro projetos.

Dois testes existentes foram **atualizados**, não removidos:
`desktop-orchestration.test.ts` esperava os rótulos "Codex preparando a
tarefa..." e "Claude executando...". Os rótulos agora nomeiam papéis, porque o
orquestrador pode ser um CLI ou uma API e o worker é o membro da equipe que foi
nomeado.

## Segurança do repositório

O repositório é público. Nenhuma credencial, exemplo de chave ou dado pessoal
foi adicionado neste trabalho. A pendência histórica descrita em
`docs/SECURITY_HISTORY_CLEANUP.md` não foi tocada: reescrever histórico exige
autorização explícita e um force-push, e nenhum dos dois foi feito.
