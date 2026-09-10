# Branches superadas — consolidação em `main`

Atualizado em **2026-09-10**, quando o repositório foi consolidado.

Até aqui o repositório não tinha `main`: a default era
`claude/new-session-3am7mo`, parada 223 commits atrás da linha de
desenvolvimento real. Dez branches `claude/*` coexistiam e não era possível
dizer, de fora, qual era o produto.

`main` foi criada a partir de
`claude/ai-orchestrator-buzz-arch-vblrau` @ `636e099`, a linha moderna, e é
agora a única fonte oficial.

---

## Auditoria que autorizou a limpeza

Cada branch foi comparada com a linha moderna por *merge-base*, commits
exclusivos e **funcionalidade** — não só por histórico de git. Uma branch com
commit exclusivo cuja funcionalidade já havia sido reimplementada na linha
moderna conta como superada, não como trabalho perdido.

| Branch | HEAD | Commits exclusivos | Situação | Status |
|---|---|---|---|---|
| `claude/new-session-3am7mo` | `5ca6062` | 0 | ancestral comum de todas as linhas; era a default | INCORPORATED |
| `claude/ai-orchestrator-continuation-grblen` | `903a60b` | 0 | ancestral direto da linha moderna | INCORPORATED |
| `claude/ai-orchestrator-implementation-y7xw98` | `b53120c` | 0 | ancestral direto | INCORPORATED |
| `claude/ai-orchestrator-reorientacao-ytlkw0` | `2e06ae5` | 0 | ancestral direto | INCORPORATED |
| `claude/lovable-on-latest-core` | `de4b4aa` | 0 | ancestral direto; era o baseline reconciliado anterior | INCORPORATED |
| `claude/ai-orchestrator-continuation-sbzrfg` | `1e8a4d6` | 4 | primeira fundação Electron, refeita melhor em `apps/desktop/` | SUPERSEDED |
| `claude/external-references-catalog-cug8uy` | `ffe5876` | 1 | `docs/EXTERNAL_REFERENCES.md`; a versão moderna é um superset | INCORPORATED |
| `claude/lovable-design-integration-3f8w7c` | `d7a0c2c` | 1 | design Lovable aprovado; os 39 arquivos de UI já existem em `apps/desktop/src/renderer/` | SUPERSEDED |
| `claude/model-availability-status-ux-aodkm9` | `51b0eee` | 1 | disponibilidade de modelos; portada — ver [`MODEL_AVAILABILITY_PORT.md`](MODEL_AVAILABILITY_PORT.md) | SUPERSEDED |

As cinco primeiras são **ancestrais estritos** de `636e099`: `git rev-list
--count main..<branch>` devolve 0, então não havia nada nelas fora de `main`.

Nenhuma branch tinha trabalho válido exclusivo. Nada precisou ser portado nesta
consolidação, e nada foi mergeado às cegas.

## Provas registradas antes da deleção

A partir de `main`, no commit consolidado:

- `npm run typecheck` — limpo.
- `npm test` — **1034 testes, 1032 aprovados, 0 falhas**, 2 ignorados.
- `npm run desktop:test` — **45 aprovados, 0 falhas**, incluindo os três testes
  de card que cobrem justamente a disponibilidade de modelos portada.
- `npm run -w apps/desktop test:packaged` — **11 aprovados, 0 falhas**, com o
  banco migrado para `schema 21, journal wal`.
- Empacotamento Linux concluído. Windows e instalador NSIS ficam por conta do
  CI, que roda os dois jobs em todo push.

## Regra daqui em diante

Trabalho novo sai de `main`, em branch temporária, e a branch é apagada depois
de incorporada. Não deixe branches paradas acumulando: foi exatamente isso que
tornou este documento necessário.

## Pendência separada

A limpeza de histórico descrita em
[`SECURITY_HISTORY_CLEANUP.md`](SECURITY_HISTORY_CLEANUP.md) **não** foi feita
aqui. Apagar um arquivo do HEAD não remove seus bytes do histórico, e reescrever
histórico exige autorização própria.
