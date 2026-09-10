# Incidente: `unknown variant \`max\`` — o Codex que não conseguia iniciar

Registrado em 2026-09-06, branch `claude/lovable-on-latest-core`.

## O que aconteceu

No Windows, com as duas contas conectadas, o loop falhou na iteração 1. O
registro da execução (Detalhes) guardou o que o CLI imprimiu:

```
ERROR codex_core::models_manager::manager: failed to refresh available models:
stream disconnected before completion: failed to decode models response:
unknown variant `max`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
```

O processo saiu com código 1 antes de responder; o parser recebeu nada e
registrou `No JSON object was found`. O parse não é a causa — é a consequência.

## Causa

O backend de modelos da OpenAI passou a devolver níveis de raciocínio `max` e
`ultra` no catálogo. Um Codex antigo desserializa esse catálogo com um enum
fechado e recusa a resposta.

Verificado no código-fonte oficial (`codex-rs/protocol/src/openai_models.rs`):

| release | enum `ReasoningEffort` |
|---|---|
| `rust-v0.130.0` | `None, Minimal, Low, Medium, High, XHigh` — **recusa `max`** |
| `rust-v0.140.0` | ganha `Max` |
| `rust-v0.145.0` em diante | ganha `Custom(String)` — aceita qualquer valor futuro |
| `rust-v0.153.0` e `rust-v0.153.4` | idem: `Max`, `Ultra`, `Persistent`, `Custom` |

A mensagem do incidente é, palavra por palavra, a do enum anterior a 0.140. O
binário que falhou na máquina, portanto, **não era o 0.153.0 gerenciado** — o
aplicativo aceitava qualquer `codex` encontrado no `PATH` como "pronto", sem
aplicar a janela de compatibilidade (mínimo 0.150.0) que só valia para
downloads.

Prova com os binários oficiais reais (`scripts/probe-codex-catalog.mjs`, que
serve um catálogo com `max`/`ultra` a partir de um backend falso em localhost e
conduz `codex exec` como o adapter conduz):

| binário oficial (Linux x64, SHA-256 conferido) | resultado |
|---|---|
| 0.130.0 | `unknown variant: true` |
| 0.153.0 | catálogo aceito, decisão estruturada produzida |
| 0.153.4 | catálogo aceito, decisão estruturada produzida |

## O que mudou

1. **Versão testada: 0.153.4** — `latest` do pacote oficial `@openai/codex`
   (publicado 2026-09-04) e release `rust-v0.153.4`; `0.154.0-alpha.*` foi
   ignorado por ser pré-lançamento.
2. **A janela vale para qualquer executável.** Um Codex abaixo de 0.150.0,
   no `PATH` ou instalado, é reportado como incompatível, o readiness recusa o
   envio nomeando a versão, e a tela de componentes oferece *Atualizar
   automaticamente*.
3. **Atualização automática do gerenciado.** Ao abrir, um Codex instalado pelo
   aplicativo abaixo da versão testada é levado à versão testada (pedida pela
   própria tag, nunca "latest"), com staging e rollback; os perfis de conta
   (`CODEX_HOME`, `auth.json`) ficam em `profiles/`, fora do diretório do
   runtime, e não são tocados — há teste para isso.
4. **Falha do CLI é falha do CLI.** Saída com código ≠ 0 vira
   `failureKind: cli` ("O Codex CLI falhou"), com a linha `ERROR` do próprio
   CLI e o caminho do binário que rodou nos Detalhes. O erro de parse continua
   registrado como nota, não como manchete. Nenhum reparo é tentado num crash.
5. **Sonda no CI.** `probe-real-runtimes.mjs --runtime codex` agora instala o
   0.153.4 real e o coloca diante do catálogo com `max`, com o esquema de
   decisão em `--output-schema`; se o CLI recusar o catálogo, ou se o esquema
   que ele envia em modo estrito violar as regras da API, o job falha.

## O segundo defeito que a sonda encontrou: o esquema de saída

Com o catálogo aceito, a sonda passou a conduzir o turno exatamente como o
adapter conduz — com `--output-schema` — e a ler o pedido que o binário
envia ao backend (o corpo vem comprimido com zstd; o backend falso o
descomprime pelo `Content-Encoding`). O `codex exec` 0.153.x envia o esquema
como `text.format = {type: "json_schema", strict: true, ...}`
(`codex-rs/core/src/session/turn.rs`, `codex-api/src/common.rs`). No modo
estrito, a API de Responses valida o esquema antes de o modelo o ver: todo
objeto precisa de `additionalProperties: false` e de **todas** as
propriedades em `required`; um campo opcional é um tipo anulável.

O esquema anterior listava só `action` em `required`. Um turno real
responderia HTTP 400 antes de qualquer decisão — o loop nunca teria passado
da iteração 1 mesmo com o Codex certo.

O que mudou:

- `DECISION_JSON_SCHEMA` (versão 2) segue as regras do modo estrito:
  `required` lista todas as propriedades; `task`, `summary` e `reason` são
  `["string","null"]`; `$schema` foi removido (palavra-chave não aceita).
- `parseDecision` lê `null` como ausência, e continua exigindo `task` em
  `delegate` e `reason` em `blocked`.
- `strictSchemaProblems()` reproduz as regras do modo estrito; um teste
  unitário e a sonda de CI (contra o pedido real que o binário envia)
  falham se o esquema voltar a violá-las.

Prova com o binário oficial (`probe-codex-catalog.mjs`): `schema sent:
true; strict: true; problems: none`, decisão devolvida no arquivo de última
mensagem com `reason: null` e `relevantFiles: []`.

## Se acontecer de novo

Abra Detalhes na execução: o campo `executable` diz qual binário rodou, e a
tela Componentes diz a versão e a origem (`managed` ou `system`).
