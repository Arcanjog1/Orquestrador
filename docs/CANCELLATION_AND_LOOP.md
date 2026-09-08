# Cancelar, e parar de andar em círculos

## 1. Causa comprovada de cada defeito

### "pare tudo" virou uma nova run

`ChatService.sendMessage` iniciava uma run para **toda** mensagem, sem exceção.
As duas frases da pessoa — *"pare tudo q esteja fazendo"* e *"pare oq o claude
esta fazendo"* — viraram objetivos: o supervisor foi planejar como parar, e o
worker foi delegado a confirmar que tinha parado. A execução que ela queria
parar continuou.

### O botão marcava pouco

`cancel()` abortava o sinal e mandava os runners pararem — e **não escrevia
nada**. A run continuava `RUNNING` no banco até o laço alcançar um dos **três**
pontos de verificação, e no caminho até lá ainda podia começar outra delegação.

### Um resultado tardio ressuscitava a run

`setStatus` não tinha guarda. Qualquer escrita posterior — de uma fase que
terminou depois do cancelamento — podia devolver a run para `RUNNING`, ou para
`DONE`. É assim que *"Tarefa concluída e verificada"* aparecia sobre uma
execução que a pessoa tinha mandado parar.

### As etapas giravam para sempre

Nenhum caminho terminal fechava as etapas ainda `running`, e é isso que a
interface desenha como spinner. Uma run encerrada continuava mostrando
"Analisando" e "Revisando", e não dava para distinguir concluída de cancelada
de ativa.

### Os critérios citados nunca chegavam

O prompt de delegação era:

```ts
`${toolPolicyPreamble(...)}\n\n${task}`
```

`task` é o texto livre do supervisor. Os `acceptanceCriteria` da decisão
ficavam no ledger, apareciam na interface e eram checados pelo gate — e **nunca
eram enviados ao worker**. Por isso ele relatou três vezes que a instrução
citava "os critérios abaixo" e não havia lista nenhuma. Ele estava certo.

### O supervisor pedia arquivos ao worker

Não havia como o supervisor ler um arquivo. Ele pedia ao worker o conteúdo
integral dos mesmos quatro arquivos, recebia respostas truncadas, mantinha os
critérios pendentes e pedia de novo — subindo até Opus/Alto por um problema que
modelo nenhum resolveria.

### Nada percebia o círculo

O laço só parava por limite de iterações ou por `verify` estéril. Duas rodadas
com exatamente a mesma evidência seguiam adiante.

## 2. O que mudou

| Defeito | Correção |
|---|---|
| "pare" virava run | `readStopIntent` + `sendMessage` chama o cancelamento e **não cria run** |
| cancelamento não marcava | `runs.cancel_requested_at` (migração 19), escrito antes de qualquer `await` |
| resultado tardio ressuscitava | `setStatus` recusa sair de estado terminal |
| spinner eterno | `setStatus` fecha toda etapa aberta ao parar |
| critérios ausentes | `buildWorkerPrompt` envia os critérios da decisão, ou corrige o ponteiro |
| worker copiando arquivo | `fileReads`: o aplicativo abre, com orçamento e truncamento reportado |
| círculo silencioso | impressão digital da evidência; duas rodadas iguais param em `NEEDS_HUMAN` |
| relatório acumulado | delegação × execução, e "apenas lidos" |

### Cancelar não fala com modelo nenhum

`cancel()` grava a intenção, aborta o sinal, manda os runners pararem e pede ao
ambiente que encerre processos. Nenhum agente é chamado, nenhum critério é
criado, nenhuma run nasce. E a intenção é lida em **cinco** pontos do laço,
incluindo um imediatamente antes da delegação — antes de qualquer modelo ser
pago.

Sobrevive a reinício: é uma coluna, não uma variável.

### Ler não é provar

`fileReads` mostra; `fileChecks` resolve. São campos separados, e uma leitura
não aceita `criteria` — não existe forma de dizer "esta leitura prova aquilo".
Truncamento é sempre reportado, com o tamanho real ao lado.

## 3. Medido

**Miniaplicativo, ponta a ponta, workspace descartável:**

```
resultado             : DONE
tempo (app)           : 72 ms
invocações            : 2 (orquestrador 1, worker 1)
iterações             : 1
arquivos na pasta     : README.md, app.js, index.html, style.css
done-gate             : passed
etapas ainda "running": 0
critérios no prompt   : true
```

Uma delegação. Sem redundância, sem cópia de arquivo.

**Cancelamento durante uma delegação em andamento:**

```
pedido por             : mensagem no chat ("pare tudo q esteja fazendo")
runs na conversa       : 1 (nenhuma nova criada)
run apontada           : a que estava rodando
intenção marcada       : true (imediatamente)
status final           : CANCELLED
tempo até terminal     : 14 ms
chamadas ao orquestrador depois: 0
chamadas ao worker depois     : 0
etapas ainda "running" : 0
```

## 4. O que **não** foi resolvido: a iteração 12

Os quatro arquivos foram detectados; depois o worker recebeu "No files found" e
os recriou. **Não reproduzi isso e não sei a causa.** Não vou atribuí-la ao
Claude, nem a uma troca de workspace, nem a exclusão real, sem evidência.

O que mudou em volta, e que torna o cenário menos provável e menos danoso:

- **um pedido de parada não cria mais uma run**, então não há mais como uma run
  de "parar" herdar critérios de criação de arquivos;
- **o supervisor pode ler a pasta** (`fileReads`) antes de decidir recriar algo,
  em vez de depender de um relato truncado;
- **o relatório separa** o que a delegação fez do que a execução acumulou, então
  "quatro arquivos modificados" deixa de aparecer numa rodada que só leu;
- **duas rodadas sem evidência nova param**, em vez de continuarem até o limite.

Se acontecer de novo, o que preciso ver é o **Detalhes** da run: as etapas
`preflight`, `baseline` e `file-read` registram o caminho resolvido, e as
invocações registram o `cwd`. É por aí que a causa aparece.

## 5. O que ainda depende do seu Windows

Nada disto foi executado com os CLIs reais na sua máquina. O cancelamento foi
exercitado com agentes roteirizados que seguram a delegação; o comportamento de
matar um `claude.exe` ou um `codex.exe` de verdade, e o tempo que isso leva, é o
que o instalador precisa provar.
