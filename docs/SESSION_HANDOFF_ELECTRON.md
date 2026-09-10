# Session handoff — fundação Electron

Este documento existe para que uma **nova sessão** continue o projeto sem depender
da conversa anterior. Ele descreve o estado real do repositório, o que já está
pronto, o que não pode ser renegociado e exatamente o que fazer a seguir.

Escrito em 2026-09-03.

---

## 1. Estado atual

| | |
|---|---|
| Repositório | `Arcanjog1/Orquestrador` |
| Branch | `claude/new-session-3am7mo` |
| HEAD | `f09259085727e642b12e56342fe7dff1f7a53de9` (`f092590`) |
| Mensagem do HEAD | *Database layer: swappable driver, schema and runtime_installations* |
| Working tree | **Limpo.** Nenhum arquivo não commitado |
| Sincronia | `HEAD == origin/claude/new-session-3am7mo` (tudo enviado) |
| Testes | **175 passando, 0 falhando, 0 pulados** |
| Typecheck | `tsc -p tsconfig.test.json --noEmit` → limpo |
| Build | `tsc -p tsconfig.json` → limpo |
| Node usado no desenvolvimento | v22.22.2 / npm 10.9.7 |
| Dependências de runtime | **nenhuma** |
| devDependencies | `typescript ^5.7.0`, `@types/node ^22.10.0` |

Histórico (mais recente primeiro):

```
f092590  Database layer: swappable driver, schema and runtime_installations
42545f6  Runtime version policy, trust policy, rollback and MinGit
7bf0934  Claude accounts managed by the app, with CLAUDE_CONFIG_DIR hidden
d04808f  RuntimeManager: the application installs its own runtimes
e5793df  Spike: add TEST 7 (terminal-free auth) and TEST 8 (runtime acquisition)
35f1d25  Add the Windows integration spike
772d878  Preserve in-progress agent abstraction and decision parser
e4f3c2d  Phase 3: git evidence, safety screen, verifier, DONE gate, sessions, report
c7e971b  Phase 2: ProcessManager and preflight checks
c252d29  Phase 1: scaffold, core types, state machine, config, logger, redactor
```

**Ambiente de desenvolvimento:** container Linux. Não há Windows nem `codex`
instalado. O `claude` CLI existe (v2.1.252). A rede é restrita: só
`registry.npmjs.org` é alcançável; `releases.openai.com`, `claude.ai`,
`downloads.claude.ai` e `github.com` respondem 403. Isso limita o que pode ser
verificado aqui e está refletido na seção 6.

---

## 2. O que já está implementado

Tudo abaixo está commitado, com testes.

### RuntimeManager (`src/runtime/`)
Fachada que responde “está tudo pronto e, se não, eu consigo resolver sozinho?”.
`diagnose()` devolve o checklist completo que a tela de primeira execução
renderiza. `prepareAll()` acumula falhas em vez de parar na primeira.

### ManagedRuntime — pipeline de instalação
`resolve → download → verificar integridade → extrair → health check em staging
→ capability check → promover → health check`. Só um build que já se provou em
staging substitui o que funciona. Layout `current/` + `previous/`.

### CodexRuntime
Origens em ordem: canal oficial de release → tarball do registry npm
(`PACKAGE_INTERNAL`). O build Windows é nativo — **não precisa de Node**.
Layout real do pacote: `package/vendor/x86_64-pc-windows-msvc/bin/codex.exe`,
com `codex-resources/` e `codex-path/` ao lado (por isso a árvore inteira é
promovida, nunca só o `bin/`).

### ClaudeCodeRuntime
Origens: instalador oficial documentado → host de release observado dentro do
binário, marcado `NOT_PUBLIC_CONTRACT` e **sempre em último**. Binário nativo,
também dispensa Node. **Nunca redistribuído** dentro do nosso instalador (licença
npm: `SEE LICENSE IN README.md`, não permissiva).

### GitRuntime / MinGit
`MinGitReleaseSource` lê o feed de releases do Git for Windows e escolhe
`MinGit-<v>-64-bit.zip` — não o instalador completo, não o busybox (fallback).
Recusa fora do Windows. Arquivos `LICENSE`/`COPYING`/`NOTICE` são localizados e
gravados no manifesto (GPL-2.0). Ver `THIRD-PARTY-NOTICES.md`.

