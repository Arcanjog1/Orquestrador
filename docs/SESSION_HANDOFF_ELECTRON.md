# Session handoff — fundação Electron **concluída**

Documento vivo. Descreve o estado **real** do repositório para que uma próxima
sessão continue sem depender da conversa anterior.

Atualizado em 2026-09-04.

> Se algo aqui contradisser o código, **o código é a verdade**. Atualize o
> documento.

---

## 1. Estado atual

| | |
|---|---|
| Repositório | `Arcanjog1/Orquestrador` |
| Branch | `claude/ai-orchestrator-continuation-grblen` |
| Working tree | Limpo |
| Testes | **205 passando, 0 falhando** (`npm test`) |
| Testes Electron | **10 passando, 0 falhando** (`npm run desktop:test`) |
| Smoke empacotado | **7 passando, 0 falhando** (`npm run -w apps/desktop test:packaged`) |
| Typecheck | `npm run typecheck` → limpo (core + desktop main + renderer) |
| Electron | **44.1.1** (fixado, sem `^`) |
| Node embutido | **24.19.0** |
| Chromium | **152.0.7977.65** |
| SQLite embutido | 3.53.3, via `node:sqlite` |

**Ambiente de desenvolvimento:** container Linux, sem Windows. `xvfb` disponível,
o que permite abrir janelas Electron reais nos testes. `wine64` existe mas sem
loader 32 bits, então o instalador NSIS não pode ser gerado aqui — só o payload
`win-unpacked`.

---

## 2. O que está pronto

### Núcleo (sessões anteriores, inalterado)
RuntimeManager, ManagedRuntime, CodexRuntime, ClaudeCodeRuntime, GitRuntime /
MinGit, RuntimeSource com níveis de contrato, política de versões, integridade e
trust, instalação atômica com rollback `current`/`previous`, ClaudeAccountManager,
ProcessManager, git-safety, git-evidence, done-gate, verifier, decision-parser.

**Não reescrever nada disso.** Consumir.

### Banco (`src/database/`)
`SqlDriver` continua sendo a costura. Além de `runtime_installations` e
`settings`, agora existem repositórios para providers, accounts, agents,
workspaces (+ `workspace_agents`), chat sessions, messages, runs, run steps,
agent invocations, verification results e verification definitions.

Migration 2 adiciona `workspaces.updated_at`.

`VerificationDefinitionRepository.resolve()` é o que mantém a regra 10 honesta:
o orquestrador pede uma verificação **por id**; um id que ninguém cadastrou volta
em `unknown` e **nunca** é executado.

### Aplicativo desktop (`apps/desktop/`)

```
src/shared/      contrato de IPC + validação em runtime
src/preload/     bridge.ts (fábrica pura) + preload.ts (entrada, CJS)
src/electron/    main.ts, security.ts, smoke.ts
src/main/        core.ts (única porta para o núcleo), events, ipc-router,
                 services/ e adapters/
src/renderer/    React: App, Onboarding, Workbench
scripts/         build-renderer (esbuild), run-electron-tests, packaged-smoke
tests/           electron-integration.mjs (roda dentro do Electron real)
```

Arquitetura:

```
React Renderer → Typed IPC → Electron Main → Services
                                              → RuntimeManager
                                              → Database
                                              → ProcessManager
```

Nenhum serviço importa Electron. `openUrl`, o seletor de pasta e os agent
runners entram por injeção — é por isso que o mesmo grafo roda sob `node --test`
com agentes falsos.

### Segurança (verificada em janela viva, não só em constante)

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
`webSecurity: true`, mais `nodeIntegrationInWorker/InSubFrames: false`,
`webviewTag: false`, CSP sem script/estilo/fonte/conexão remota, navegação e
`window.open` recusados, permissões (câmera, microfone, localização) negadas.

O teste `apps/desktop/tests/electron-integration.mjs` abre uma janela real e
confirma que no renderer `window.require`, `window.process`, `window.module`,
`window.ipcRenderer` e `window.electron` são todos `undefined`.

**Não existe IPC genérico.** O preload monta sua superfície percorrendo a lista
de canais, então cada função exposta tem o canal fixado na construção: nada que
o renderer passe é usado como nome de canal. Não há `exec`, `shell`,
`runCommand` nem `invoke` genérico — e há teste provando isso nos três lados
(contrato, preload, router).

Toda entrada é revalidada no Main em runtime: propriedades desconhecidas são
**recusadas** (não removidas), `__proto__`/`constructor`/`prototype` são
recusados, e toda string tem tamanho máximo.

### Onboarding, instalação e login pela GUI
A tela inicial consome `RuntimeManager.diagnose()` — o React não decide nada
sobre prontidão. A instalação vai por IPC até `RuntimeManager.install`, com
progresso (`Baixando`, `Verificando`, `Instalando`, `Testando`, `Concluído`)
voltando por evento. O login Claude usa `ClaudeAccountManager.connect` com
`openUrl` ligado a `shell.openExternal`; o usuário nunca vê `CLAUDE_CONFIG_DIR`.

