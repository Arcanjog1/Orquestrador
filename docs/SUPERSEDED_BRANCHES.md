# Branches superadas

Nenhuma branch deste repositório foi apagada. Este arquivo diz qual delas ainda
é a linha de trabalho, para que ninguém retome a partir da errada.

Atualizado em 2026-09-04.

---

## Linha atual

| Branch | HEAD | Estado |
|---|---|---|
| `claude/lovable-on-latest-core` | `66f7a07` | **BASELINE RECONCILIADO** — verificado no Windows CI ([run 33910787494](https://github.com/Arcanjog1/Orquestrador/actions/runs/33910787494)) |

## Superadas

### `claude/lovable-design-integration-3f8w7c` @ `d7a0c2c`

**SUPERSEDED BY `claude/lovable-on-latest-core`.**

Foi criada a partir de `5ca6062` sem saber que
`claude/ai-orchestrator-continuation-grblen` já tinha avançado 27 commits além
daquele ponto. Por isso **reconstruiu do zero** coisas que já existiam:
fundação Electron, preload, contrato IPC e `src/database/repositories.ts`, em
um layout diferente (`src/` plano em vez de `apps/desktop/`).

O que ela tinha de valor — o design aprovado — foi portado para a linha atual.
O resto foi descartado por ser menos maduro que o equivalente já existente.

Não retomar. Não fazer merge. Preservada apenas como histórico.

### `claude/ai-orchestrator-continuation-sbzrfg` @ `1e8a4d6`

**SUPERSEDED BY `claude/ai-orchestrator-continuation-grblen`.**

Uma primeira fundação Electron, também saída de `5ca6062`, substituída pela de
`grblen`. Preservada como histórico.

### `claude/ai-orchestrator-continuation-grblen` @ `903a60b`

**Não é obsoleta: é a base funcional da linha atual.** Todo o seu conteúdo está
contido em `claude/lovable-on-latest-core`. Preservada como ponto de comparação.

### `claude/new-session-3am7mo` @ `5ca6062`

O ancestral comum de todas as linhas acima. Preservada como histórico.

---

## Regra

Trabalho novo sai de `claude/lovable-on-latest-core`. Nenhuma branch deste
arquivo deve ser apagada, e nenhuma delas deve receber force-push.
