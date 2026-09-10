# AI Orchestrator

Aplicação **desktop (Electron)** que orquestra agentes de programação locais.
Um agente **supervisor** (Codex CLI) planeja e decide em modo leitura; agentes
**trabalhadores** (Claude Code CLI, e providers por API) executam a alteração
num worktree isolado. O produto instala e gerencia os próprios runtimes, as
contas e as chaves — o usuário não precisa de terminal.

Branch oficial: **`main`**.

---

## O que ele faz

- **Orquestração real**: o supervisor delega, lê a evidência do que o worker
  fez e decide o próximo passo. Não é um chat com ferramentas.
- **Contas múltiplas por provider**, isoladas entre si (perfis separados de
  Codex e Claude), com login pela própria janela.
- **Agentes com função, provider, conta e modelo próprios**, com políticas
  `FIXED` e `CONTROLLED_AUTO`, tetos de modelo, política premium e restrições
  por modelo.
- **Disponibilidade de modelos por conta** em três estados verificados —
  confirmado, conhecido mas não verificado, indisponível — sem inferir
  negativas a partir de omissões.
- **GitHub** por login próprio (device flow): repositórios públicos e privados,
  leitura da árvore sem checkout, branch/commit/PR e leitura de checks. O token
  é cifrado por `safeStorage` e nunca chega ao renderer.
- **Evidência e DoneGate**: `fileReads`, `fileChecks`, diff real e verificações
  decidem se um objetivo está cumprido. Nada é dado como feito sem prova.
- **Proteções de execução**: intenção somente-leitura, anti-loop, retomada de
  permissão e cancelamento real de processo.
- **Execution Worktree** e painel de **Activity** para acompanhar o loop.

Panorama funcional completo: [`docs/PRODUTO_COMPLETO.md`](docs/PRODUTO_COMPLETO.md).

## Arquitetura

```
src/                 domínio, independente de Electron
  orchestrator/      decisão, delegação, DoneGate, intenção, anti-loop
  providers/         providers de agente (CLI e API) sobre uma interface comum
  agents/ routing/   agentes, funções, roteamento e tetos de modelo
  github/ git/       leitura de repositório, operações e evidência
  runtime/           instalação e versionamento dos CLIs gerenciados
  database/          SQLite com driver trocável e migrações
  execution/ worker/ fronteira de execução e worktree
  permissions/ security/  permissões, retomada e redação de segredos

apps/desktop/        Electron: main, preload (bridge tipada), renderer React
  src/main/          serviços, adapters de CLI e ipc-router
  src/shared/        contrato IPC, políticas e catálogo de modelos
  src/renderer/      UI (páginas, componentes orch/ e ui/)

apps/coordinator/    coordenador da execução remota
cloud/               imagem de container da execução remota
tests/               suíte de unidade e integração (Node test runner)
scripts/             provas reais de runtime e provider (usadas no CI)
docs/                arquitetura e guias atuais; history/ e audits/ ao lado
```

Detalhes: [`docs/PROVIDER_ARCHITECTURE.md`](docs/PROVIDER_ARCHITECTURE.md),
[`docs/ORCHESTRATION_MODES.md`](docs/ORCHESTRATION_MODES.md) e
[`docs/SESSION_HANDOFF_ELECTRON.md`](docs/SESSION_HANDOFF_ELECTRON.md)
(decisões inegociáveis, seção 3).

## Rodar

Requer **Node >= 20.11** (o CI usa 22).

```bash
npm ci
npm run desktop      # compila e abre a aplicação
```

## Testar

```bash
npm run typecheck                      # domínio, coordinator e desktop
npm test                               # suíte principal
npm run desktop:test                   # integração em Electron real
npm run -w apps/desktop test:packaged  # smoke no aplicativo empacotado
```

## Empacotar

```bash
npm run package         # Windows: instalador NSIS por usuário, sem elevação
npm run package:linux   # Linux: diretório desempacotado
```

O instalador de cada commit de `main` é publicado como pre-release
(`desktop-dev-<sha>`, mais a tag rolante `desktop-dev`).

## Desenvolver

Setup, fluxo de branches, release e o que o CI exige:
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).
