# Verificar um arquivo sem cadastrar um teste para ele

## 1. Causa comprovada

A execução parou na iteração 3 com:

> *"verify exige uma verificação registrada, mas nenhuma está disponível."*

O Codex estava **certo**, e o problema era maior do que a mensagem sugeria.

Reproduzi aqui, com um worker que cria o arquivo corretamente:

```
run status        : FAILED
summary           : Limite de 4 iterações atingido.
hello.txt on disk : true
bytes             : 70 72 6f 6e 74 6f      ← exatamente o objetivo
done-gate steps   : rejected: Acceptance criterion is recorded as failed: "…"
                    rejected: Acceptance criterion is recorded as failed: "…"
                    rejected: Acceptance criterion is recorded as failed: "…"
```

**O arquivo estava certo e a execução não podia terminar.** Três vezes.

A cadeia:

1. o workspace não tinha verificações cadastradas, então o laço não tinha
   nada para rodar;
2. sem nada rodado, `allPassed` era falso;
3. com `allPassed` falso, **todo critério de aceite era marcado `failed`** —
   não "sem prova", mas *reprovado*;
4. o DoneGate trata `failed` como definitivo e bloqueia;
5. e `verify` exigia um id de verificação, que não existia.

Ou seja: **declarar um critério de aceite num workspace sem verificações
cadastradas tornava DONE inalcançável**, fizesse o worker o que fizesse. O
Codex parou porque continuar era inútil.

Havia dois defeitos, não um:

- **estrutural**: não existia forma de provar o conteúdo de um arquivo sem
  alguém cadastrar um comando de shell antes;
- **lógico**: "ninguém olhou" e "a evidência é contra" eram gravados como a
  mesma coisa.

## 2. A verificação direta

Uma **comparação tipada** que o processo principal faz lendo o arquivo.

| | verificação cadastrada | verificação direta |
|---|---|---|
| quem escreve | uma pessoa, uma vez, em Configurações | o supervisor, por tarefa |
| o que é | uma linha de comando | uma comparação estruturada |
| o que executa | um processo filho | `readFile` no processo principal |
| executa código? | sim, é o objetivo | **não**, por construção |

A regra antiga continua intacta: **só verificação cadastrada executa comando.**
Esta não executa nenhum.

O supervisor pede assim:

```json
{
  "path": "hello.txt",
  "expectBytesHex": "70726F6E746F",
  "forbidBom": true,
  "forbidTrailingNewline": true,
  "criteria": ["hello.txt contém exatamente os bytes 70 72 6F 6E 74 6F"]
}
```

Cada campo é validado; **um campo desconhecido é recusado, não ignorado** —
`{"path": "x", "command": "rm -rf /"}` não vira nada.

O resultado registra caminho resolvido, tamanho, **sha256** e um desfecho
nomeado: `ok`, `missing`, `content-mismatch`, `size-mismatch`, `bom-present`,
`trailing-newline`, `not-a-file`, `too-large`, `read-error`,
`outside-workspace`, `invalid-request`.

### O limite

Todo caminho é resolvido contra a raiz do workspace e precisa ficar dentro
dela — verificado **depois** de resolver links, para que um symlink apontando
para fora seja recusado em vez de seguido. Caminho absoluto, `..`, byte nulo:
recusados. Arquivo acima de 1 MiB: recusado, com a indicação de usar uma
verificação cadastrada.

## 3. Ligação com o DoneGate

- **Um resultado prova o que ele nomeia.** Um check settles exatamente os
  `criteria` que ele lista. Um check sem `criteria` é registrado e **não
  resolve nada** — não existe "o arquivo existe, logo está tudo certo".
- **Um critério que ninguém checou fica `unknown`**, não `failed`. O gate
  continua bloqueando, mas agora diz *"has no supporting evidence"* em vez de
  *"is recorded as failed"*.
- **O gate relê o arquivo antes do DONE.** Um arquivo certo na iteração 2 pode
  ter sido sobrescrito na 3; confiar na leitura anterior seria certificar uma
  lembrança.
- **Arquivo já correto conclui sem reescrita.** Se o gate acabou de abrir o
  arquivo e achou os bytes pedidos, "nada mudou" não é motivo para recusar —
  exigir um diff artificial seria exigir uma reescrita inútil.

