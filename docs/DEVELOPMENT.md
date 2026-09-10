# Desenvolvimento

Como trabalhar neste repositório. Para o que o produto é, ver o
[`README.md`](../README.md) na raiz.

## Setup

Node **>= 20.11** (o CI usa 22). O repositório é um workspace npm: `apps/desktop`
e `apps/coordinator` são pacotes filhos, e `npm ci` na raiz instala todos.

```bash
npm ci
npm run desktop
```

O binário do Electron tem ~120 MB e é baixado pelo `postinstall`. Se a rede
falhar no meio, `node node_modules/electron/install.js` refaz só esse passo.

## Testes

| Comando | O que cobre |
|---|---|
| `npm run typecheck` | domínio (`tsconfig.test.json`), coordinator e desktop (main + renderer) |
| `npm test` | suíte principal, no runner do Node, a partir de `dist-tests/` |
| `npm run desktop:test` | integração em Electron real (janela de verdade; usa `xvfb-run` no Linux) |
| `npm run -w apps/desktop test:packaged` | smoke no aplicativo já empacotado |

`npm test` compila antes (`pretest`). Um teste que só passa fora do empacotado
não prova o produto: as três camadas existem porque falham por motivos
diferentes.

As provas de runtime em `scripts/probe-real-runtimes.mjs` baixam e executam os
CLIs de verdade. Elas rodam no CI e não usam conta nenhuma — o que se prova é
que a aplicação consegue instalar e invocar o runtime, não que alguém está
autenticado.

## Empacotar

```bash
npm run package         # Windows: NSIS por usuário, sem elevação
npm run package:linux   # Linux: diretório desempacotado
```

A configuração do `electron-builder` fica no campo `build` de
`apps/desktop/package.json`.

## CI

`.github/workflows/ci.yml` roda em **todo** push. São dois jobs:

- **Windows** — a plataforma de verdade do produto. Typecheck, testes, build,
  integração em Electron, empacotamento NSIS, regressão de overflow (no Electron
  e no empacotado), smoke do empacotado, prova real de instalação do Codex e do
  Claude Code, e a verificação de que o instalador foi produzido.
- **Linux** — rápido, e uma quebra aqui costuma ser quebra em todo lugar.

Passos marcados `continue-on-error` são informativos: coletam fatos sobre o
Windows real (assinatura, versões, fontes de runtime) e não reprovam o build.

## Fluxo de branches

`main` é a única branch oficial e a default do repositório.

- Trabalho novo sai de `main`, numa branch temporária.
- Depois de incorporado, **apague a branch**. Branches antigas acumuladas foram
  o problema que a consolidação de 2026-09-10 resolveu — ver
  [`history/SUPERSEDED_BRANCHES.md`](history/SUPERSEDED_BRANCHES.md).
- Não reescreva histórico de branch compartilhada (sem `rebase`, `amend` ou
  force-push em cima do trabalho de outra sessão).

## Release

Cada commit em `main` que passa no CI publica o instalador Windows como
pre-release: tag por commit `desktop-dev-<sha>` e a tag rolante `desktop-dev`.
Não são versões estáveis e não são assinadas, então o Windows mostra o aviso do
SmartScreen.

## Organização de `docs/`

- `docs/` — arquitetura, políticas e guias **atuais**.
- `docs/audits/` — auditorias funcionais e suas matrizes.
- `docs/history/` — incidentes resolvidos, handoffs de fases encerradas e
  registros de port. Úteis como referência; não descrevem o estado atual.