### AccountManager (`src/accounts/`)
Contas Claude isoladas. O usuário digita “Claude Trabalho”; o app cria e gerencia
o diretório. Três garantias testadas:
- variáveis de credencial do ambiente são **deletadas** do processo filho;
- conta logada sem `.credentials.json` próprio vira `ambient-credential`,
  **nunca** `connected`;
- remoção recusa qualquer caminho fora da pasta de perfis.

Login dirigido por GUI: stdio em pipe, captura a URL, entrega para o app abrir o
navegador, detecta conclusão por polling de `auth status --json`.

### RuntimeSource — contrato e confiança
Cada origem declara `contract` (`DOCUMENTED` / `PACKAGE_INTERNAL` /
`NOT_PUBLIC_CONTRACT`) e `integrityStrategy`. `orderedSources()` ordena por
contrato e depois por confiança; uma origem `NOT_PUBLIC_CONTRACT` **nunca** fica
à frente de uma documentada, seja qual for a ordem declarada.

### Política de compatibilidade (`compatibility.ts`, `version.ts`)
Distingue **AVAILABLE / TESTED / INSTALLED / COMPATIBLE**. Primeira instalação
pede a versão testada, nunca `latest`. Nenhum runtime pode usar política
`latest` (há teste impedindo).

Versões testadas hoje: codex `0.153.0` (min `0.150.0`), claude-code `2.1.252`
(min `2.0.0`), git `2.47.0` (min `2.30.0`).

> **Detalhe que virou código:** `0.153.0-win32-x64` em semver estrito é
> *prerelease* e ordenaria **antes** de `0.153.0`. O parser reconhece e remove o
> sufixo de plataforma.

### Integridade / trust (`integrity.ts`)
`checksum = null` significa `UNVERIFIED_BINARY_SOURCE`, não “pode instalar”.
Estratégias: `NPM_INTEGRITY`, `SHA256`, `SIGNED_MANIFEST`, `AUTHENTICODE`,
`HTTPS_ONLY_LAST_RESORT`. Authenticode é lido via PowerShell; o publisher é
**observado e registrado**, nunca um nome inventado — só há recusa se uma
expectativa tiver sido explicitamente configurada.

### Disponibilidade de modelo (`src/models/`)
Três estados distintos, e nunca um alerta para o do meio:
`CONFIRMED_FOR_ACCOUNT`, `KNOWN_BUT_UNVERIFIED` (“Disponível no catálogo — ainda
não verificado nesta conta”, tom neutro, modelo continua usável) e `UNAVAILABLE`
— este último **só** a partir de evidência. Verificação é por `accountId`, com o
`CLAUDE_CONFIG_DIR` daquela conta; o que vale para a conta A não vale para a B.
Se o CLI não expõe modelos/entitlement, isso é dito com todas as letras e nada é
marcado como indisponível. A chamada mínima de verificação consome uso e só roda
com autorização explícita. Modelo FIXED, tetos e a proibição de fallback
silencioso continuam valendo (`model-policy.ts`). Detalhes em
`docs/MODEL_AVAILABILITY.md`.

### Rollback current/previous
Falha no capability check → o install em uso não é tocado. Falha no health check
depois de promovido → reverte sozinho. `rollBack()` restaura sob demanda.

### SqlDriver / node:sqlite / schema (`src/database/`)
`SqlDriver` é a costura: repositórios, orchestrator-core, agents, workspaces e UI
não veem SQL nem binding. `node:sqlite` é embutido no Node 22 — **sem módulo
nativo, sem `electron-rebuild`, sem prebuild por arquitetura**. Verificado aqui
com prepared statements e WAL.

15 tabelas, migrations ordenadas e idempotentes. Só metadados nas tabelas; diffs
e stdout ficam em disco com linha apontando.

### Testes relevantes
```
runtime-install.test.ts   instalação atômica, download corrompido, fallback entre origens
runtime-policy.test.ts    versões, compatibilidade, integridade, ordenação, rollback, licenças
runtime-manager.test.ts   diagnose, prepareAll, MinGit, mensagens sem "PATH"
claude-accounts.test.ts   isolamento, env limpo, credencial ambiente, traversal
model-availability.test.ts  três estados, verificação por conta, teto, fallback explícito
database.test.ts          migrations, FKs, transações, provenance, rollback registrado
process-manager.test.ts   argv Windows, .cmd, timeout, cancelamento, órfãos
done-gate.test.ts         DONE nunca aceito sem evidência
git-safety.test.ts        comandos destrutivos recusados
```

---

