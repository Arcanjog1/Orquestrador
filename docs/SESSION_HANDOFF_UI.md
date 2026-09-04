# Session handoff — o design aprovado, integrado

Continuação de `SESSION_HANDOFF_ELECTRON.md`. Aquele documento descrevia a
fundação Electron como a **próxima fase**; ela agora existe, e junto com ela o
design aprovado do protótipo Lovable.

Escrito em 2026-09-04.

---

## 1. O que mudou

| | Antes | Agora |
|---|---|---|
| Frontend | **nenhum** | Renderer React com o design aprovado |
| Electron | **nenhum** | Main + preload + IPC tipado |
| Testes | 156 | 170 |
| Empacotamento | inexistente | `AI-Orchestrator-Setup.exe` (NSIS per-user) |
| Dependências de runtime | nenhuma | nenhuma (tudo é devDependency; o Vite empacota o renderer) |

O backend descrito na seção 2 do handoff anterior **não foi alterado**, com uma
exceção nomeada na seção 4 deste documento.

---

## 2. Fonte da verdade do design

O design vem de `Arcanjog1/ai-project-lead` (protótipo Lovable), commit
`3986bb9`. Ele é a fonte da verdade para layout, cores, tipografia,
espaçamentos, componentes e animações. Este repositório é a fonte da verdade
para tudo que é comportamento.

Arquivos trazidos **sem alteração de aparência**:

```
src/renderer/styles.css                  tokens, dark-first, animações
src/renderer/components/ui/*.tsx         10 componentes shadcn (byte a byte)
src/renderer/components/orch/*.tsx       sidebar, top bar, timeline, composer,
                                         activity, dialogs, primitives
```

Nenhum valor de cor, raio, espaçamento, largura ou tipografia foi ajustado.

---

## 3. Estrutura nova

```
src/
  shared/ipc-contract.ts    contrato tipado, único arquivo que main e renderer
                            compartilham; sem import de Node
  preload/preload.cts       ponte; compila para CommonJS (.cjs) porque um
                            preload com sandbox não tem carregador ESM
  main/
    main.ts                 janela, ciclo de vida, política de navegação
    services.ts             RuntimeManager, Database, ClaudeAccountManager
    ipc.ts                  um handler por canal; valida antes de agir
  renderer/
    App.tsx  router.tsx  main.tsx  index.html  styles.css
    lib/     bridge.ts (única porta), timeline.ts (run real -> cards do design),
             orchestrator-data.ts (vocabulário do design), utils.ts
    pages/   Workspace, Onboarding, Settings, History
  database/repositories.ts  acesso tipado às tabelas que já existiam
```

---

## 4. Única alteração no backend

`src/git/git-safety.ts` ganhou `remote` e `for-each-ref` na allowlist de
comandos git somente-leitura, porque a barra de contexto precisa do remoto e da
lista de branches. `remote` **não** foi liberado pelo nome: `add`, `remove`,
`rename`, `set-url`, `prune` e `update` continuam recusados, com teste. Todo
acesso a git do aplicativo continua passando por `assertReadOnlyGitArgs`.

`src/database/database.ts` ganhou repositórios sobre tabelas **já existentes**.
Nenhuma tabela, coluna ou migration foi criada; `SCHEMA_VERSION` continua 1.

---

## 5. O que a interface mostra de verdade

| Área do design | Fonte real |
|---|---|
| Sidebar · Recentes | `chat_sessions` do workspace |
| Sidebar · Projetos | `workspaces` |
| Chip GitHub | remoto do git do projeto |
| Chip Projeto | `workspaces.local_path` |
| Chip Branch | `git for-each-ref` |
| Chip Orquestrador | `agents` + `accounts` |
| Status pill | `runs.status` |
| Timeline | `runs`, `run_steps`, `agent_invocations`, `verification_results` |
| Iteração | `runs.iteration` |
| Evidence | `git diff --numstat`, `artifacts` |
| Activity | `run_steps`, `agent_invocations`, git |
| Onboarding · Componentes | `RuntimeManager.diagnose()` / `install()` |
| Onboarding · Agentes | `ClaudeAccountManager.connect()` |
| Accounts | `accounts` + `ClaudeAccountManager` |
| Settings | tabela `settings` |
| Histórico | `runs` |

**Regra seguida em toda a interface:** um dado que o aplicativo não tem aparece
como estado vazio ou travessão, nunca como número inventado. Por isso Tests e
Context aparecem como `—` até existir medição, e a barra de contexto do design
só é renderizada quando houver um valor real.

---

## 6. O que ainda não existe

1. **Loop de orquestração.** `runs:start` registra objetivo, baseline real do
   git, sessão de chat e primeiro `run_step`, e então marca o run como
   `NEEDS_HUMAN` com `termination_reason` dizendo exatamente que o motor não
   está conectado. Nenhum agente é executado. Conectar
   Codex -> Claude -> Evidence -> Verification -> Codex -> DoneGate a esses
   registros é a próxima fase.
2. **CodexAccountManager.** Só Anthropic tem gerenciador. A interface diz
   "Ainda não gerenciado" em vez de oferecer um botão que não faz nada.
3. **Integração GitHub.** O repositório é lido do remoto do projeto; não há
   OAuth nem API.
4. **Conteúdo de diff.** `artifacts` indexa os arquivos; a interface ainda não
   lê os bytes do disco.
5. **Medição de contexto.** Não existe; o bloco correspondente fica oculto.
6. **Editar equipe / criar branch.** Exigem escrita que o backend não expõe.

---

## 7. Verificação

```bash
npm install
npm run typecheck     # tsc (main+tests) e tsc (renderer)
npm test              # 170 testes
npm run build:all     # main + preload + renderer
npm start             # roda o app
npm run package       # AI-Orchestrator-Setup.exe em release/
```

`npm run package` em Linux precisa de wine (32 bits) para a etapa que gera o
desinstalador; em Windows não precisa de nada além do Node.

---

## 8. Decisões que não devem ser renegociadas

Valem todas as da seção 3 do handoff anterior, mais:

1. **O design é o do protótipo.** Ajustar espaçamento, cor, tipografia ou
   hierarquia "porque parece melhor" não é uma melhoria: é uma regressão.
2. **Nunca inventar um número na interface.** Estado vazio é a resposta certa.
3. **O renderer não fala com o sistema.** `window.orchestrator` é a única porta;
   `contextIsolation`, `sandbox` e `nodeIntegration=false` não se negociam.
4. **Todo canal novo entra primeiro no contrato** (`src/shared/ipc-contract.ts`),
   com validação de payload no handler.