### Loop de orquestração (`orchestration-service.ts`)

```
USER MESSAGE → RUN → BASELINE → CODEX → DECISION → CLAUDE CODE
  → EVIDENCE → VERIFICATION → CODEX REVIEW → DONE ou nova delegação
```

Três regras são impostas pelo programa, não confiadas ao agente:

1. verificação **por id**, resolvida contra `verification_definitions`;
2. `done` é um pedido — `evaluateDone` reexecuta tudo contra evidência fresca e
   a rejeição volta ao orquestrador verbatim;
3. a evidência é coletada do git pelo programa.

Cancelar aborta o sinal **e** chama `cancel()` nos runners, que é o que mata a
árvore de processos.

### Adapters
`CodexAdapter` e `ClaudeCodeAdapter`: executável vindo do `RuntimeManager`
(nunca do PATH), prompt por **stdin**, e o modo não interativo é **detectado**
lendo `--help` do binário — `codex exec`, `claude --print`, e
`--permission-mode acceptEdits` só quando o build o anuncia. Um build sem modo
não interativo é recusado com mensagem, nunca lançado na TUI.

---

## 3. Decisões inegociáveis

Inalteradas desde a sessão anterior. Aplicativo desktop Windows; o usuário nunca
abre terminal nem instala Node/npm; runtimes gerenciados em `%LOCALAPPDATA%` sem
UAC; adapters nunca dependem do PATH; múltiplas contas Claude isoladas por
`CLAUDE_CONFIG_DIR` gerenciado pelo app; renderer sem acesso direto a Node, CLI
ou SQLite; toda operação privilegiada por IPC tipado; nenhum comando arbitrário
de LLM é executado; DONE exige validação independente; Claude Code nunca é
redistribuído; segurança git preservada.

---

## 4. Comandos

```bash
npm install
npm run typecheck                     # core + desktop main + renderer
npm test                              # 205 testes
npm run desktop:build                 # tsc (main) + esbuild (preload/renderer)
npm run desktop                       # abre o aplicativo
npm run desktop:test                  # testes dentro do Electron real
npm run -w apps/desktop package:linux  # payload Linux (para smoke local)
npm run -w apps/desktop package         # NSIS → AI-Orchestrator-Setup.exe (Windows)
npm run -w apps/desktop test:packaged   # smoke do build empacotado
```

Em Linux sem `DISPLAY`, os scripts usam `xvfb-run` automaticamente.

Se `node_modules/electron/dist` não existir (npm com scripts desabilitados):
`node node_modules/electron/install.js`.

---

## 5. Blockers abertos

1. **`AI-Orchestrator-Setup.exe` não foi validado em Windows real.** O
   `win-unpacked` é gerado aqui; o wrapper NSIS precisa de Windows (ou wine com
   loader 32 bits, que este container não tem). O workflow de CI monta e publica
   o instalador como artifact — falta alguém instalar e usar.
2. **Windows CI ainda não rodou.** `.github/workflows/ci.yml` existe e cobre
   install → typecheck → testes → build → testes Electron → NSIS → smoke
   empacotado → artifact, mas ninguém o executou ainda.
3. **Fontes reais de Codex/Claude/MinGit no Windows — não verificadas.** Os
   resolvers só viram respostas simuladas. O passo "Probe the real runtime
   sources" no CI existe para começar a responder isso.
4. **Authenticode publishers — desconhecidos.** Nenhum `expectedPublisher`
   configurado, de propósito. O CI registra o subject observado.
5. **Duas contas Claude reais simultâneas — não comprovado.** O isolamento de
   diretório está testado; faltam dois logins reais ao mesmo tempo.
6. **Cancelamento sem órfãos no Windows — não comprovado.** O caminho
   `taskkill /T /F` tem teste de argv, não de execução.
7. **`testedVersion` do Git (`2.47.0`) ainda é um palpite.**
8. **Codex e Claude reais nunca foram executados por estes adapters.** A
   detecção de capabilities é testada contra `--help` simulado; a primeira
   execução no Windows é o que valida.
9. **`.claude.json` continua no histórico do Git.** Removido do HEAD; a
   reescrita depende de autorização — ver `docs/SECURITY_HISTORY_CLEANUP.md`.
10. **`npm audit`**: 11 high + 1 critical, todas em dependências transitivas de
    build do `electron-builder` (`tar`, `node-gyp`). Nenhuma vai para o
    aplicativo empacotado.
11. **Sem ícone e sem assinatura de código.** O Windows mostrará SmartScreen.

---

## 6. Próxima fase sugerida

1. Rodar o Windows CI e baixar o `AI-Orchestrator-Setup.exe`.
2. Instalar em Windows real e percorrer o fluxo inteiro: configurar runtimes,
   conectar conta, adicionar projeto, enviar tarefa.
3. Corrigir o que a realidade contradisser (fontes, flags, versões).
4. Só então: Agents completo, Runs completo, diff viewer, Gemini, design final.