## 3. Decisões arquiteturais inegociáveis

Não renegociar nenhuma destas sem instrução explícita do usuário.

1. **Aplicativo desktop Windows.** O entregável é `AI-Orchestrator-Setup.exe`.
2. **O usuário final não usa PowerShell.** Nem CMD. Se algum fluxo normal exigir
   terminal, o requisito não foi atendido.
3. **O usuário final não instala Node nem npm.** Os dois agentes são binários
   nativos; o Electron traz o próprio Node. O app não precisa de Node externo.
4. **Runtimes gerenciados pelo app**, em `%LOCALAPPDATA%\AI-Orchestrator\`.
   Instalação por usuário, **sem UAC**.
5. **Adapters nunca dependem do PATH como fluxo principal.** Sempre
   `RuntimeManager.getExecutablePath()` → caminho absoluto. Nunca
   `spawn("codex")`, `spawn("claude")`, `spawn("git")`.
6. **Múltiplas contas Claude isoladas** por `CLAUDE_CONFIG_DIR`, que o app
   gerencia e o usuário nunca vê.
7. **Renderer sem acesso direto a Node, CLI ou SQLite.** `contextIsolation=true`,
   `nodeIntegration=false`.
8. **Main Process controla runtimes, processos e banco.** Toda operação
   privilegiada passa por IPC tipado.
9. **GitHub não é intermediador de mensagens.** O AI Orchestrator local é o
   intermediador.
10. **Nenhum comando arbitrário de LLM é executado como verificação.** O
    orquestrador pede uma verificação **por id**, resolvida contra
    `verification_definitions`, que o dono do workspace cadastrou.
11. **DONE exige validação independente.** O agente dizer “pronto” não encerra
    nada. Ver `src/orchestrator/done-gate.ts`.
12. **Nunca redistribuir o Claude Code** dentro do instalador sem autorização
    expressa da Anthropic.
13. **Segurança git preservada:** sem `reset --hard`, `clean -fd`,
    `push --force`, `checkout -- .`, `restore .`, `branch -D`. Sem commit, push
    ou merge automático.

---

## 4. Estrutura atual do repositório

```
src/
  runtime/            RuntimeManager e tudo que instala runtimes
    types.ts            RuntimeId, RuntimeSource, RuntimeManifest, erros
    paths.ts            layout de %LOCALAPPDATA%\AI-Orchestrator\
    managed-runtime.ts  pipeline de instalação, rollback, detecção
    runtime-manager.ts  fachada + diagnose() + prepareAll()
    runtimes.ts         CodexRuntime, ClaudeCodeRuntime, GitRuntime
    compatibility.ts    política de versões (RUNTIME_COMPATIBILITY)
    version.ts          comparação de versões
    integrity.ts        estratégias, trust level, Authenticode
    downloader.ts       download com progresso + verificação
    archive.ts          extração (tar do SO), busca de executável
    sources/            codex-sources, claude-sources, git-sources, npm-registry
  accounts/           account-types, claude-account-manager
  models/             model-types, model-catalog, model-availability,
                      account-model-verifier, verification-store, model-policy
  database/           driver, node-sqlite-driver, schema, database
  process/            process-manager      (crítico para Windows)
  git/                git-safety, git-evidence-collector
  orchestrator/       decision-parser, done-gate, verifier, acceptance-criteria
  sessions/           session-manager, state-manager, final-report
  security/           secret-redactor
  logger/  core/  preflight/  agents/  config/
tests/                15 arquivos, 175 testes
  helpers/            git-fixture, fake-runtime-source
spike/                windows-spike.mjs   (ferramenta INTERNA de desenvolvimento)
docs/                 este arquivo
SPIKE.md              instruções do spike (NÃO é a experiência do produto)
THIRD-PARTY-NOTICES.md
tsconfig.json  tsconfig.base.json  tsconfig.test.json  package.json
```

---

## 5. Contratos importantes

Assinaturas, não implementações. Ler o arquivo quando precisar do corpo.

```ts
// src/runtime/types.ts
type RuntimeId = 'codex' | 'claude-code' | 'git';
type ContractLevel = 'DOCUMENTED' | 'PACKAGE_INTERNAL' | 'NOT_PUBLIC_CONTRACT';
type RuntimeOrigin = 'managed' | 'system' | 'missing';