## 4. Quando não há verificação nenhuma

O prompt do supervisor passou a listar as verificações diretas como sempre
disponíveis, e quando o catálogo está vazio diz, com essas palavras, que isso
**não é um beco sem saída**.

Se ele pedir um id inexistente, a resposta o aponta para o mecanismo que
existe. Se pedir **duas vezes seguidas** sem provar nada, a execução para com
um motivo concreto — sem repetir a delegação e **sem aumentar o modelo**:
nenhum modelo cadastra uma verificação.

A primeira recusa não para nada: é informação que o supervisor ainda não viu.

### O que ainda falta provar, dito em toda rodada

Listar o que **está disponível** só resolve metade. A outra metade é o que
ainda **carece de prova**, e antes disso o supervisor só descobria propondo
`done` e sendo recusado pelo gate — uma ida e volta desperdiçada por rodada.

Agora o retorno de cada iteração traz:

```
CRITERIA STILL WITHOUT PROOF (each one blocks "done"):
  [unproven] "hello.txt contém exatamente os bytes 70 72 6F 6E 74 6F"
  unproven = nothing has checked it yet. failed = something checked it and it did not hold.
  Prove each one with a "fileChecks" entry that names it in "criteria", or with a
  verification id from the list you were given. Never with an id that is not on that list.
```

Os dois estados continuam separados de propósito: `unproven` é *ninguém
olhou*, `failed` é *alguém olhou e não bate*. Juntar os dois foi exatamente o
defeito que tornava um arquivo correto inconcluível.

Quando não sobra nada, o bloco diz isso — e diz por quê: uma nova delegação
repetiria trabalho já feito.

## 4b. O contrato tem quatro faces, e uma delas estava faltando

Depois da build `1650c9c` o supervisor respondeu **duas vezes** com
`action=verify`, `verificationCommands=[]` e sem `fileChecks`, e as duas foram
recusadas. Ele não estava sendo teimoso: **não podia** responder outra coisa.

`codex exec` recebe o contrato em `--output-schema` e o encaminha em modo
estrito, onde `additionalProperties: false` é obrigatório — e o
`DECISION_JSON_SCHEMA` daquela versão **não tinha `fileChecks`**. O prompt
mandava usar um campo que o schema proibia. O prompt de reparo repetia o mesmo
contrato incompleto, então a segunda tentativa não tinha como ser diferente da
primeira.

As quatro faces — **schema estrito, parser, prompt principal e prompt de
reparo** — agora dizem a mesma coisa, e um teste prende cada uma delas.

Uma consequência do modo estrito: **todo campo é obrigatório**, então um campo
não afirmado chega como `null` (`"expectText": null` ao lado de
`"expectBytesHex"`). O parser lê `null` exatamente como lê uma chave ausente —
sem isso, a única forma que o schema permite seria recusada como "must be a
string".

Verificado contra o binário real: `codex-cli 0.153.4` aceitou o schema com
`fileChecks`, encaminhou em `strict: true` sem nenhum problema, e a decisão
voltou por `--output-last-message` e foi **aceita pelo parser do aplicativo**.

## 5. Resultado

O mesmo cenário, com o supervisor usando o mecanismo:

```
run status        : DONE
orchestrator calls: 1
worker calls      : 1
done-gate         : passed
```

Num workspace **sem nenhuma verificação cadastrada**.

## 6. O que ainda depende do Windows

Tudo acima foi exercitado neste ambiente Linux, com git real, sistema de
arquivos real e o laço real — 22 testes cobrindo os desfechos, os limites e o
laço inteiro, mais 9 prendendo o contrato de decisão. A falha de leitura é exercitada de duas formas: um arquivo usado
como pasta (`ENOTDIR`) e um arquivo sem permissão de leitura (`EACCES`) — este
último só significa alguma coisa fora do root, e é assim que roda na CI Linux.

**Não executei o teste no seu Windows.** O que muda lá: separadores de
caminho, resolução de symlink e o comportamento de `realpath` em junctions. O
código de identidade de pasta já trata disso e tem testes para os dois
sistemas, mas isso é argumento, não execução.

O teste que decide continua sendo o seu `hello.txt`.
