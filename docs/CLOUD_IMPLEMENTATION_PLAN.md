# Nuvem — plano de implementação

O que está feito, o que falta, e em que ordem. Blocos concluídos trazem os
testes que os provam; blocos restantes trazem o menor passo concreto.

## Feito

### Bloco 0 — `CodexCapabilityError` (blocker do Windows)
Causa-raiz, correção e regressões em `docs/history/CODEX_CAPABILITY_INCIDENT.md`.
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

### Bloco 8 — evidência real na timeline de nuvem ✔
A evidência que o loop já coleta viaja no evento de progresso, então a timeline
de uma execução remota mostra arquivos alterados e diffstat reais **sem que o
repositório chegue ao computador da pessoa**. O diff completo fica de fora de
propósito: é grande, já está em disco nos artefatos da execução, e carregá-lo
em cada evento faria o log crescer com o tamanho da mudança em vez de com o que
aconteceu. *Teste:* `cloud-reconnection.test.ts`.

### Bloco 9 — publicar o resultado ✔ *(o PR ainda depende de um gate)*
Um workspace de nuvem é descartável, o que cria uma falha que o produto local
nunca teve: uma execução que editou arquivos, passou nas verificações e
satisfez o DoneGate, e foi então recolhida, **produziu nada**. Por isso a
publicação acontece **antes da liberação**: branch derivada do id da execução,
commit com a identidade do aplicativo (nunca a da pessoa), push com token
`contents: write` de vida curta pelo mesmo askpass do clone. Nunca force-push,
nunca commit vazio, e uma repetição escreve a mesma branch em vez de uma
segunda. *Teste:* `cloud-publish.test.ts`.

O pull request também está implementado, e é **opt-in**: abrir um é um ato
para fora, no repositório de alguém, e deve ser uma escolha da pessoa, não algo
que acontece porque uma execução terminou. A idempotência vem de perguntar ao
GitHub, não de lembrar: o PR aberto cuja head é aquela branch **é** o registro,
e ele sobrevive a reinício do coordenador, a nova tentativa e a um segundo
processo.

*Bloqueado por:* instalação do GitHub App com permissão de escrita — o código
está pronto e testado; o que falta é a autorização.

### Bloco 10 — E2E real  *(bloqueado)*
Ver `CLOUD_SESSION_HANDOFF.md`. Precisa de host, imagem construída, GitHub App
instalado e chaves de API.

### Bloco 11 — executor Windows remoto  *(fora de escopo por ora)*
Tarefas que dependem do Revit aberto continuam **locais**. Um contêiner Linux
não roda Revit desktop, e fingir o contrário seria pior do que não oferecer.