interface RuntimeSource {
  readonly id: string;
  readonly label: string;
  readonly contract: ContractLevel;
  readonly integrityStrategy: IntegrityStrategy;
  readonly expectedPublisher?: string;
  resolve(target: RuntimeTarget, request: VersionRequest): Promise<ResolvedDownload | null>;
}

interface RuntimeManifest {
  runtimeId; version; sourceId; sourceLabel; contract;
  url; host; platform; arch; bytes; sha256;
  integrity: IntegrityVerdict; trustLevel: TrustLevel;
  executableRelativePath: string;   // relativo a current/
  installedAt: string;
  previousVersion?: string;
  licenseFiles?: string[];
}

class RuntimeNotReadyError extends RuntimeError {
  userMessage: string;   // "Codex ainda não está configurado."
  remedy: string;        // "Configurar automaticamente"
}
```

```ts
// src/runtime/managed-runtime.ts
abstract class ManagedRuntime {
  abstract readonly id: RuntimeId;
  abstract readonly displayName: string;
  abstract readonly sources: readonly RuntimeSource[];

  get installDir(): string;      // runtimes/<id>
  get currentDir(): string;      // runtimes/<id>/current
  get previousDir(): string;     // runtimes/<id>/previous
  get canRollBack(): boolean;
  get compatibility(): RuntimeCompatibility;

  detect(): Promise<RuntimeDetection>;
  getExecutablePath(): Promise<string>;          // lança RuntimeNotReadyError
  healthCheck(): Promise<HealthStatus>;
  capabilityCheck(exe: string): Promise<{ ok: boolean; detail: string }>;
  install(onProgress?: ProgressReporter): Promise<InstallResult>;
  update(onProgress?: ProgressReporter): Promise<InstallResult | null>;
  repair(onProgress?: ProgressReporter): Promise<InstallResult>;
  rollBack(): Promise<InstallResult | null>;
  findAvailableVersion(): Promise<{ version: string; sourceId: string } | null>;
  orderedSources(): RuntimeSource[];
}
```

```ts
// src/runtime/runtime-manager.ts
interface RuntimeStatus {
  runtimeId; displayName;
  detection: RuntimeDetection;
  health: HealthStatus;
  canAutoConfigure: boolean;
}
interface DiagnosticReport {
  ready: boolean;
  runtimes: RuntimeStatus[];
  pending: RuntimeId[];
  checkedAt: string;
}

class RuntimeManager {
  constructor(options?: ManagedRuntimeOptions);
  readonly paths: AppPaths;
  get(runtimeId): ManagedRuntime;
  list(): ManagedRuntime[];
  getExecutablePath(runtimeId): Promise<string>;
  detect(runtimeId): Promise<RuntimeDetection>;
  healthCheck(runtimeId): Promise<HealthStatus>;
  diagnose(): Promise<DiagnosticReport>;              // ← a tela de onboarding
  install(runtimeId, onProgress?): Promise<InstallResult>;
  repair(runtimeId, onProgress?): Promise<InstallResult>;
  update(runtimeId, onProgress?): Promise<InstallResult | null>;
  prepareAll(onProgress?): Promise<{ ready; installed; failures }>;
}

interface InstallProgress {
  runtimeId; phase: InstallPhase; message: string; percent?: number;
}
type InstallPhase = 'resolving' | 'downloading' | 'verifying' | 'extracting'
  | 'staging-health-check' | 'installing' | 'health-check' | 'rolled-back' | 'done';
```

```ts
// src/accounts/claude-account-manager.ts
type AuthState = 'connected' | 'disconnected' | 'ambient-credential' | 'runtime-missing';

class ClaudeAccountManager {
  constructor(options: { runtimeManager; paths?; processManager? });
  profileDirectory(accountId): string;               // sempre absoluto
  createAccount(account: Account): Account;
  removeAccount(accountId): void;
  listProfileDirectories(): string[];
  buildEnvironment(accountId): Record<string, string | undefined>;
  hasOwnCredentials(accountId): boolean;             // só existência
  getStatus(account): Promise<AccountStatus>;
  verifyProfileInUse(account): Promise<boolean>;
  connect(account, options?: {
    onProgress?: (p: LoginProgress) => void;
    openUrl?: (url: string) => void | Promise<void>; // o app abre o navegador
    signal?: AbortSignal;
  }): Promise<AccountStatus>;
}
```

```ts
// src/database/driver.ts
interface SqlDriver {
  exec(sql: string): void;
  run(sql, params?): { changes: number; lastInsertRowid: number | bigint };
  all<T>(sql, params?): T[];
  get<T>(sql, params?): T | undefined;
  transaction<T>(fn: () => T): T;
  close(): void;
}
function nodeSqliteAvailable(): boolean;

