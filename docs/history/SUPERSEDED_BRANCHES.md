# Branches superadas — consolidação em `main`

Atualizado em **2026-09-10**, quando o repositório foi consolidado.

Até aqui o repositório não tinha `main`: a default era
`claude/new-session-3am7mo`, parada 223 commits atrás da linha de
desenvolvimento real. Dez branches `claude/*` coexistiam e não era possível
dizer, de fora, qual era o produto.

`main` foi criada a partir de
`claude/ai-orchestrator-buzz-arch-vblrau` @ `636e099`, a linha moderna, é a
**default branch** do repositório e é agora a única fonte oficial.

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
| `claude/ai-orchestrator-buzz-arch-vblrau` | `2686208` | 0 (já em `main`) | **branch ativa**: recebeu três commits durante a consolidação, todos incorporados por merge | KEEP_FOR_REVIEW |

As cinco primeiras são **ancestrais estritos** de `636e099`: `git rev-list
--count main..<branch>` devolve 0, então não havia nada nelas fora de `main`.

Nenhuma branch tinha trabalho válido exclusivo. Nada precisou ser portado nesta
consolidação, e nada foi mergeado às cegas.

**Exceção viva:** enquanto `main` era testada, três commits novos entraram em
`claude/ai-orchestrator-buzz-arch-vblrau` — provas isoladas de verificação de
modelo (`04a8335`, `aa85977`, `2686208`). Eles **não** eram trabalho antigo
esquecido: eram trabalho em curso. Foram incorporados por merge (`939e8cd`),
sem sobreposição com nenhum arquivo da limpeza. Por isso essa branch é
`KEEP_FOR_REVIEW`, e não candidata a deleção: apagá-la enquanto outra sessão
escreve nela perderia trabalho.

## Provas registradas antes da deleção

A partir de `main`, no commit consolidado:

- `npm run typecheck` — limpo.
- `npm test` — **1034 testes, 1032 aprovados, 0 falhas**, 2 ignorados.
- `npm run desktop:test` — **45 aprovados, 0 falhas**, incluindo os três testes
  de card que cobrem justamente a disponibilidade de modelos portada.
- `npm run -w apps/desktop test:packaged` — **11 aprovados, 0 falhas**, com o
  banco migrado para `schema 21, journal wal`.
- Empacotamento Linux concluído.
- **CI verde em `main`**, nos dois jobs, incluindo empacotamento NSIS, smoke do
  empacotado, regressão de overflow no Windows real, provas de instalação de
  Codex e Claude Code, e a publicação do instalador
  (`desktop-dev-5d4f57b`, depois `desktop-dev-939e8cd`).

Depois do merge do trabalho novo, a suíte subiu para **1057 testes, 1055
aprovados, 0 falhas**, com 46 testes Electron e 11 do empacotado.

## Regra daqui em diante

Trabalho novo sai de `main`, em branch temporária, e a branch é apagada depois
de incorporada. Não deixe branches paradas acumulando: foi exatamente isso que
tornou este documento necessário.

## Deleção ainda pendente

As branches classificadas acima como `INCORPORATED` e `SUPERSEDED` **ainda não
foram apagadas**: o ambiente onde a consolidação rodou não tem permissão para
apagar refs nem para criar tags no remoto. Ordem correta para concluir:

```bash
# 1. Rede de segurança para as quatro que têm commits fora de main.
git tag -a archive/ai-orchestrator-continuation-sbzrfg 1e8a4d6 -m 'Superseded, arquivada'
git tag -a archive/external-references-catalog-cug8uy  ffe5876 -m 'Superseded, arquivada'
git tag -a archive/lovable-design-integration-3f8w7c   d7a0c2c -m 'Superseded, arquivada'
git tag -a archive/model-availability-status-ux-aodkm9 51b0eee -m 'Superseded, arquivada'
git push origin 'refs/tags/archive/*'

# 2. As cinco que são ancestrais estritos de main: nada a perder.
git push origin --delete claude/ai-orchestrator-continuation-grblen \
  claude/ai-orchestrator-implementation-y7xw98 \
  claude/ai-orchestrator-reorientacao-ytlkw0 \
  claude/lovable-on-latest-core \
  claude/new-session-3am7mo

# 3. As quatro superadas, só depois das tags do passo 1.
git push origin --delete claude/ai-orchestrator-continuation-sbzrfg \
  claude/external-references-catalog-cug8uy \
  claude/lovable-design-integration-3f8w7c \
  claude/model-availability-status-ux-aodkm9
```

`claude/ai-orchestrator-buzz-arch-vblrau` fica de fora até a sessão que escreve
nela migrar para `main`.

## Pendência separada

A limpeza de histórico descrita em
[`SECURITY_HISTORY_CLEANUP.md`](SECURITY_HISTORY_CLEANUP.md) **não** foi feita
aqui. Apagar um arquivo do HEAD não remove seus bytes do histórico, e reescrever
histórico exige autorização própria.
