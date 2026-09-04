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

1. **Codex não tinha fonte de instalação funcionando — corrigido.** Medido:
   - `https://releases.openai.com/codex/latest` → **HTTP 404**
   - `https://releases.openai.com/codex` → **HTTP 404**
   - tarball npm `@openai/codex-win32-x64` → nenhum tarball para esta
     plataforma
   - `https://api.github.com/repos/openai/codex/releases/latest` → **HTTP 200**

   O endpoint `releases.openai.com/codex` foi **removido** da lista: um
   endpoint que comprovadamente 404 não tem por que gastar a primeira execução
   do usuário. No lugar entrou `CodexGitHubReleaseSource` — ver seção 5.1.

2. **Claude tem fonte funcionando:** `https://claude.ai/install.ps1` → HTTP 200,
   apontando para `https://downloads.claude.ai/claude-code-releases/bootstrap.ps1`.

3. **Cancelamento no Windows: era bug do probe, não do produto.** `taskkill /T`
   → **0 órfãos, nenhum sobrevivente, live count 0, outcome `cancelled`** em
   3138ms. O check de heartbeat lia o arquivo *antes* de cancelar e exigia que
   ele não mudasse depois — mas o neto continua batendo durante todo o período
   de graça, então o valor sempre diferia e um processo comprovadamente morto
   era reportado como vivo. Agora as duas leituras são feitas **depois** que o
   cancelamento assenta e comparadas entre si. TEST 4 passa com um veredito
   único e coerente.

4. **argv e stdin no Windows:** `.exe`, `.cmd` e `.bat` passam o round trip de
   argumentos; stdin através de `.cmd` passa; um prompt de **80757 bytes**
   chega byte a byte, direto e através do launcher `.cmd`.

5. **`testedVersion` do Git: não mexer ainda.** O Windows real reporta
   **2.55.0**, mas esse é o Git for Windows que o runner já tinha em
   `C:\Program Files\Git`, **não** o MinGit que o aplicativo gerencia. O
   relatório do spike agora imprime o caminho resolvido e a procedência, para
   que os dois nunca sejam confundidos. A versão testada continua `2.47.0` até
   uma instalação gerenciada de MinGit reportar a sua.

6. Codex e Claude **não estavam instalados** no runner, então TEST 1, 2, 3 e 7
   do spike não puderam rodar. Os adapters continuam **não exercitados contra
   os CLIs reais**.

### 5.1 Fonte do Codex: GitHub Releases

`src/runtime/sources/github-releases.ts` + `CodexGitHubReleaseSource`.

Os nomes dos assets **não são adivinhados**: vêm do próprio workflow de release
do `openai/codex`, que os nomeia por *target triple* de Rust e publica um
manifesto `codex-package_SHA256SUMS`.

| | |
|---|---|
| Repositório | `openai/codex` |
| Tag | `rust-v<versão>` |
| Asset preferido (Windows x64) | `codex-package-x86_64-pc-windows-msvc.tar.gz` |
| Alternativa | `codex-x86_64-pc-windows-msvc.exe.zip` |
| ARM64 | `aarch64-pc-windows-msvc` resolvido, fora de escopo por ora |
| Integridade | SHA-256 do manifesto da própria release |
| Contrato | `DOCUMENTED` |

Regras que viraram teste:

- **Correspondência por triple exato.** Há um teste com o asset ARM64 listado
  *antes* do x64: um matcher que pega "o primeiro que contém windows" entrega o
  binário errado.
- **Sem digest publicado, sem instalação.** Um binário de agente executa código
  arbitrário na máquina do usuário; "não deu para conferir, então seguimos" não
  é uma troca que este produto faz.
- **A política de versão continua no comando.** A versão testada é pedida pela
  própria tag; se essa release sumiu, a fonte recusa em vez de pegar `latest`.

**Prova real, do CI:**

```
CODEX: PASS
  source               codex-github-releases (Releases oficiais do openai/codex)
  contract             DOCUMENTED
  host                 release-assets.githubusercontent.com
  asset url            .../releases/download/rust-v0.153.0/
                       codex-package-x86_64-unknown-linux-musl.tar.gz
  version              0.153.0
  bytes                126134505
  sha256 (computed)    27b0d7a753ac190c343918541a42067be307cc88a32b1a9feaf6f93648a0e9ea
  integrity            SHA256 verificado -> trust VERIFIED
  health               PASS
  --version            codex-cli 0.153.0
  elapsed              5028 ms
```

`node scripts/probe-real-runtimes.mjs --runtime codex` roda o pipeline de
verdade contra os feeds de verdade, e o CI o executa como passo **obrigatório**
nas duas plataformas — **verde no Windows e no Linux**. Neste container ele cai
para a fonte npm (a API do GitHub é bloqueada aqui), que é o fallback
funcionando como projetado.

O `spike/windows-spike.mjs` TEST 8 também passou a usar o `CodexRuntime` real.
Antes ele mantinha a própria lista de fontes e só as *sondava*, então reportava
"No Codex source produced a working binary" enquanto o aplicativo instalava o
Codex sem problema. Um spike que contradiz o código que ele deveria informar é
pior do que spike nenhum.

### 5.2 Fonte do Claude Code: o que o instalador oficial faz