// src/database/database.ts
class Database {
  constructor(options?: { paths?; driver?; filePath? });
  readonly driver: SqlDriver;
  get schemaVersion(): number;
  transaction<T>(fn: () => T): T;
  readonly runtimeInstallations: RuntimeInstallationRepository;
  readonly settings: SettingsRepository;
  close(): void;
}
```

Entidades do banco (15): `providers`, `accounts`, `agents`, `workspaces`,
`workspace_agents`, `chat_sessions`, `messages`, `runs`, `run_steps`,
`agent_invocations`, `artifacts`, `verification_definitions`,
`verification_results`, `runtime_installations`, `settings`.

```ts
// src/process/process-manager.ts   — não reescrever, já resolve o Windows
class ProcessManager {
  run(options: {
    command; args?; cwd; env?; stdin?;      // prompt SEMPRE por stdin
    timeoutMs?; graceMs?; maxOutputBytes?;
    signal?; onStdout?; onStderr?; stdio?: 'pipe' | 'inherit';
  }): Promise<ProcessResult>;
  cancelAll(graceMs?): Promise<void>;
  get liveCount(): number;
}
function buildSpawnPlan(command, args, platform?, comSpec?): SpawnPlan;
```
Regras: `shell: false` sempre; `.cmd`/`.bat` embrulhados em `cmd.exe /d /s /c`;
árvore morta com `taskkill /T /F` no Windows e process group no POSIX.

```ts
// src/orchestrator/
function parseDecision(raw: string): ParseResult;    // JSON validado + reparo de formato
function evaluateDone(input: DoneGateInput): Promise<DoneGateResult>;
function formatDoneRejection(result): string;        // "DONE_REJECTED\n..."
class Verifier { runAll(commands): Promise<CommandResult[]>; }
class AcceptanceCriteriaLedger { add/mark/pending/satisfied }
```

---

## 6. Limitações e blockers abertos

1. **Origens reais no Windows — não verificadas.** Os resolvers de
   `releases.openai.com`, do instalador da Anthropic e do feed do Git for Windows
   estão testados contra respostas simuladas. Nunca foram exercitados contra os
   serviços reais, porque este ambiente os bloqueia. **A primeira execução do app
   no Windows é o que valida isso.** Um resolver que não entende a resposta
   *recusa* em vez de chutar URL, então a falha será clara.
2. **Authenticode publishers — desconhecidos.** A leitura está implementada, mas
   nenhum `expectedPublisher` está configurado, de propósito. Descobrir os
   valores reais exige rodar no Windows. Até lá o app registra o subject
   observado e não recusa por publisher.
3. **`testedVersion` do Git é um palpite fundamentado** (`2.47.0`). Ajustar para
   o que o MinGit realmente entregar assim que houver uma execução real.
4. **Duas contas Claude reais — não comprovado.** O mecanismo
   (`CLAUDE_CONFIG_DIR`) está verificado contra o binário v2.1.252, e a detecção
   de credencial ambiente está testada. Faltou o cenário real: dois logins
   simultâneos permanecendo isolados. É o cenário C do MVP.
5. **Cancelamento sem órfãos — provado só em Linux.** O teste de heartbeat passa
   aqui. O caminho Windows (`taskkill /T /F`) está coberto por testes de argv,
   não de execução. Precisa de verificação real.
6. **`node:sqlite` dentro do Electron empacotado — a verificar.** Funciona no
   Node 22 puro. Depende de qual Node o Electron embute e de a API experimental
   estar exposta. **Isto é a primeira coisa a testar na próxima fase.** Se
   falhar, trocar apenas `node-sqlite-driver.ts` — a interface `SqlDriver`
   existe exatamente para isso.
7. **SmartScreen.** Sem certificado de code signing, o Windows exibirá “O Windows
   protegeu o seu PC”. Decisão consciente do usuário; a pipeline nasce pronta
   para assinar depois.
8. **Ponta solta:** `package.json` declara `bin: { orchestrator: "dist/index.js" }`
   e um script `orchestrator`, mas **`src/index.ts` não existe**. Sobrou do plano
   CLI-only. Remover ou apontar para um entry point de debug.
9. **`src/config/config.ts` está obsoleto.** O modelo `config.json` foi
   substituído pelas entidades SQLite. Ainda está no repositório com testes
   verdes; remover quando a UI cobrir provedores/contas/agentes/workspaces.
10. **`src/agents/agent-runner.ts` e `decision-parser.ts`** foram escritos para o
    plano CLI-only. O parser precisa ganhar as ações `ask_user` e `route`, mais
    `targetAgentId` e `requestedVerificationIds`.

---

## 7. Próxima fase — escopo exato

Implementar **somente** a fundação Electron:

- versão do Electron **fixada** (pinned, sem `^`);
- Electron Main;
- Preload;
- Renderer React mínimo;
- IPC **tipado**, contrato compartilhado entre main e renderer;
- `contextIsolation: true`;
- `nodeIntegration: false`;
- **`node:sqlite` testado dentro do Main empacotado** ← fazer primeiro;
- `RuntimeManager.diagnose()` exposto via IPC;
- onboarding inicial mostrando o checklist de runtimes;
- instalação de runtime pela GUI, com progresso vindo de `InstallProgress`;
- protótipo real de login Claude pela GUI (`ClaudeAccountManager.connect`, com
  `openUrl` ligado ao `shell.openExternal` do Electron);
- primeiro empacotamento Windows.

**Não iniciar ainda:** chat completo, Agents completo, Workspaces completo, Runs
completo, Gemini, frontend final.

Ordem sugerida: (1) provar `node:sqlite` no Electron antes de escrever UI;
(2) shell + IPC; (3) onboarding lendo `diagnose()`; (4) instalação pela GUI;
(5) login Claude; (6) empacotamento.

---

## 8. Critério de aceitação da próxima fase

```
AI-Orchestrator.exe
→ abre
→ Renderer React carrega
→ IPC funciona
→ Main acessa SQLite
→ RuntimeManager.diagnose() funciona
→ onboarding mostra runtimes
→ runtime pode ser configurado pela interface
→ login Claude pode ser iniciado pela interface
→ nenhum terminal faz parte da experiência normal
```

Reprova se em qualquer ponto do fluxo normal o usuário precisar abrir um
terminal, instalar Node/npm, editar JSON ou definir variável de ambiente.

Além disso: **os 175 testes existentes devem continuar verdes.**

---

## 9. Comandos de verificação

Estado atual (funcionam hoje):

```bash
npm install                 # apenas typescript + @types/node
npm run typecheck           # tsc -p tsconfig.test.json --noEmit
npm run build               # tsc -p tsconfig.json        → dist/
npm run build:tests         # tsc -p tsconfig.test.json   → dist-tests/
npm test                    # build + node --test "dist-tests/tests/**/*.test.js"
npm run clean               # remove dist/ e dist-tests/
```

Ferramenta interna de desenvolvimento (**não** é a experiência do produto):

```bash
node spike/windows-spike.mjs                 # interativo
node spike/windows-spike.mjs --help
node spike/windows-spike.mjs --non-interactive --live
```

A criar na próxima fase (nomes sugeridos, ainda não existem):

```bash
npm run dev                 # Vite renderer + Electron main em watch
npm run build:main          # compila o processo main
npm run build:renderer      # compila o renderer
npm run package             # electron-builder → NSIS per-user
npm run package:dir         # build sem instalador, para testar rápido
```

Empacotamento pretendido: `electron-builder`, alvo **NSIS per-user**
(instala em `%LOCALAPPDATA%`, sem UAC), auto-update por **GitHub Releases**
via `electron-updater`. Sem assinatura por ora.

---

## 10. Instrução final para a próxima sessão

1. Ler este arquivo inteiro antes de escrever código.
2. Conferir o estado: `git log -1`, `git status`, `npm test`.
3. Não reescrever `ProcessManager`, `RuntimeManager`, `ClaudeAccountManager`,
   `done-gate` ou `git-safety` — estão prontos, testados e resolvem requisitos
   específicos do produto. Consumir, não recriar.
4. Respeitar as decisões da seção 3 sem exceção.
5. Implementar **apenas** a seção 7.
6. Manter os 175 testes verdes; adicionar testes para o que for novo.
7. Commitar por etapa na branch `claude/new-session-3am7mo` e fazer push.
8. Ao terminar, reportar: FILES CREATED, FILES MODIFIED, TESTS, KNOWN
   LIMITATIONS, NEXT PHASE.

Se algo neste documento contradisser o código, **o código é a verdade** —
atualize o documento.
