# Handoff — execução em nuvem

**Branch:** `claude/ai-orchestrator-implementation-y7xw98`
**HEAD inicial:** `de4b4aa` (de `claude/lovable-on-latest-core`, o mais recente)
**HEAD final:** ver `git log -1` na branch
**Nada foi feito em `main`. Nenhum merge, nenhum force-push, nenhuma branch apagada.**

A branch parte de `de4b4aa` e só acrescenta. `claude/lovable-on-latest-core`
está intocada; era e continua sendo o HEAD mais recente entre todas as branches
remotas (as outras são de 3 e 4 de setembro).

## Estado do produto

**`READY_FOR_CLOUD_HUMAN_TEST`**, com uma ressalva honesta:
`CLOUD_EXECUTION_VERIFIED` **não** foi declarado, e não pode ser — falta
infraestrutura real e credenciais, que são human gates.

O que existe é arquitetura de nuvem completa, com o loop real, provada por
testes que rodam os adaptadores reais, o git real, o verifier real e o DoneGate
real. O que não existe é a prova contra um host de verdade.

## Blocos concluídos

| # | Bloco | Onde |
|---|---|---|
| 0 | Causa-raiz e correção do `CodexCapabilityError` | `docs/CODEX_CAPABILITY_INCIDENT.md` |
| 1 | Fronteira de execução (`ProcessRunner`, `ExecutionEnvironment`) | `src/execution/` |
| 2 | Modelo de dados de nuvem (migrações 6 e 7) | `src/database/schema.ts` |
| 3 | Porta do provisionador + contêiner + imagem | `src/cloud/`, `cloud/image/` |
| 4 | Token de instalação de GitHub App | `src/cloud/github-app-access.ts` |
| 5 | Run Coordinator: store durável, API, reaper, processo | `apps/coordinator/` |
| 6 | Cliente e sincronização no desktop | `apps/desktop/src/main/services/cloud-*.ts` |
| 7 | Modo Nuvem na interface | `dialogs.tsx`, `TopContextBar.tsx`, `CloudCard.tsx` |
| 8 | Evidência real na timeline de nuvem | `orchestration-service.ts`, `cloud-service.ts` |
| 9 | Publicação: branch, commit, push e PR opcional | `src/cloud/publish.ts` |

Detalhes e decisões: `CLOUD_ARCHITECTURE_DECISION.md`,
`CLOUD_SECURITY_AND_COSTS.md`, `CLOUD_IMPLEMENTATION_PLAN.md`.

## Testes

| Camada | Resultado |
|---|---|
| Raiz (`npm test`) | **433 passam, 1 pulado** (o pulado é anterior a este trabalho) |
| Typecheck (raiz + coordenador + main + renderer) | limpo |
| Electron (`npm run desktop:test`) | **23 passam** |
| Sonda contra o Codex 0.153.4 real | PASS (`scripts/probe-codex-capability.mjs`) |
| Windows CI | ver a última execução da branch |

Testes novos deste trabalho: `execution-boundary`, `cloud-provisioner`,
`cloud-coordinator`, `cloud-github-access`, `cloud-reconnection`, mais casos em
`desktop-adapters` e dois no Electron.

**Nenhum teste foi removido ou enfraquecido. O DoneGate não foi afrouxado. O CI
não foi alterado para esconder falha.**

## Human gates — o que só você pode fazer

Nada abaixo foi feito, e nada abaixo deve ser feito por um agente.

### 1. `BLOCKED_BY_CLOUD_ACCOUNT` — host e billing
Um servidor Linux com `docker` ou `podman`. Nenhuma infraestrutura paga foi
contratada. Os tetos de custo já estão implementados e ligados por padrão
(`CLOUD_SECURITY_AND_COSTS.md`, §8).

### 2. `BLOCKED_BY_EXTERNAL_SETUP` — imagem do workspace
```
docker build -t ai-orchestrator/workspace:1 cloud/image
```
Precisa ser alcançável pelo host que roda o coordenador.

### 3. `BLOCKED_BY_EXTERNAL_SETUP` — GitHub App
Criar o App, instalá-lo na conta/organização, dar acesso aos repositórios
desejados e, se a organização usa SAML, **autorizar a instalação para o SSO**.
Guardar `ORQ_GITHUB_APP_ID` e `ORQ_GITHUB_APP_PRIVATE_KEY`.

