# Session handoff — a interface

Estado da camada visual depois da reconciliação. Para **por que** existiam duas
linhas e como foram unidas, ver `SESSION_HANDOFF_RECONCILIATION.md`.

Escrito em 2026-09-04.

---

## 1. Baseline reconciliado

| | |
|---|---|
| Branch | `claude/lovable-on-latest-core` |
| **Baseline de código verificado no Windows** | **`66f7a07`** |
| Run de CI | [33910787494](https://github.com/Arcanjog1/Orquestrador/actions/runs/33910787494) — `success` |
| Commits acima dele | somente documentação; o último também passou ([33915266384](https://github.com/Arcanjog1/Orquestrador/actions/runs/33915266384)) |
| Base funcional | `claude/ai-orchestrator-continuation-grblen` @ `903a60b` |
| Design | `Arcanjog1/ai-project-lead` @ `3986bb9` |

Este é o ponto de partida confiável. Não recomeçar de `5ca6062`.

## 2. O que o Windows real provou em `66f7a07`

| Gate | Resultado |
|---|---|
| Typecheck (backend + main + renderer) | verde |
| Testes unitários e de integração | 242 · 241 pass · 0 fail · 1 skip (POSIX-only, `preflight.test.ts:67`) |
| Electron integration | 11/11 |
| Packaged smoke, no binário empacotado | 7/7 |
| `node:sqlite` empacotado | `schema 2, journal wal` |
| Codex managed runtime | 0.153.0, SHA-256 **VERIFIED**, health PASS, adapter PASS |
| Claude managed runtime | 2.1.252, SHA-256 **VERIFIED**, health PASS, `--version` exit 0 |
| ProcessManager cleanup | `taskkill /T /F`, **0 órfãos**, live count 0 |
| NSIS | `oneClick=true perMachine=false` |
| `AI-Orchestrator-Setup.exe` | **111 MB**, produzido |

Electron 44.1.1 · Node 24.19.0 · Chromium 152.0.7977.65 · Windows 10.0.26100.

## 3. Onde a interface vive

```
apps/desktop/src/renderer/
  styles.css              tokens do design; difere do protótipo em 1 linha
                          (raiz do @source) mais o bloco @font-face
  components/ui/          10 componentes shadcn, byte a byte iguais
  components/orch/        sidebar, top bar, timeline, composer, activity,
                          dialogs, primitives
  pages/                  Workspace, Onboarding, Settings, History
  lib/                    api (re-export), timeline (run real -> cards),
                          orchestrator-data (vocabulário), useApi, utils
  router.tsx              hash router; mesma API `<Link to search>`
```

O build: `@tailwindcss/cli` compila o stylesheet, o esbuild empacota o bundle,
as fontes são copiadas ao lado. Uma única `<script>` sob `script-src 'self'`.

## 4. O que cada área lê

| Área do design | Fonte real |
|---|---|
| Sidebar · Recentes | `chat.listSessions` |
| Sidebar · Projetos | `workspace.list` |
| Chip GitHub | `WorkspaceView.repositoryUrl` |
| Chip Branch | `WorkspaceView.branch`, lido do working copy |
| Chip Orquestrador | `agents.list` + `workspace.setAgents` |
| Status pill | `RunView.status` + estágio de `run:progress` |
| Timeline | `chat.listMessages` + `run:progress` |
| Iteração | `RunView.iterations` |
| Activity · Steps | estágios de `run:progress` |
| Composer | `chat.sendMessage` — dispara o loop real |
| Onboarding · Componentes | `runtime.diagnose` / `runtime.install` |
| Onboarding · Agentes | `accounts.create` / `accounts.connect`, **OpenAI e Anthropic** |
| Settings | `settings.all` / `settings.set` |
| Histórico | `chat.listSessions` + `run.get` |

**Regra:** um dado que o aplicativo não tem aparece como travessão ou estado
vazio, nunca como número inventado. Files, Tests e Context ficam em `—` até
existir medição, e o medidor de contexto do design só é renderizado quando
houver valor real.

## 5. Estados do run

O design fala 14 estados; o registro guarda 5. A diferença vem do estágio real
que o loop emite — `analysing`, `orchestrator`, `worker`, `evidence`,
`verification`, `review`, `blocked` — nunca de um palpite.

## 6. Logo

Não existe asset de logo em nenhuma branch nem em nenhum ponto do histórico.
A screenshot do app empacotado anterior (`docs/images/`) mostra a identidade que
ele tinha: o texto "AI Orchestrator", sem marca. Por decisão do usuário, a
identidade é o mark do protótipo (ícone `sparkles`).

## 7. Ganchos de teste

`data-testid="start"`, `"continue"` e `"skip-onboarding"` no onboarding. Não
têm classe e não mudam nada visível; existem porque o smoke test empacotado do
CI percorre a tela.

## 8. O que ainda não existe

1. Conteúdo dos diffs na interface (são arquivados; a UI não lê os bytes).
2. Medição de contexto — por isso o medidor fica oculto.
3. Pausar/retomar: só cancelar.
4. Login GitHub próprio; o remoto é lido do projeto.

## 9. Não renegociar

1. **A base é `903a60b`/`66f7a07`.** Não voltar a `5ca6062`.
2. **O design é o do protótipo.** Ajustar espaçamento, cor ou tipografia
   "porque parece melhor" é regressão.
3. **Nunca inventar um número na interface.**
4. **Todo canal novo entra primeiro no contrato**, com validador e teste.
