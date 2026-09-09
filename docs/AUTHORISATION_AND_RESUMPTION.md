# Autorizei, e a tarefa não continuou

Documentação do Claude Code consultada em **9 de setembro de 2026**. As citações
são literais para poderem ser reconferidas.

## O incidente, na ordem em que aconteceu

1. A pessoa perguntou se o orquestrador conseguia acessar
   `https://github.com/Arcanjog1/Orquestrador`.
2. O Codex delegou uma consulta **somente-leitura**.
3. O worker tentou `WebFetch`. A execução do Orquestrador é não interativa, então
   o runtime recusou a chamada por falta de autorização. **Nada foi à rede.**
4. O aplicativo mostrou o pedido de autorização.
5. **A pessoa autorizou. E nada aconteceu.**
6. Ao pedir "tente novamente", o Codex criou uma **segunda** execução — plano
   novo, avaliação nova — e escalou para um modelo mais forte uma pergunta que
   nunca precisou de um.
7. O Claude ainda recebeu *"Claude requested permissions to use WebFetch, but you
   haven't granted it yet."*

## Não era um defeito. Eram quatro, empilhados

Cada um sozinho já bastava para produzir exatamente o que se viu.

### 1. Aprovar não retomava nada

`permission.approve` gravava o grant e retornava. A execução ficava em
`NEEDS_HUMAN` para sempre. Nenhum código no aplicativo continuava a tarefa — e o
próprio prompt enviado ao worker prometia o contrário:

> the task will be delegated again once they do

Corrigido em `src/permissions/resumption.ts` (a decisão) e
`OrchestrationService.resumeAfterApproval` (a retomada). A execução volta **na
iteração em que parou**, com o mesmo id: retomar não é uma execução nova usando
o id da antiga, e uma autorização não compra oito rodadas a mais.

### 2. A regra gerada não era uma regra que o CLI casa

O aplicativo montava o escopo colocando o campo principal da ferramenta entre
parênteses: `WebFetch(https://github.com/Arcanjog1/Orquestrador)`. A sintaxe
documentada não funciona assim:

> You can't match a tool's primary content field this way: `command` for Bash and
> PowerShell, `file_path` for Read, Edit, and Write, `path` for Grep and Glob,
> `notebook_path` for NotebookEdit, and `url` for WebFetch. […] Use `Bash(rm *)`,
> `Read(./path)`, or `WebFetch(domain:host)` instead.
>
> — <https://code.claude.com/docs/en/permissions>

e uma regra assim não é um erro visível, é um silêncio:

> An allow rule with an unusable pattern doesn't approve anything.

Havia mais de um caso do mesmo tipo:

- **`WebFetch`** — a regra é por *host*: `WebFetch(domain:github.com)`.
- **Caminho absoluto** — `Read(/home/user/proj/a.ts)` não é um caminho absoluto
  para o CLI: *"A pattern like `/Users/alice/file` isn't an absolute path. The
  single leading slash anchors at the settings source, not the filesystem root."*
  Agora a regra é relativa à pasta do projeto; um caminho **fora** dela não
  recebe regra nenhuma, e o diálogo diz por quê, em vez de oferecer uma
  autorização que não autorizaria nada.
- **`Write(caminho)`** — aceito, nunca consultado: *"Claude Code checks file
  permissions against `Edit(path)` and `Read(path)` rules only."* `Write` e
  `NotebookEdit` viram `Edit`; `Glob` e `Grep` viram `Read`.
- **Metacaracteres de gitignore** (`[`, `]`, `*`, `?`) são escapados, como o
  próprio CLI faz ao salvar uma aprovação.
- **Ferramentas MCP** só aceitam a regra inteira: *"Claude Code skips any `mcp__`
  rule that has parentheses."*

Tudo isso vive num lugar só: `src/permissions/rule-syntax.ts`.

### 3. Nenhum grant chegava à linha de comando

`ClaudeCodeAdapter` tinha a opção `allowedTools` — e **nada no aplicativo a
fornecia**. Todo grant aprovado era gravado no banco e nunca posto no `argv`.

Do banco, os dois casos são indistinguíveis: `approved` de um lado, e do outro
"you haven't granted it yet". Por isso a correção não é só passar a opção
(`app-services.ts`, nos dois pontos que constroem o adapter): a invocação agora
**relata** o que carregou (`AgentResult.authorisedTools`), e o laço registra um
passo `permission/carried` ou `permission/not-carried` nomeando qualquer regra
aprovada que não chegou. A autorização passa a ser comprovada no runtime, não
inferida de uma linha do banco.

### 4. Uma recusa podia ser perguntada de novo

`askForPermission` só evitava repetir um pedido **pendente**. Uma recusa não
impedia a mesma pergunta na rodada seguinte. Agora a recusa vale para o
*workspace* — não só para aquela execução — e o worker é informado de quais
ferramentas foram recusadas, para parar de bater na mesma porta.

## As regras que não dobram

- **Cancelamento vem primeiro.** `decideResumption` decide o cancelamento antes
  de qualquer outra coisa, e lê o *pedido* de cancelamento, não só o estado
  final. Uma autorização concedida depois do cancelamento não reinicia nada.
  Cancelar uma execução parada em `NEEDS_HUMAN` agora a encerra de verdade.
- **`DONE`, `FAILED` e `CANCELLED` não ressuscitam.**
- **Uma recusa é uma decisão.** Recusar não retoma a execução, e o grant que o
  projeto já tinha de antes não conta como resposta à pergunta de hoje.
- **Nada de `bypassPermissions`, `--dangerously-skip-permissions`, desativação de
  sandbox ou elevação.** Nenhum caminho deste código alcança qualquer um deles.
- **Um shell nunca é liberado por inteiro.** O escopo é o comando exato, ou o
  programa e o subcomando com argumentos.
- **Um grant nasce só de uma pessoa respondendo**, vale só para o escopo
  mostrado, e só para aquele projeto.

## Uma pergunta sobre repositório não precisa de WebFetch

O projeto **estava** conectado ao repositório, e o prompt do orquestrador dizia
"there is no repository". Por isso o supervisor delegou um fetch para descobrir
o que o próprio projeto já sabia.

Agora, quando o projeto declara um repositório, o prompt do orquestrador o nomeia
e diz que a leitura do GitHub é feita **pelo aplicativo**, pela API REST. E os
dois lados — supervisor e worker — recebem a regra que faltava:

> Never conclude that something does not exist because a tool was refused. A
> refusal is about permission, not about the world.

**O que ainda não existe:** ler arquivos do repositório pela API do GitHub e
colocá-los na frente do supervisor, como `fileReads` faz com a pasta local. Isso
é um mecanismo novo, não um ajuste, e não foi feito aqui. O que foi feito impede
o erro do incidente — delegar um fetch e concluir errado a partir de uma recusa.

## Onde isso é testado

| arquivo | o que fixa |
|---|---|
| `tests/permission-rule-syntax.test.ts` | cada forma de regra, contra a sintaxe publicada |
| `tests/permission-resumption.test.ts` | a decisão de retomar, caso a caso, e o incidente inteiro ponta a ponta |
| `tests/desktop-adapters.test.ts` | o `argv` real do CLI, e o que a invocação relata ter carregado |
| `tests/tool-permissions.test.ts` | o que continua proibido: escopo, workspace, shell nu |
| `apps/desktop/tests/electron-integration.mjs` | o mesmo fluxo pela ponte real do aplicativo empacotado |

O critério é o da própria pessoa: **autorizei, o runtime recebeu a autorização, e
a tarefa original continuou.**