### 4. `BLOCKED_BY_EXTERNAL_SETUP` — chaves de API
`ORQ_OPENAI_API_KEY` e `ORQ_ANTHROPIC_API_KEY`.
**Assinatura de ChatGPT/Claude não serve** e não é usada: nenhum `auth.json`,
cookie ou login de desktop é copiado para servidor. Sem chave, a execução falha
dizendo isso em vez de fingir estar logada.

### 5. `LOCAL_REAL_AUTH_TEST_PENDING` — reteste do Windows
O bloco 0 está provado por testes e contra o binário real, mas o reteste com as
suas contas conectadas só você pode fazer. Roteiro em
`docs/CODEX_CAPABILITY_INCIDENT.md`, seção final.

## Subir o coordenador (quando os gates acima estiverem resolvidos)

```bash
npm run -w apps/coordinator build

export ORQ_WORKSPACE_IMAGE=ai-orchestrator/workspace:1
export ORQ_GITHUB_APP_ID=Iv23li…
export ORQ_GITHUB_APP_PRIVATE_KEY="$(cat app.private-key.pem)"
export ORQ_OPENAI_API_KEY=sk-…
export ORQ_ANTHROPIC_API_KEY=sk-ant-…
export ORQ_DATABASE_FILE=/var/lib/ai-orchestrator/coordinator.db
# Loopback por padrão. Expor é uma decisão de deploy, atrás de TLS.
export ORQ_HOST=127.0.0.1
export ORQ_PORT=8787

npm run -w apps/coordinator start
```

Ele **recusa subir** sem imagem ou sem credencial do GitHub App: aceitar
execuções que não conseguiria executar é pior do que não iniciar.

**Emitir um token de dispositivo**, no host:

```bash
node dist-coordinator/apps/coordinator/src/main.js issue-token "PC do Arcanjo"
```

Imprime o token **uma única vez** — só o hash fica guardado, então nem o
servidor consegue lê-lo de novo. Um segundo dispositivo da mesma pessoa
(`ORQ_PRINCIPAL="PC do Arcanjo"`) reaproveita o mesmo principal, de modo que o
outro computador vê o mesmo histórico em vez de uma lista vazia.

Emitir credencial é um comando do host, não uma rota da API: mintar acesso não
pode ser algo que uma requisição consiga pedir.

Cole esse token em **Configurações → Nuvem** no desktop, junto com a URL.

## Roteiro do teste obrigatório (prioridade 10)

1. criar projeto **Nuvem**, escolher repositório privado e branch pela GUI;
2. enviar um objetivo;
3. confirmar que a timeline mostra *Preparando ambiente → Clonando → Codex
   analisando → Claude executando → Evidence → Verification → Codex revisando →
   nova delegação*;
4. **fechar o Electron** no meio;
5. esperar;
6. reabrir: o estado e o histórico devem reaparecer completos, **sem passos
   duplicados** (é o que o cursor garante, e o que
   `cloud-reconnection.test.ts` fixa);
7. confirmar que **nenhuma pasta local** foi criada.

Só depois disso `CLOUD_EXECUTION_VERIFIED` pode ser declarado.

## Próximo passo menor e concreto

**Expor a escolha de publicação na interface.** O coordenador já publica o
resultado (branch, commit, push) e abre um pull request quando a execução pede,
mas hoje isso é um campo do `team` que a interface ainda não escreve — então a
publicação usa o padrão (publica, sem PR) e ninguém consegue pedir o PR pela
GUI.

*Menor passo:* dois controles no formulário de equipe de um projeto de nuvem —
"publicar o resultado em uma branch" (ligado) e "abrir pull request" (desligado)
— gravados no workspace e enviados no `team` da submissão, que já os aceita.
Nada nisso depende de um human gate; só o PR *funcionar* depende do GitHub App
com permissão de escrita.

## O que não fazer

- não fazer merge em `main`;
- não fazer force-push nem apagar branches;
- não reescrever o loop, o DoneGate, o ProjectService ou o sistema de contas —
  a nuvem os **reutiliza**, e essa é a propriedade que sustenta tudo;
- não copiar credencial de desktop para servidor;
- não contratar infraestrutura sem autorização;
- não declarar prova real sem infraestrutura real.
