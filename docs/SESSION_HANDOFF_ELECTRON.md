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
| Branch paralela | `claude/ai-orchestrator-continuation-sbzrfg` — ver seção 7 |
| Working tree | Limpo |
| Testes | **206 passando, 0 falhando** (`npm test`) |
| Testes Electron | **10 passando, 0 falhando** (`npm run desktop:test`) — verde também no Windows |
| Smoke empacotado | **7 passando, 0 falhando** (`npm run -w apps/desktop test:packaged`) — 9 com capturas |
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

### Capturas do build empacotado

`docs/images/onboarding-packaged.png` e
`docs/images/onboarding-packaged-workbench.png` saíram do executável
empacotado, não de um servidor de desenvolvimento. Para regerar:

```bash
npm run -w apps/desktop package:linux
AI_ORCHESTRATOR_SMOKE_SCREENSHOT=docs/images/onboarding-packaged.png \
  npm run -w apps/desktop test:packaged
```

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
npm test                              # 206 testes
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

## 5. O que o Windows real respondeu

Primeira execução do CI em `windows-latest` (run `33832605345`, commit
`469d96f`). Windows 10.0.26100, Node 22.23.2, **git 2.55.0.windows.5**.

**Verde:** install, typecheck, **206 testes**, build, **10 testes Electron**,
**empacotamento NSIS**, e o **smoke do app empacotado**. Ou seja:
`AI-Orchestrator-Setup.exe` **foi produzido**, e o executável empacotado abre,
o `node:sqlite` funciona nele, o IPC responde e o onboarding renderiza — no
Windows.

O upload do instalador falhou por **cota de artifacts da conta esgotada**
("Artifact storage quota has been hit"), não por problema de build. O log
confirma o arquivo no caminho esperado antes de tentar enviar.

**Achados que mudam o plano:**

1. **Codex não tem fonte de instalação funcionando.** Medido, não suposto:
   - `https://releases.openai.com/codex/latest` → **HTTP 404**
   - `https://releases.openai.com/codex` → **HTTP 404**
   - tarball npm `@openai/codex-win32-x64` → nenhum tarball para esta
     plataforma
   - `https://api.github.com/repos/openai/codex/releases/latest` → **HTTP 200**
     (alcançável, mas o `CodexRuntime` ainda não usa essa fonte)

   Conclusão do spike: *"No Codex source produced a working binary."* O
   requisito de configuração zero **não é atendido para o Codex hoje**. É o
   blocker número 1.

2. **Claude tem fonte funcionando:** `https://claude.ai/install.ps1` → HTTP 200,
   apontando para `https://downloads.claude.ai/claude-code-releases/bootstrap.ps1`.

3. **Cancelamento no Windows:** `taskkill /T` → **0 órfãos, nenhum sobrevivente,
   live count 0, outcome `cancelled`** em 3138ms. O spike ainda marca FAIL
   porque o seu próprio check de heartbeat do neto não confirmou a parada
   (`Grandchild heartbeat stopped: false`). Ou seja: **sem órfãos, mas ainda
   não totalmente provado**.

4. **argv e stdin no Windows:** `.exe`, `.cmd` e `.bat` passam o round trip de
   argumentos; stdin através de `.cmd` passa; um prompt de **80757 bytes**
   chega byte a byte, direto e através do launcher `.cmd`.

5. **`testedVersion` do Git está desatualizado:** o Windows real traz
   **2.55.0**, e a política testa `2.47.0`.

6. Codex e Claude **não estavam instalados** no runner, então TEST 1, 2, 3 e 7
   do spike não puderam rodar. Os adapters continuam **não exercitados contra
   os CLIs reais**.

---

## 6. Blockers abertos

1. **Codex não pode ser instalado pelo aplicativo.** Ver seção 5, item 1. Sem
   isso, a primeira execução não consegue preparar o orquestrador sozinha. O
   caminho óbvio é acrescentar uma fonte baseada nas releases do GitHub, que
   respondeu 200 — mas isso exige escolher o nome do asset e a estratégia de
   integridade, e validar no Windows.
2. **`AI-Orchestrator-Setup.exe` foi construído mas ninguém o instalou.** O CI
   o produz e o smoke empacotado passa; falta baixar, instalar e usar. O upload
   depende da cota de artifacts da conta, hoje esgotada.
3. **Adapters nunca rodaram contra os CLIs reais.** Nenhum runner tinha Codex ou
   Claude instalado.
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

## 7. A outra branch: `claude/ai-orchestrator-continuation-sbzrfg`

Existe no remoto uma segunda branch, `claude/ai-orchestrator-continuation-sbzrfg`
(HEAD `1e8a4d6`), com uma **fundação Electron paralela**, escrita por outra
sessão a partir do mesmo commit base (`5ca6062`). As duas não se conhecem.

O que ela tem e esta não:

- prova de **instalação real de runtime pela GUI** (Codex vindo do registry npm,
  com progresso chegando ao renderer) e de um **login Claude real iniciado e
  cancelado** pela interface;
- capturas de tela do executável empacotado (`docs/images/`);
- remoção do resíduo CLI (`src/config/config.ts` e seu teste), que aqui ainda
  existe;
- renderer com Vite; `react`/`react-dom` em devDependencies.

O que esta tem e ela não:

- workspaces, chat, runs e o **loop de orquestração completo**, com adapters de
  Codex e Claude, loop corretivo e cancelamento;
- Windows CI cobrindo até o instalador NSIS;
- smoke do build **empacotado** rodando dentro do próprio executável.

Em escopo, esta branch é um superconjunto. As partes que se sobrepõem
(main, preload, IPC, validação, onboarding, instalação, login) foram escritas
duas vezes, de forma independente.

**Decisão pendente do dono do repositório:** ficar com esta e portar as provas
reais e as capturas de `sbzrfg`, ou o contrário. Nada foi mesclado nem
descartado — as duas branches continuam intactas no remoto.

---

## 8. Próxima fase sugerida

1. **Dar ao Codex uma fonte que funcione.** É o que separa o produto do
   requisito de configuração zero. As releases do GitHub respondem 200; falta
   decidir o asset e a integridade, e provar no Windows.
2. Liberar cota de artifacts na conta (ou publicar via release) e **baixar o
   `AI-Orchestrator-Setup.exe`**.
3. Instalar em Windows real e percorrer o fluxo inteiro: configurar runtimes,
   conectar conta, adicionar projeto, enviar tarefa. É o que valida os adapters
   contra os CLIs reais.
4. Ajustar `testedVersion` do Git para o que o MinGit realmente entregar
   (o Windows real já mostra 2.55.0).
5. Fechar o cancelamento no Windows: 0 órfãos já está medido, falta o check de
   heartbeat do spike concordar.
6. Só então: Agents completo, Runs completo, diff viewer, Gemini, design final.
