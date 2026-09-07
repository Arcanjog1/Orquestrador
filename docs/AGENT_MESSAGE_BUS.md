# O barramento de mensagens entre agentes

Como o Codex e o Claude trocam mensagens sem ninguém no meio, e como o
aplicativo passa a saber o que está acontecendo enquanto isso.

Referência técnica: [block/buzz](https://github.com/block/buzz), commit
`3c7f288`, Apache-2.0. O que foi aproveitado e o que foi deliberadamente
deixado de fora está no fim deste documento.

---

## O problema que isto resolve

O laço já era automático antes desta sessão. O usuário enviava um objetivo, o
`OrchestrationService` chamava o Codex, recebia uma decisão, delegava ao
Claude, coletava evidência, verificava e voltava ao Codex. Ninguém copiava
prompt nenhum.

O que **não** existia era qualquer registro dessa conversa. Uma delegação era
uma chamada de função: se o worker não respondesse, não havia nada para olhar,
e a janela dizia *"executando automaticamente"* pelo tempo que isso durasse —
até uma hora, que é o limite rígido.

Duas ausências, então:

1. **A troca não deixava rastro.** "A mensagem foi enviada" e "o trabalho foi
   feito" eram indistinguíveis, porque nenhum dos dois era um fato registrado.
2. **A execução não era observável.** Um processo travado e um processo
   trabalhando pareciam a mesma coisa.

---

## O que o barramento é — e o que ele não é

É uma **fronteira de comunicação**. Aceita uma mensagem, persiste antes de
qualquer um poder agir sobre ela, entrega a exatamente um destinatário por vez,
e sabe — a cada instante — se aquela mensagem foi apenas aceita, entregue de
fato, iniciada, concluída ou abandonada.

**Não é um segundo motor de orquestração.** Ele não sabe o que é uma delegação,
quando uma execução terminou, ou qual worker deve receber o quê. O
`OrchestrationService` decide tudo isso e continua sendo o único que decide:
um laço, um DoneGate. Nada no laço lê uma mensagem de volta para escolher o
próximo passo — isso seria uma segunda fonte de verdade para o estado do run, e
existe uma.

**Não é uma segunda fonte de verdade.** A tabela `runs` responde "como vai a
execução". As linhas de `agent_messages` respondem "o que foi dito, para quem,
e chegou" — outra pergunta, e a que antes não tinha resposta.

Se algum dia aparecer neste arquivo uma regra sobre *o que acontece a seguir*,
ela está no arquivo errado.

```
┌──────────────────────────────────────────────────────────┐
│                    AI ORCHESTRATOR                       │
│                                                          │
│   UI · Projetos · Conversas · Equipes                    │
│                      │                                   │
│         ┌────────────┴────────────┐                      │
│         ▼                         ▼                      │
│   run:activity              run:message                  │
│   (efêmero)                 (durável)                    │
│         │                         │                      │
│         │                  AgentMessageBus               │
│         │                  (agent_messages)              │
│         │                         │                      │
│         └────────────┬────────────┘                      │
│                      ▼                                   │
│            ORCHESTRATIONSERVICE                          │
│            decide · delega · revisa · conclui            │
│                      │                                   │
│         ┌────────────┴────────────┐                      │
│         ▼                         ▼                      │
│    CODEX (supervisor)      CLAUDE (worker)               │
│    somente leitura         executa de verdade            │
│                      │                                   │
│                      ▼                                   │
│           EVIDENCE · VERIFICATION                        │
│                      ▼                                   │
│                  DONEGATE                                │
└──────────────────────────────────────────────────────────┘
```

O barramento fica **ao lado** do laço, não dentro dele.

---

## Por que é local

O Buzz roteia o tráfego dos agentes por um relay Nostr, com Postgres e Redis
atrás. Faz sentido: o Buzz é um produto hospedado e multi-inquilino, onde os
agentes e as pessoas estão em máquinas diferentes.

Nada disso é verdade aqui. Os dois agentes são processos filhos deste
aplicativo, neste computador, falando por stdio. A menor coisa que entrega o
**mesmo comportamento** — ordem durável, um item em voo por worker, confirmação
de recebimento, prazos, repetição, deduplicação, recuperação — é uma tabela e
uma classe.

Então é isso que é. **Sem relay, sem broker, sem porta, sem serviço, sem nada
para o usuário instalar ou configurar.** O usuário abre o `.exe`.

---

## O contrato

`src/bus/message-types.ts`.

Cada mensagem carrega: `messageId`, `runId`, `conversationId`, `iteration`,
`stepId`, `invocationId`, `senderAgentId`, `recipientAgentId`, `messageType`,
`payload`, `status`, `correlationId`, `causationId`, `dedupeKey`, `attempts`,
`leaseExpiresAt`, `availableAt`, `failureReason`, `createdAt`, `updatedAt`.

### Tipos

`USER_OBJECTIVE` · `ORCHESTRATOR_DECISION` · `DELEGATION` · `WORKER_STARTED` ·
`WORKER_PROGRESS` · `WORKER_RESULT` · `EVIDENCE_READY` ·
`VERIFICATION_RESULT` · `HUMAN_APPROVAL_REQUIRED` ·
`HUMAN_APPROVAL_RESOLVED` · `RUN_COMPLETED` · `RUN_FAILED` · `RUN_CANCELLED`.

`WORKER_PROGRESS` **não é durável**. Uma linha por batimento inflaria o
histórico e não diria a um leitor futuro nada que a timeline já não mostre.
Progresso viaja pelo canal efêmero (`run:activity`); o que fica é o resumo, na
linha de invocação que já existia.

### Pedido e aviso

A distinção sobre a qual a fila inteira é construída:

- Um **pedido** é endereçado a alguém que deve uma resposta. É entregue,
  emprestado, confirmado e concluído. Hoje: `DELEGATION` e
  `HUMAN_APPROVAL_REQUIRED`.
- Um **aviso** registra que algo aconteceu. Ninguém deve nada por ele; é final
  no instante em que é escrito. Todo o resto.

Isto não é cosmético. Se avisos ficam na fila como `pending`, toda execução
bem-sucedida termina com uma pilha de mensagens que nada concluiu — e o
fechamento do run as marca como `cancelled`. Uma execução perfeita passaria a
se ler, no próprio histórico, como uma execução abortada. `pending` tem que
significar *"alguém ainda deve uma resposta"*, ou não significa nada.

*(Este era um defeito real do primeiro desenho. O E2E o encontrou.)*

---

## As garantias

### Persistir antes de entregar

Uma mensagem é uma linha comprometida antes de qualquer destinatário poder
vê-la. Uma queda entre publicar e entregar deixa uma linha `pending`, não uma
instrução perdida.

### No máximo um em voo por (execução, destinatário)

Um worker nunca recebe duas coisas ao mesmo tempo, então uma repetição não pode
correr com o original. Guardado como escopos estruturados, nunca como texto
analisado — a primeira versão remontava a chave a partir da string, errava o
separador, e desabilitava a proteção enquanto ainda reportava "ocupado". Uma
chave que só é construída, nunca desmontada, não falha assim.

### Publicação idempotente

`dedupe_key` é `UNIQUE`. Publicar duas vezes a mesma mensagem lógica devolve a
primeira linha em vez de pedir ao worker que faça o trabalho de novo. É isto
que torna seguro um run em recuperação republicar o que acredita ter enviado.

### Prazos, não esperanças

A entrega toma um *lease* com prazo. Um worker que morre sem dizer nada deixa
um lease vencido — um fato que a varredura converte em outra tentativa ou em
uma carta morta com motivo. O que nunca acontece é a execução esperar para
sempre.

O prazo tem de ser maior que o turno legítimo mais longo, ou um worker lento e
saudável é declarado morto. O Buzz deriva o mesmo número do mesmo jeito
(`max_turn_duration + buffer`), pela mesma razão.

### Nada é descartado em silêncio

Repetições são limitadas. O limite é `dead` — um estado com motivo anexado, não
um `DELETE`. Um resultado perdido em silêncio é exatamente a falha que esta
tabela existe para tornar impossível.

E uma falha que outra tentativa não conserta — uma permissão recusada, uma
credencial rejeitada, saldo zerado — **não é repetida**. Cada tentativa pode
custar dinheiro e não mudaria nada.

### O que não é repetido

A reentrega reenvia uma *mensagem*, o que é seguro. Ela **não** reexecuta o
efeito colateral que o destinatário produziu, e não deve ser usada como se
reexecutasse. Uma escrita não idempotente nunca é repetida sem reconciliar o
estado real antes — e essa reconciliação é trabalho do EvidenceCollector e do
Verifier, que rodam depois de toda delegação de qualquer forma.

Por isso um run interrompido pelo fechamento do aplicativo tem suas mensagens
pendentes **encerradas, não reentregues**. Reenviar uma instrução que já pode
ter escrito um arquivo é precisamente o que não se faz.

### Os seis estados

| status      | significa                                                  |
|-------------|------------------------------------------------------------|
| `pending`   | aceita pelo barramento, persistida, ninguém a tem ainda    |
| `leased`    | entregue a um destinatário; o lease tem prazo              |
| `started`   | o destinatário confirmou e começou o trabalho real         |
| `completed` | o destinatário terminou e o resultado está persistido      |
| `failed`    | esta tentativa falhou; pode ser repetida                   |
| `dead`      | tentativas esgotadas — guardada, nomeada, nunca descartada |
| `cancelled` | a execução foi cancelada antes desta mensagem terminar     |

"Enviada" deixou de poder parecer "concluída".

---

## Observabilidade: o `hello.txt` que ficou parado

O relato do usuário não foi um erro. Foi uma janela dizendo *"executando
automaticamente"* e nunca dizendo mais nada.

A causa não é uma só, e as quatro anteriores já tinham sido corrigidas na
sessão passada (envelope do CLI, evidência, roteamento, prompt do supervisor).
O que restava era estrutural: **o aplicativo não tinha como ver dentro do
turno.**

`claude -p --output-format json` não imprime nada até terminar. Durante uma
execução longa não havia byte nenhum para observar, então não havia sinal
nenhum para mostrar.

Três mudanças:

**1. O silêncio ganhou prazo próprio.** `ProcessManager` aceita
`idleTimeoutMs`, reiniciado por qualquer byte em stdout ou stderr. Responde uma
pergunta diferente de `timeoutMs`: não *"isto demorou demais?"*, que uma
refatoração grande e legítima reprova, mas *"ainda está acontecendo alguma
coisa?"*, que só um processo travado reprova. Qual dos dois prazos foi cruzado
fica registrado (`trace.idleTimedOut`), porque *"40 minutos de trabalho"* e
*"40 minutos de silêncio"* pedem reações opostas.

**2. O turno passou a ser transmitido.** Quando o build oferece, o adapter
envia `--output-format stream-json --verbose`. A última linha do stream é o
mesmo envelope que o `json` imprimiria sozinho, e é lida pelo **mesmo** parser
— então `is_error`, `permission_denials` e o id de sessão continuam
significando exatamente o que a sessão anterior fez com que significassem. Um
build sem streaming é deixado em paz, e sem limite de silêncio: limitar
silêncio onde o silêncio é o comportamento documentado mataria execuções
saudáveis.

**3. A atividade ganhou forma legível.** `ActivityMonitor` guarda quando a
invocação começou, quando fez algo pela última vez, e em que ferramenta está —
para a tela dizer *"executando há 4m · ferramenta: Write"* em vez de um
spinner. Apenas **nomes** de ferramenta: um argumento carrega o arquivo sendo
escrito e o comando sendo rodado, e isso não pode chegar a uma linha de status
nem a um log.

O silêncio é classificado como `no-activity`, que deliberadamente não é
`timeout`, e é **mecânico**: nenhum modelo mais forte destrava um processo
parado. É o mesmo reflexo removido para permissões recusadas na sessão
passada, errado aqui pela mesma razão.

---

## O que a interface mostra

No painel de atividade, enquanto uma execução acontece:

- **Agora** — há quanto tempo o agente trabalha, há quanto tempo está em
  silêncio (só quando é longo o bastante para significar algo, e em âmbar
  depois de metade do prazo), a ferramenta em execução, e **Cancelar**.
- Quando o runtime não informa progresso, a tela diz exatamente isso, e não
  *"ocioso"*. Afirmar que um agente não está fazendo nada porque não
  conseguimos ver é o mesmo erro com outra tipografia.
- Delegações sem resposta são contadas; uma que esgotou as tentativas aparece
  em vermelho.
- **Equipe** — cada membro com nome, papel, conexão, estado, tarefa atual e
  duração. `offline` (conexão não autenticada) nunca é confundido com `idle`
  (esperando trabalho): um é um problema para resolver, o outro não é nada.

Tudo isso no painel que já existia. Há **uma** interface para este produto, e
uma segunda mostrando a mesma execução seria pior do que uma primeira melhor.

---

## Buzz: o que foi aproveitado

Arquivos estudados no commit `3c7f288`:

| Arquivo | O que ensinou |
|---|---|
| `ARCHITECTURE.md` | O relay como fonte única, a hierarquia de crates, o modelo de eventos por `kind` |
| `crates/buzz-acp/src/queue.rs` | A máquina de estados da fila: um em voo por escopo, prazo de expiração, recuo exponencial com *jitter*, carta morta após N tentativas, deduplicação |
| `crates/buzz-acp/src/acp.rs` | `session_prompt_with_idle_timeout` — a separação entre prazo de silêncio e prazo absoluto |
| `crates/buzz-acp/src/pool_lifecycle.rs` | Estados de acordar/pronto/falhou com espera crescente até um teto |
| `crates/buzz-acp/README.md` | A configuração real dos adapters ACP e sua autenticação (ver `ACP_AND_SUBSCRIPTION_POLICY.md`) |

Ideias aproveitadas, reescritas do zero em TypeScript sobre o SQLite existente:

- fila por escopo com no máximo um item em voo;
- prazo de posse que expira e é varrido;
- repetição com recuo exponencial e ruído, com teto e carta morta;
- deduplicação por chave;
- **prazo de silêncio separado do prazo absoluto** — a ideia mais valiosa para
  o defeito que o usuário relatou.

## O que foi deliberadamente **não** copiado

- **Nostr.** Nem o protocolo, nem os *kinds*, nem as chaves, nem as assinaturas
  Schnorr. Implementar Nostr porque o Buzz usa Nostr seria copiar a
  infraestrutura de um problema que não é o nosso.
- **Relay, WebSocket, Postgres, Redis.** Dois processos filhos na mesma máquina
  não precisam de um broker entre eles.
- **O pool de 1–32 subprocessos.** Para uso local a concorrência começa
  conservadora: um worker faz uma coisa por vez.
- **Interface.** Nenhum pixel, nenhum componente, nenhum ativo. A identidade
  visual do AI Orchestrator é a que já existia.
- **Marcas e logotipos.** Nada.
- **Código.** Nenhuma linha. Ver `THIRD-PARTY-NOTICES.md`.

Interoperabilidade com o Buzz, se um dia for desejável, é um adapter opcional e
separado — não uma dependência do modo local.

---

## Migração

Migração `11`, `agent-messages`. Aditiva: cria `agent_messages` e cinco
índices, e não toca em nenhuma tabela existente. Uma instalação que sobe desta
versão mantém todas as suas contas, projetos, conversas e execuções.

---

## Testes

| Arquivo | O que prova |
|---|---|
| `tests/agent-message-bus.test.ts` | 20 casos, um por modo de falha: idempotência, um em voo, worker morto, recuo, carta morta, cancelamento, recuperação após queda, resposta vazia, pedido × aviso |
| `tests/agent-activity.test.ts` | 19 casos: processos reais que ficam em silêncio, que continuam falando, que nunca começam; o leitor do stream; a frase na tela |
| `tests/agent-exchange-e2e.test.ts` | 8 casos: a troca de duas pontas de ponta a ponta, o `hello.txt` real com evidência e verificação, ferramenta recusada, cancelamento, interrupção, liveness |
| `tests/desktop-adapters.test.ts` | O caminho com streaming preserva o contrato do envelope; um build sem streaming não recebe a flag; silêncio vira `no-activity` |
| `tests/desktop-team.test.ts` | Duas identidades em duas conexões; `offline` ≠ `idle`; delegação sem resposta é contada |
| `apps/desktop/tests/electron-integration.mjs` | Todo canal de evento do contrato é alcançável do renderer e devolve um cancelamento que funciona |

Agentes roteirizados provam o laço, o contrato e os portões. Não provam nada
sobre um fornecedor: só uma chamada real prova isso, e isso é um portão humano.
