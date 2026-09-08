# O relatório do worker

## 1. O que faltava

O supervisor roda em modo leitura, de propósito. Depois de uma delegação, a
única forma que ele tinha de saber o que aconteceu era ler um texto livre e
adivinhar — ou pedir uma verificação que podia não existir.

O aplicativo **já tinha** os fatos: o envelope do CLI, a saída do processo, as
notas de atividade, a evidência que ele mesmo coletou e as verificações que ele
mesmo rodou. Eles simplesmente nunca eram reunidos.

E havia um erro pior, que o pedido nomeou: a mensagem que aparecia na conversa
sob o nome do worker era **a tarefa enviada a ele**, sem nada dizendo qual das
duas coisas era. A resposta não aparecia em lugar nenhum.

## 2. A regra em torno da qual isto é construído

> **Relatório é declaração. Evidência é medição.**

Ficam em campos separados, aparecem sob títulos separados, e nada promove um ao
outro. O worker dizer que criou um arquivo é `declared`; o aplicativo abrir a
pasta e ver o arquivo é `evidence`. Quando os dois discordam, os dois são
reportados e a discordância é **nomeada** — um relatório que preferisse um dos
lados em silêncio valeria menos que nenhum.

Nada é inventado. Campo que a ferramenta não informou fica ausente, e ausente é
renderizado como "não informado".

## 3. Sem uma segunda chamada ao modelo

Não existe invocação cujo único trabalho seja escrever o relatório. Pedir ao
worker que escrevesse um relatório sobre o próprio relatório custaria uma
chamada e produziria **um segundo relato dos mesmos fatos** — o menos confiável,
já que é o relato da parte sendo reportada.

## 4. O que ele contém

| | |
|---|---|
| `status` | `completed`, `partial`, `blocked` ou `failed` — decidido por fatos |
| `declared` | o texto do worker, como veio |
| `evidenceFiles` | criados, modificados, removidos — do coletor, nunca da lista do worker |
| `verifications` | o que o aplicativo rodou, e o resultado |
| `deniedTools` / `awaitingApproval` | o que foi recusado e o que espera você |
| `errors` | a causa legível e as palavras do próprio CLI |
| `pending` | critérios sem prova e critérios reprovados |
| `recommendation` | o próximo passo, objetivo |
| `invocationId`, `model`, `reasoning`, `sessionId`, `outcome`, `exitCode` | de onde veio |

`blocked` é separado de `failed` de propósito: uma recusa não é o trabalho
falhando, é o trabalho não ter sido autorizado a acontecer, e as duas coisas
pedem respostas diferentes do supervisor.

## 5. Onde ele aparece

- **Na conversa**, como mensagem do worker, com resumo na primeira linha e o
  resto expansível. A tarefa enviada é uma mensagem separada, rotulada
  *"tarefa enviada"*.
- **No prompt do supervisor**, como `WORKER REPORT:` dentro do pacote de
  revisão, junto das evidências e dos critérios sem prova.
- **No banco**, em `agent_invocations.report_json` (migração 17) e como passo
  `worker-report` do run. Reabrir a conversa continua mostrando os dois.

## 6. O que ele *não* faz

Não satisfaz critério nenhum. O ledger já decidiu isso, por evidência, antes de
o relatório existir. O DoneGate não lê o relatório: continua relendo arquivo,
recolhendo evidência e reexecutando verificação por conta própria. Um relatório
dizendo "concluí" ao lado de um diff vazio produz `partial` e uma divergência
registrada — nunca um DONE.

## 7. Medido

Workspace descartável, tarefa pequena de código, agentes roteirizados:

```
resultado            : DONE
tempo total (app)    : 153 ms
invocações totais    : 2   (1 orquestrador, 1 worker)
iterações            : 1
done-gate            : passed
preflight            : ok
relatório persistido : true
```

Duas invocações — as mesmas de antes do relatório existir.
