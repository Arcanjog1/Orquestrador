# Nuvem — plano de implementação

O que está feito, o que falta, e em que ordem. Blocos concluídos trazem os
testes que os provam; blocos restantes trazem o menor passo concreto.

## Feito

### Bloco 0 — `CodexCapabilityError` (blocker do Windows)
Causa-raiz, correção e regressões em `docs/CODEX_CAPABILITY_INCIDENT.md`.
Provado também contra o binário oficial 0.153.4
(`scripts/probe-codex-capability.mjs`). **Falta:** reteste humano no Windows
com contas conectadas — `LOCAL_REAL_AUTH_TEST_PENDING`.

### Bloco 1 — fronteira de execução
`ProcessRunner` + `ExecutionEnvironment`. O mesmo `OrchestrationService` roda
local e remoto; não existe segundo loop nem segundo DoneGate.
*Testes:* `execution-boundary.test.ts` (a fronteira é completa; o modo Local
não mudou).

### Bloco 2 — modelo de dados da nuvem
Migração 6: `workspaces.environment` (padrão `local`, então toda instalação
existente continua idêntica), repositório/branch, tabela `cloud_workspaces`,
e em `runs` o workspace remoto, o `remote_run_id` e o `remote_cursor`.
Migração 7: principais, sessões de dispositivo, execuções remotas, chaves de
idempotência, log de eventos, leases.

### Bloco 3 — provisionador
Porta (`src/cloud/provisioner.ts`) + contêiner
(`src/cloud/container-provisioner.ts`) + imagem (`cloud/image/`).
*Testes:* menor privilégio, teto em todo recurso, token fora de URL/argv/config,
motivos de falha acionáveis, workspace meio-feito derrubado.

### Bloco 4 — acesso ao repositório privado
GitHub App, token de instalação estreitado a um repositório e uma permissão,
válido por ~1 h. *Testes:* o estreitamento em si, o JWT realmente assinado e
dentro do teto de 10 min, "não instalado" e SSO nomeados.

### Bloco 5 — coordenador
Store durável (log de eventos, idempotência, leases), o loop existente apontado
para o workspace, API HTTP mínima e autenticada, reaper, processo com
recuperação no start-up. *Testes:* isolamento entre inquilinos, ausência de
endpoint de execução, retomada exata por cursor, e **uma execução chegando a
DONE sem nada conectado a ela** — adapters reais, git real, verifier real,
gate real.

### Bloco 6 — desktop
`CloudClient` (submete e lê; nunca dirige), `CloudService` (submissão
idempotente e catch-up exato), `CloudAccountService` (token do dispositivo
protegido e não legível de volta). *Testes:* `cloud-reconnection.test.ts`.

### Bloco 7 — interface
Escolha de ambiente antes de tudo; em Nuvem nenhuma pasta é pedida; seleção de
repositório e branch com dados reais; chip de ambiente no cabeçalho; ações de
git local escondidas para projeto de nuvem; cartão de conexão em Configurações.
*Testes:* Electron, pela ponte real.

## Restante

### Bloco 8 — timeline de nuvem mais rica  *(não bloqueado)*
Hoje os eventos remotos chegam à timeline local como passos com o resumo do
evento. Falta apresentar diff, arquivos alterados e resultado de verificação
com a mesma riqueza do modo local, **sem baixar o repositório**.
*Menor passo:* fazer o coordenador anexar `GitEvidence` (arquivos, inserções,
remoções, diffstat) ao evento `orchestration.run:progress` da fase `evidence`,
e o `CloudService` gravá-lo onde a timeline local já lê.

### Bloco 9 — branch, push e PR na nuvem  *(parcialmente bloqueado)*
O clone já usa token de instalação. Falta o caminho de escrita: criar branch,
commitar, empurrar e abrir PR **de dentro** do workspace, com um token
`contents: write` de vida curta e proteção contra repetição.
*Menor passo:* uma ação idempotente no coordenador, com chave derivada do
`run_id`, para que uma repetição não abra um segundo PR.
*Bloqueado por:* instalação do GitHub App com permissão de escrita.

### Bloco 10 — E2E real  *(bloqueado)*
Ver `CLOUD_SESSION_HANDOFF.md`. Precisa de host, imagem construída, GitHub App
instalado e chaves de API.

### Bloco 11 — executor Windows remoto  *(fora de escopo por ora)*
Tarefas que dependem do Revit aberto continuam **locais**. Um contêiner Linux
não roda Revit desktop, e fingir o contrário seria pior do que não oferecer.
