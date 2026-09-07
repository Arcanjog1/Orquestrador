# Decisão de arquitetura — execução em nuvem

**Status:** decidida e implementada (código, não só documento).
**Data:** 2026-09-07.
**Branch:** `claude/ai-orchestrator-implementation-y7xw98`.

## O problema

Hoje o produto é:

```
AI Orchestrator (Electron, Windows)
  → pasta local
  → Codex e Claude Code como processos filhos do Windows
```

O que se quer é:

```
AI Orchestrator
  → GitHub (repositório + branch)
  → ambiente isolado remoto
  → Codex e Claude Code lá dentro
  → Evidence / Verification / DoneGate
  → branch, push, PR
```

Com duas exigências que decidem tudo:

1. **sem clone no PC do usuário** — o repositório é clonado *dentro* do
   servidor;
2. **o trabalho continua com o aplicativo fechado ou o computador desligado.**

A segunda é a que elimina a maior parte das opções: qualquer coisa que só
funcione enquanto o Electron está aberto não resolve o problema.

## Opções avaliadas

### A. Agentes gerenciados da Anthropic (Claude Agent SDK / Managed Agents)

Executam um agente Claude em sandbox gerenciada, com API oficial.

**Por que não como arquitetura principal.** O loop deste produto é
`Codex → delegação → Claude → evidence → verification → Codex review →
segunda delegação → DoneGate`. O orquestrador é o **Codex**, um CLI de outro
fornecedor, rodando **no mesmo workspace** que o worker, lendo o mesmo git.
Uma sandbox gerenciada que executa Claude não executa o `codex exec` do
OpenAI. Fingir compatibilidade aqui seria exatamente o que o pedido proíbe:
não é uma limitação a contornar, é o loop inteiro que não caberia.

Continua útil como **fonte de referência conceitual** e como possível
executor de tarefas somente-Claude no futuro. Não é a base.

### B. Infraestrutura própria: coordenador + workspaces em contêiner  ← **ESCOLHIDA**

Um serviço nosso (o **Run Coordinator**) que possui as execuções, e um
**provisionador de workspace** que cria um ambiente isolado por sessão, com o
repositório clonado dentro e as duas CLIs instaladas.

**Por que esta.** É a única opção em que o loop existente roda inteiro, sem
modificação, com os dois agentes no mesmo workspace — e a única em que a
execução é nossa e portanto pode continuar sem o desktop.

### C. Cloud development environments com API (Codespaces, Gitpod, Coder)

Contêineres Linux com o repositório, criados por API oficial.

**Por que não como principal.** Duas razões concretas:

- executar comando não interativo dentro deles passa por SSH ou por um canal
  próprio de cada produto — uma dependência a mais que **não remove** a
  necessidade do coordenador, porque alguém ainda precisa possuir a execução,
  registrar eventos e sobreviver a reinício;
- o ciclo de vida é orientado a "uma pessoa desenvolvendo", não a "um lote de
  execuções sem ninguém olhando".

**Mantida como a única alternativa documentada.** O `WorkspaceProvisioner` é
uma porta justamente para que trocar B por C seja implementar uma classe, não
reescrever o produto.

## A decisão

> **Coordenador próprio + provisionador de workspace em contêiner, com o
> provisionador atrás de uma porta.**

```
Electron (desktop)                       Servidor
  │                                        │
  ├─ CloudClient ──HTTPS + token──▶  Run Coordinator
  │   (submete e lê;                   ├─ RunStore (durável)
  │    nunca dirige)                   │    ├─ log de eventos (seq por run)
  │                                    │    ├─ chaves de idempotência
  │                                    │    └─ leases
  │                                    ├─ OrchestrationService  ← o MESMO
  │                                    ├─ Reaper (custos)
  │                                    └─ WorkspaceProvisioner (porta)
  │                                          ├─ ContainerWorkspaceProvisioner
  │                                          └─ (alternativa: CDE por API)
  │                                                │
  │                                          workspace isolado
  │                                            ├─ git clone (token de instalação)
  │                                            ├─ codex exec      (orquestrador)
  │                                            └─ claude --print  (worker)
```

## O que torna isso possível sem duplicar o produto

A fronteira de execução (`src/execution/process-runner.ts`).

O loop depende do computador em **exatamente uma** coisa: iniciar processos
filhos em um diretório. Nomear isso como interface (`ProcessRunner`) e juntar
o runner ao caminho que lhe pertence (`ExecutionEnvironment`) é o que permite
que o **mesmo `OrchestrationService`** rode nos dois lugares.

Não existe um loop de nuvem. Não existe um segundo DoneGate. Um loop
simplificado para a nuvem seria um segundo portão de conclusão para manter
honesto, e essa é uma promessa que o produto acabaria quebrando.

`tests/execution-boundary.test.ts` fixa que a fronteira é *completa*: uma
execução com ambiente remoto não alcança nem o `ProcessManager` local nem o
`local_path` — e o modo Local continua entregando a pasta do projeto.

## Consequências aceitas

| Consequência | Por quê |
|---|---|
| Precisamos operar infraestrutura | É o preço de executar dois CLIs de fornecedores diferentes no mesmo workspace. |
| O contêiner precisa de imagem própria | `cloud/image/Dockerfile`. Construir por execução faria a pessoa esperar minutos por algo que nunca muda. |
| Credenciais de API são necessárias | Assinatura pessoal de ChatGPT/Claude **não** autoriza login pessoal em servidor de terceiro. Ver `CLOUD_SECURITY_AND_COSTS.md`. |
| Custo por segundo | Por isso limites e reaper existem desde o primeiro dia, não como melhoria futura. |

## O que já está implementado

| Bloco | Arquivo | Testes |
|---|---|---|
| Fronteira de execução | `src/execution/process-runner.ts` | `tests/execution-boundary.test.ts` |
| Porta do provisionador | `src/cloud/provisioner.ts` | — |
| Provisionador em contêiner | `src/cloud/container-provisioner.ts` | `tests/cloud-provisioner.test.ts` |
| Imagem do workspace | `cloud/image/` | — |
| Acesso ao repositório (GitHub App) | `src/cloud/github-app-access.ts` | `tests/cloud-github-access.test.ts` |
| Store durável | `src/cloud/coordinator/store.ts` | `tests/cloud-coordinator.test.ts` |
| Coordenador | `apps/coordinator/src/coordinator.ts` | `tests/cloud-coordinator.test.ts` |
| API HTTP | `apps/coordinator/src/http.ts` | `tests/cloud-coordinator.test.ts` |
| Reaper | `apps/coordinator/src/reaper.ts` | `tests/cloud-coordinator.test.ts` |
| Cliente do desktop | `apps/desktop/src/main/services/cloud-client.ts` | `tests/cloud-reconnection.test.ts` |
| Sincronização / reconexão | `apps/desktop/src/main/services/cloud-service.ts` | `tests/cloud-reconnection.test.ts` |
| Conexão do dispositivo | `apps/desktop/src/main/services/cloud-account-service.ts` | `tests/cloud-reconnection.test.ts`, Electron |
| Projeto de nuvem (sem pasta) | `workspace-service.ts`, `dialogs.tsx` | Electron |

## O que ainda não está provado

`CLOUD_EXECUTION_VERIFIED` **não** foi declarado. O que falta é infraestrutura
real e credenciais — ver `CLOUD_SESSION_HANDOFF.md`, seção *human gates*.
