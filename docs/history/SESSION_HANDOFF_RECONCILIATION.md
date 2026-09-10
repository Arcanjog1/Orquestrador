# Session handoff — a única linha de desenvolvimento

Este documento existe porque o projeto passou a ter **duas** linhas paralelas, e
elas foram reconciliadas. Ele registra o que aconteceu, para que ninguém volte a
partir da linha errada.

Escrito em 2026-09-04.

---

## 1. O que tinha acontecido

Duas branches saíram do mesmo commit, `5ca6062`:

| Branch | HEAD | O que trouxe |
|---|---|---|
| `claude/ai-orchestrator-continuation-grblen` | `903a60b` | 27 commits: Electron real, adapters, contas dos dois providers, loop de orquestração, Windows CI, instalador |
| `claude/lovable-design-integration-3f8w7c` | `d7a0c2c` | 1 commit: o design aprovado, sobre uma fundação Electron construída do zero |
| `claude/ai-orchestrator-continuation-sbzrfg` | `1e8a4d6` | 4 commits: uma primeira fundação Electron, superada por grblen |

A branch de design foi criada a partir de `5ca6062` sem saber que `grblen` já
tinha avançado muito além. Ela **recriou** Electron, IPC e repositórios que já
existiam, em outro layout.

**Nada foi perdido:** as quatro branches continuam no remoto, intactas.

## 2. O resultado

`claude/lovable-on-latest-core`, criada a partir de `903a60b`.

- **Funcionalidade:** 100% de `grblen`, sem reimplementar nada.
- **Renderer:** o design aprovado, portado para cima dela.

O que a branch de design tinha construído de backend — Electron main, preload,
contrato IPC, `src/database/repositories.ts` — foi **descartado**, porque
`grblen` já tinha equivalentes mais maduros. Só o renderer atravessou.

## 3. Regra de decisão aplicada

| Camada | Fonte da verdade |
|---|---|
| Backend, runtime, auth, database, IPC, packaging, CI | `grblen` |
| Renderer, componentes, CSS, layout, UX | design aprovado |

## 4. Adições ao contrato IPC

Duas, ambas porque a interface aprovada precisa delas:

- `app.openExternal` — o botão "Abrir no GitHub". Não é um "abrir" genérico: o
  esquema é validado no validador **e** de novo no shell.
- `settings.all` / `settings.set` — a tela de Settings, sobre a tabela
  `settings` que o schema já definia.

A lista de canais continua fechada e os três lados continuam concordando.

## 5. Estados do run

O design fala 14 estados; o registro guarda 5. A diferença **não é inventada**:
vem do estágio que o loop já emite.

| `run:progress.stage` | Estado do design |
|---|---|
| analysing / orchestrator | PLANNING |
| worker | WORKER_RUNNING |
| evidence | COLLECTING_EVIDENCE |
| verification | VERIFYING |
| review | REVIEWING |
| blocked | NEEDS_HUMAN |
| done / failed / cancelled | DONE / FAILED / CANCELLED |

## 6. Logo

Investigado a fundo. **Não existe asset de logo em nenhuma branch nem em
nenhum ponto do histórico.** As únicas imagens versionadas são screenshots em
`docs/images/`. A screenshot do app empacotado no Windows mostra a identidade
que ele tinha: o texto "AI Orchestrator" em negrito, sem marca.

Decisão do usuário: usar o mark do protótipo (ícone `sparkles`) como identidade
oficial. Ele aparece na sidebar, no onboarding e no empty state.

## 7. Testes

| | |
|---|---|
| Antes, em `grblen` | 236 |
| Antes, na branch de design | 170 |
| **Depois da reconciliação** | **242** |

Nenhum teste de `grblen` foi removido. Os 6 novos cobrem os canais adicionados.

Os testes exclusivos da branch de design **não** foram trazidos, e o motivo é
que o código que eles testavam não existe aqui:

- 10 testes de `src/database/repositories.ts` — aquele arquivo era uma segunda
  implementação; `grblen` já tinha a sua, exercitada pelos testes de serviço.
- 4 testes de `git-safety` — testavam ter liberado `git remote` e
  `for-each-ref` na allowlist somente-leitura. `grblen` lê a branch por outro
  caminho, então **a allowlist não foi alargada**. Menos superfície, não mais.

Dois testes existentes foram **atualizados**, não removidos: ambos afirmavam
sobre o texto da UI antiga.

## 8. Verificação

```bash
npm install
npm run typecheck              # backend, main e renderer
npm test                       # 242
npm run desktop:test           # 11 testes Electron
npm run -w apps/desktop package
npm run -w apps/desktop test:packaged
```

## 9. O que ainda não existe

1. Conteúdo dos diffs na interface (os arquivos são arquivados; a UI não os lê).
2. Medição de contexto — por isso o medidor do design fica oculto.
3. Pausar/retomar um run: só cancelar.
4. Login GitHub próprio; o remoto é lido do projeto.

## 10. Não renegociar

Valem todas as decisões dos handoffs anteriores, mais:

1. **A base é `grblen`.** Não voltar a partir de `5ca6062`.
2. **O design é o do protótipo.** Ajustar espaçamento, cor ou tipografia
   "porque parece melhor" é regressão.
3. **Nunca inventar um número na interface.** Travessão é a resposta certa.
4. **Todo canal novo entra primeiro no contrato**, com validador e teste.
