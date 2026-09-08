# O custo real de uma tarefa pequena — medido, não suposto

A reclamação: *"o teste de criar hello.txt com 6 bytes está demorando demais"*.

A primeira resposta honesta era que **ninguém conseguia dizer onde o tempo
ia**. O laço registrava *que* planejou, delegou, coletou evidência e verificou,
e nada sobre quanto cada coisa levou. Otimizar contra isso seria otimizar
contra um palpite — que é exatamente o que você pediu para não acontecer:
*"Não presuma a causa sem medir."*

Então primeiro veio a medição.

---

## 1. Como se mede agora

A migração 15 acrescenta `run_steps.duration_ms`: cada etapa registra quanto
tempo passou desde o fim da etapa anterior. As durações de uma execução somam a
execução, então nenhum trecho pode se esconder entre duas delas.

Duas etapas que **não existiam** foram criadas, porque eram justamente o tempo
que ninguém via:

| etapa | o que é |
|---|---|
| `startup` | resolver o ambiente, provisioná-lo, montar os runners |
| `capabilities` | perguntar a cada CLI de worker o que ele aceita (`--help`) |

Isso aparece em três lugares: em **Detalhes**, no arquivo de **Exportar
diagnóstico** (seção *"Onde o tempo foi"*, ordenada da maior fatia para a
menor) e no banco, para quem quiser consultar.

## 2. O que a medição encontrou

Execução real do laço, com agentes falsos (para isolar o custo do aplicativo) e
git, verificação e DoneGate reais. Objetivo: criar `hello.txt` com um texto
exato.

**Antes:**

```
status               DONE
iterações            2
invocações de CLI    3        Codex planeja · Claude executa · Codex revisa
execuções do check   3        laço (it. 1) · laço (it. 2) · DoneGate
sobrecarga do app    309 ms
```

A conta que importa não é a de milissegundos. Com CLIs reais, **cada invocação
custa de 10 a 60 segundos**. Três invocações para um arquivo de 6 bytes são
30 a 180 segundos, e a terceira delas existia para pedir a um modelo que
concordasse com um resultado que o **aplicativo já tinha provado sozinho**:
ele mesmo coletou a evidência e ele mesmo rodou as verificações.

## 3. O caminho rápido

Não é outro motor de orquestração. É uma condição dentro do laço existente.

Quando **tudo** isto vale, o laço vai direto ao DoneGate:

- o worker acabou de rodar e não falhou;
- a evidência que o **aplicativo** coletou mostra que a árvore mudou;
- o orquestrador pediu verificações, todos os ids resolveram, e **todas
  passaram**;
- todo critério de aceite daquela decisão está satisfeito no ledger.

**Depois:**

```
status               DONE
iterações            1
invocações de CLI    2        Codex planeja · Claude executa
execuções do check   2        laço · DoneGate
sobrecarga do app    218 ms
```

| | antes | depois | |
|---|---|---|---|
| invocações de CLI | 3 | **2** | −33% |
| execuções da verificação | 3 | **2** | −33% |
| iterações | 2 | **1** | −50% |
| sobrecarga do aplicativo | 309 ms | **218 ms** | −29% |

Com CLIs reais, o que sai é uma ida e volta inteira ao Codex.

## 4. O que **não** foi enfraquecido

Esta é a parte que importa mais do que a economia.

**O DoneGate continua idêntico.** Ele é a autoridade no caminho rápido
exatamente como é no longo, continua independente, e continua **reexecutando
cada verificação do zero** contra evidência recém-coletada. O que foi pulado
não é uma checagem — é pedir a um modelo que concorde com algo que já está
provado.

**Uma rejeição do gate não termina a execução.** Ela vira feedback e o laço
continua normalmente, com o orquestrador sendo consultado como sempre. O
caminho rápido não pode transformar uma falha em sucesso; no pior caso ele
custa uma avaliação de gate desperdiçada, **uma vez por execução**.

**Ele nunca dispara** quando a verificação falhou, quando nada mudou na árvore,
quando a delegação não trouxe verificação nenhuma, ou quando algum critério
ficou sem ser resolvido pelo próprio aplicativo. A palavra do worker nunca
basta: em `tests/fast-path.test.ts`, um worker que diz *"não fiz nada, mas digo
que fiz"* não chega nem perto do gate.

Desligável por opção (`fastPath: false`), que é o que os testes do caminho
longo usam.

## 5. O que ainda não foi otimizado, e por quê

**A sonda de capacidades** (`claude --help` por worker) é um processo por
execução. É barata (1 ms de sobrecarga do app aqui) mas é um processo real com
CLIs reais. Dá para cachear por versão do executável; não foi feito nesta
rodada porque um cache errado faz o roteador escolher um modelo que o CLI não
aceita, e isso custa mais do que economiza.

**A segunda coleta de evidência** dentro do gate é deliberada e fica. É o que
faz o gate ser independente.

**Modelos leves** já são o padrão: `assessTask` começa em `FAST` e só sobe
quando um sinal na tarefa pede. E falha mecânica — `provider-error`,
`no-activity`, permissão, autenticação, timeout — **não escala mais** o
modelo, o que foi corrigido na rodada anterior: nenhum modelo desfaz uma
exceção.

## 6. Reproduzir

`tests/fast-path.test.ts` conta invocações e execuções do comando de
verificação, e falha se qualquer um dos números subir. O número na tabela acima
é o que esse teste afirma.