`claude.ai/install.sh` e `install.ps1` redirecionam para um bootstrap em
`https://downloads.claude.ai/claude-code-releases`. O passo de descoberta no CI
leu esse script; o contrato é:

```
<base>/stable                      -> versão em texto puro, ex. 2.1.236
<base>/<versão>/manifest.json      -> platforms["<chave>"] = { checksum, size }
<base>/<versão>/<chave>/claude[.exe]  -> o executável, recusado se o SHA-256 não bater
```

O resolver antigo apontava para `claude.ai/install-manifest.json`, que **não
existe** (403) — foi inventado, e por isso o Claude Code nunca instalou. Agora
segue exatamente esses passos, com o mesmo digest.

A chave de plataforma é a única coisa que o script POSIX não revela (ele monta
`linux-x64-musl` e afins; a grafia do Windows está no ramo PowerShell). Em vez
de adivinhar, o resolver oferece todas as chaves plausíveis e **o manifesto
decide** — uma chave que ele não declara simplesmente não é usada.

**Provado no Windows CI:** `Prove the Claude runtime installs for real` →
**PASS**, incluindo `claude --version` e `claude auth status --json`. Não é
preciso autenticar para provar isso.

### 5.3 Contas do Codex

Lido do binário real, não presumido:

| | |
|---|---|
| Isolamento | `CODEX_HOME` (paralelo exato do `CLAUDE_CONFIG_DIR`) |
| Estado | `codex login status` → "Not logged in" |
| Login GUI | `codex login --device-auth` (URL + código, ideal sem terminal) |
| Outros | `--with-api-key`, `--with-access-token` (ambos por stdin) |
| Credencial da conta | `auth.json` dentro do `CODEX_HOME` |

`CODEX_ACCESS_TOKEN` entrou na lista de variáveis sensíveis: herdada do
ambiente, satisfaria todas as contas ao mesmo tempo.

### 5.4 Capacidades reais do Codex 0.153.0

Lidas do binário, não presumidas:

| Onde | O que |
|---|---|
| `codex --help` | subcomando `exec` |
| `codex exec --help` | `--skip-git-repo-check`, `-s/--sandbox`, `--json`, `--output-schema`, `-o/--output-last-message`, `--cd`, `--model` |
| `codex exec [PROMPT]` | *"If not provided as an argument (or if `-` is used), instructions are read from stdin"* — confirma o prompt por stdin |

Isso revelou um **bug no adapter**: ele procurava `--skip-git-repo-check` em
`codex --help`, onde o flag não existe — os flags de um subcomando não aparecem
na página do pai. Agora lê `codex exec --help`.

Adotado: `--skip-git-repo-check`, `--sandbox read-only` (o orquestrador
supervisiona e nunca edita) e, agora, a saída estruturada:

- `--output-schema` recebe o JSON Schema da decisão (em
  `src/orchestrator/decision-schema.ts`, ao lado do parser que a valida — um
  teste garante que a lista de ações continua sendo exatamente
  `ALLOWED_ACTIONS`);
- `-o/--output-last-message` grava a resposta final em um arquivo, e é esse
  arquivo que o loop analisa.

`--json` continua **não** adotado: imprime *eventos* em JSONL, e o parser leria
o primeiro evento como a decisão.

Tudo defensivo: cada flag só entra se o build a declarar; se o arquivo de
resposta faltar ou vier vazio, o loop volta a analisar o stdout. Há teste com
um `{"action":"blocked"}` de isca no transcript para provar que o arquivo vence.

### 5.5 O que acontece sem credencial

Medido: sem autenticação o Codex **não falha rápido**. Ele imprime
`Reading prompt from stdin...` (o que, de quebra, prova que o prompt chega por
stdin como projetado) e espera até o timeout.

Por isso um run agora **verifica antes de começar**: os runtimes dos dois
agentes estão instalados? toda conta vinculada está conectada? Se não, o run
falha em cerca de um segundo com uma frase acionável e nenhum agente é
invocado. Sem isso, a interface mostraria "Codex preparando a tarefa..." por
quinze minutos.

> Para quem for escrever testes: passar `createRunners` significa passar os
> próprios agentes, o que **desliga** a verificação de prontidão.

---

## 6. Blockers abertos

1. **Nenhuma execução autenticada de modelo — este é o blocker número 1.**
   Os dois CLIs instalam, os dois adapters os invocam de verdade (argv, stdin,
   ambiente), mas nenhum runner de CI tem credencial. Então o loop de
   orquestração **nunca rodou com agentes reais de ponta a ponta**. Só uma
   máquina com contas conectadas responde isso, e é exatamente o que o
   instalador existe para permitir.
2. **`AI-Orchestrator-Setup.exe` foi construído mas ninguém o instalou.** O CI
   o produz, o smoke empacotado passa, e ele é publicado como **pre-release** na
   tag `desktop-dev` (o repositório é privado, então só quem já tem acesso
   enxerga). Falta baixar, instalar e usar.
3. **Login pela GUI nunca foi completado por uma pessoa.** O fluxo existe para
   os dois provedores e é dirigido pelo Main (captura de URL, abertura do
   navegador, polling), mas concluir um login exige um humano num navegador.
4. **`testedVersion` do Git continua um palpite** — nenhuma instalação
   gerenciada de MinGit foi observada ainda.
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
