# Handoff — central de agentes

Estado ao fim da quarta sessão: a arquitetura de comunicação, inspirada no Buzz.

## Baseline

| | |
|---|---|
| Repositório | `Arcanjog1/Orquestrador` (público) |
| Branch desta sessão | `claude/ai-orchestrator-buzz-arch-vblrau` |
| HEAD do início | `2e06ae5` (ponta de `claude/ai-orchestrator-reorientacao-ytlkw0`) |
| Branch padrão real | `claude/new-session-3am7mo` — **não é `main`, e `main` não existe** |
| Instalador | a pre-release `desktop-dev-*` **mais recente** desta branch, em [Releases](https://github.com/Arcanjog1/Orquestrador/releases) |

Sem reset, sem merge, sem force-push, sem apagar branch. A branch desta sessão
saiu de `2e06ae5`, que é a ponta real do trabalho — a branch padrão do
repositório estava onze commits atrás e teria descartado tudo desde a fase
Electron.

---

# Quarta sessão — a troca automática, e a janela que ficava parada

Documentos novos: `docs/AGENT_MESSAGE_BUS.md` (a arquitetura) e
`docs/ACP_AND_SUBSCRIPTION_POLICY.md` (a decisão sobre ACP e assinaturas).

## O que já funcionava, e o que faltava

O laço **já era automático** antes desta sessão: um objetivo, o Codex decide, o
Claude executa, evidência, verificação, o Codex revisa, DoneGate. Ninguém
copiava prompt.

O que faltava eram duas coisas, e nenhuma delas era o laço:

1. **A troca não deixava rastro.** Uma delegação era uma chamada de função. Se
   o worker não respondesse, não havia nada para olhar.
2. **A execução não era observável.** `--output-format json` não imprime nada
   até terminar, então um processo travado e um trabalhando eram idênticos daqui
   — pelo tempo que o limite rígido permitisse, que é uma hora. **Era isto que
   produzia a janela em "executando automaticamente".**

## O barramento de mensagens

`src/bus/` + migração `11` (`agent_messages`). Uma **fronteira de comunicação**,
não um segundo motor: o `OrchestrationService` continua decidindo tudo, um laço,
um DoneGate, e nada lê uma mensagem de volta para escolher o próximo passo.

- persistir antes de entregar;
- no máximo um em voo por (execução, destinatário);
- publicação idempotente por `dedupe_key` (UNIQUE no banco);
- *lease* com prazo — um worker que morre calado deixa um prazo vencido, que a
  varredura converte em nova tentativa ou carta morta **com motivo**;
- recuo exponencial com ruído, limitado; uma falha que outra tentativa não
  conserta (permissão recusada, credencial rejeitada) **não** é repetida;
- nada é descartado em silêncio: o fim da linha é `dead`, não um `DELETE`;
- um run interrompido tem as mensagens pendentes **encerradas, não
  reentregues** — reenviar uma instrução que já pode ter escrito um arquivo é
  exatamente a repetição não idempotente que não se faz.

**Sem relay, sem broker, sem porta, sem Docker, sem servidor.** O Buzz usa
Nostr com Postgres e Redis porque os agentes dele estão em outra máquina; aqui
os dois são processos filhos deste aplicativo. A menor coisa com o mesmo
comportamento é uma tabela.

**Um defeito real que o E2E encontrou:** no primeiro desenho, avisos ficavam na
fila como `pending`, então fechar o run os marcava `cancelled` — e uma execução
perfeita se lia, no próprio histórico, como abortada. Agora `pending` significa
o que diz: *alguém ainda deve uma resposta*. Só `DELEGATION` e
`HUMAN_APPROVAL_REQUIRED` são pedidos; o resto é aviso, final quando escrito.

## A janela parada

1. **`idleTimeoutMs`** no `ProcessManager`, reiniciado por qualquer byte.
   Responde *"ainda está acontecendo alguma coisa?"*, que só um processo travado
   reprova — diferente de `timeoutMs`, que uma refatoração legítima reprova.
   Qual prazo foi cruzado fica em `trace.idleTimedOut`, porque "40 minutos de
   trabalho" e "40 minutos de silêncio" pedem reações opostas.
2. **`--output-format stream-json --verbose`** quando o build oferece. A última
   linha do stream é o mesmo envelope que o `json` imprimiria, lida pelo
   **mesmo** parser — `is_error`, `permission_denials` e o id de sessão
   continuam significando o que a sessão passada fez com que significassem. Um
   build sem streaming fica em paz, e sem limite de silêncio.
3. **`ActivityMonitor`** — tempo decorrido, última atividade, ferramenta em
   execução. Só **nomes** de ferramenta, nunca argumentos.

Silêncio vira `no-activity`, que não é `timeout`, e é **mecânico**: nenhum
modelo mais forte destrava um processo parado. Mesmo reflexo removido para
permissões recusadas na sessão passada.

## Na tela

No painel que já existia — não há uma segunda interface:

- **Agora**: tempo de execução, silêncio (em âmbar depois de metade do prazo),
  ferramenta atual, **Cancelar**. Quando o runtime não informa progresso, diz
  isso, e não "ocioso".
- Delegações sem resposta contadas; carta morta em vermelho.
- **Equipe**: cada membro com conexão, estado, tarefa e duração. `offline`
  (não autenticado) nunca confundido com `idle` (esperando trabalho).

## A decisão sobre ACP

**Não é o caminho padrão.** `docs/ACP_AND_SUBSCRIPTION_POLICY.md` tem o
raciocínio inteiro e as citações. Em resumo:

- o `README` do `buzz-acp` documenta os dois adapters com **chave de API paga**
  (*"use an OpenAI API key, not a ChatGPT subscription"*);
- `claude-agent-acp` é construído sobre o Claude Agent SDK, cuja documentação
  diz que **um produto de terceiros não deve oferecer login claude.ai nem os
  limites da assinatura sem aprovação prévia**, e indica chave de API;
- o `codex-acp` a montante **anuncia** login ChatGPT como método ACP, então
  desse lado o caminho existe.

O padrão continua sendo os **CLIs oficiais** como processos filhos, cada conta
no seu diretório isolado. O que o ACP daria de útil já foi obtido sem ele:
sessões (`--resume`), cancelamento, permissões e — o que faltava — progresso
durante o turno (`stream-json`).

## Testes

| Suíte | Resultado |
|---|---|
| Root (`npm test`) | **572 passando**, 2 pulados (eram 517) |
| Electron (`npm run desktop:test`) | **28 passando** (eram 27) |
| Typecheck (4 projetos) | limpo |

Novos: `tests/agent-message-bus.test.ts` (20), `tests/agent-activity.test.ts`
(19), `tests/agent-exchange-e2e.test.ts` (8), mais casos em
`desktop-adapters`, `desktop-team` e a integração Electron.

Os dois E2E que o pedido nomeia:

- **conversa**: objetivo → Codex → Claude 1 → revisão → Claude 2 → revisão →
  DONE, com a troca inteira conferida no registro;
- **código**: `hello.txt` escrito de verdade, achado pelo EvidenceCollector e
  conferido byte a byte por uma verificação que o aplicativo reexecuta.

DoneGate não foi afrouxado e nenhum teste foi removido. *(A primeira versão do
E2E de código falhou porque eu não tinha registrado verificação nenhuma — o
portão recusou, corretamente. A correção foi registrar a verificação, não
afrouxar o portão.)*

---

# Terceira sessão — os quatro defeitos do `hello.txt`

## O que aquela sessão corrigiu

O teste real do usuário — *"crie hello.txt com o texto pronto"* — falhou assim:
Claude saiu com código 0, o aplicativo não coletou progresso nenhum, o
roteamento escalou FAST/LOW até Opus/MAX, e a execução terminou BLOCKED com o
Codex dizendo que a sessão era somente leitura e não havia como elevar.

Eram **quatro defeitos em série**, cada um capaz de produzir esse fim sozinho.

### 1. O adapter jogava fora o relatório do próprio CLI

`claude -p` sai com **código 0** e marca `is_error` / `permission_denials`
quando a execução em si falhou — uma ferramenta recusada, um limite de turnos,
um erro durante a execução. O adapter lia só o campo `result`. Uma escrita
recusada chegava ao loop como *"terminou limpo e não mudou nada"*.

Agora o envelope `--output-format json` é lido inteiro: `subtype`, `is_error`,
`permission_denials`. Um envelope que diz que falhou **é** uma falha, seja qual
for o código de saída — `exitCode` vira 1 para que todo teste a jusante a
enxergue. As ferramentas recusadas são nomeadas (só `tool_name`; nunca os
argumentos, que podem conter texto do usuário).

### 2. A evidência respondia "nada mudou" quando na verdade não sabia

`GitEvidenceCollector` tratava qualquer falha do git como "sem alterações".
Três casos reais viravam a mesma resposta:

- pasta simples, nunca `git init`-ada;
- git que não executa nesta máquina;
- arquivo criado mas **ignorado** pelo `.gitignore` — invisível ao `git status`
  por definição.

Agora `probeRepository()` separa *"não é um repositório"* de *"o git não pôde
ser executado"*, e existe `src/git/workspace-snapshot.ts`: uma varredura
limitada da pasta (fingerprint `tamanho:sha256`, pula `.git`, `node_modules`,
`dist*`, `build`, `out`, `release`, `coverage`, `.venv`, `target`, `vendor`…,
teto de 20 000 arquivos, não segue symlink, **avisa quando truncou**). Ela roda
**também dentro de repositórios**, para que um arquivo ignorado seja notado.

A evidência agora carrega `source: 'git' | 'filesystem'` e `evidenceProblem`. O
prompt do orquestrador recebe `WARNING: …` e a instrução explícita de tratar
"nenhuma alteração" como *"não foi possível observar"*, nunca como prova.

Nenhum arquivo é adicionado ao Git para produzir evidência.

### 3. O roteamento escalava por causa das palavras da própria falha

`assessTask` lia a delegação inteira. A segunda delegação do Codex mencionava
"permissão" e "diagnóstico" — porque a primeira tinha sido recusada — e o
roteador leu isso como uma tarefa de segurança e foi para MAX/MAX.

Agora `workLines()` separa o trabalho pedido das linhas que são proibições
("não…", "nunca…", "do not…") ou relato de falha, e um sinal que só aparece no
relato de falha não conta. E `isMechanicalFailure` consulta `result.failure`
**antes** do atalho de saída 0: uma permissão recusada é mecânica, então
nenhum modelo mais caro é gasto nela. Segurança de verdade continua subindo;
ausência real de progresso continua escalando.

### 4. O orquestrador se achava obrigado a ver o arquivo

O Codex roda `--sandbox read-only` de propósito. Ele bloqueava por não
conseguir ler o arquivo — uma limitação **do supervisor**, não do worker. O
prompt agora diz, com todas as letras, que ele não inspeciona o workspace, não
precisa, e que EVIDENCE/VERIFICATION são a fonte da verdade: *"Never answer
'blocked' merely because you cannot read a file."*

### Além disso

- **Workspace verificado antes da primeira chamada paga**: caminho vazio,
  inexistente, não-diretório, ou sem permissão de escrita (probe de escrita
  real — no Windows os bits não respondem a pergunta). Só para ambiente
  `local`: o caminho de um ambiente remoto existe lá dentro, nunca aqui.
  Nunca há fallback silencioso para `process.cwd()`.
- **Falhas classificadas**: `tool-permission-denied`, `approval-required`,
  `empty-response`, `workspace-invalid`, `evidence-unavailable`, além das que
  já existiam.
- **Diagnóstico visível na janela**: Detalhes mostra a falha por extenso em
  português, as ferramentas recusadas e o diretório de trabalho. Sem
  PowerShell, sem log de terminal.
- **Nada de contorno**: `bypassPermissions`, `--dangerously-skip-permissions`,
  sandbox desativado e elevação de administrador **não** foram usados. O modo
  continua `--permission-mode acceptEdits`.

## O que existe hoje

### Backend

- `AgentProvider extends AgentRunner` — a fronteira. Um loop, um DoneGate.
- Adapters: Codex CLI, Claude Code CLI, OpenAI Responses API, Anthropic
  Messages API.
- `ProviderCapabilities.toolExecution` — a regra que impede "a API disse que
  editou" virar "arquivo alterado".
- `ConnectionService` — conexões CLI e API, credencial criptografada em tabela
  própria, `api_enabled` começando em 0.
- Equipes com N workers (`slot`, `label`), delegação por `workerId` validado.
- Projetos de conversa (`environment = 'conversation'`): sem pasta, sem git,
  sem processo, em diretório vazio próprio.
- `BudgetLedger` — verificação **antes** da chamada.
- Sessões: `claude -p --resume <id>`, id lido do envelope JSON, chaveado por
  (conversa × conexão), com recuperação quando a sessão expirou.

### Interface

- **Conexões** (Configurações → Contas), **Equipe** com N workers, **Novo
  projeto** (Conversa · Código · Nuvem), **Limites de gasto** por projeto.
- **Detalhes da execução**: por invocation — provider, tipo de conexão, worker,
  modelo, raciocínio, tokens, custo, falha classificada, **ferramentas
  recusadas** e **diretório de trabalho**.

### Testes

| Suíte | Resultado |
|---|---|
| Root (`npm test`) | **517 passando**, 2 pulados |
| Electron (`npm run desktop:test`) | **27 passando** |
| Typecheck (4 projetos) | limpo |
| Windows CI | com NSIS e probes reais de Codex, Claude e Git |

`tests/evidence-and-permissions.test.ts` (13 casos) e dois E2E novos em
`tests/orchestration-modes.test.ts`: um cria `hello.txt` numa **pasta sem git**
e confere os seis bytes `70 72 6F 6E 74 6F` (sem BOM, sem newline); o outro é o
caminho da escrita recusada — para em `NEEDS_HUMAN` após **uma** tentativa, com
`failureKind === 'tool-permission-denied'`.

DoneGate não foi afrouxado e nenhum teste foi removido.

## Human gates

### 1. `LOCAL_REAL_AUTH_TEST_PENDING`

Não existem contas Codex/Claude legítimas no CI, e este ambiente não tem
Windows. O roteiro:

1. baixar o `AI-Orchestrator-Setup.exe` da pre-release `desktop-dev-*` mais
   recente em [Releases](https://github.com/Arcanjog1/Orquestrador/releases) e
   instalar por cima (o SmartScreen avisa: o build não é assinado);
2. abrir o aplicativo — a base é migrada no lugar, nada é reautenticado;
3. Configurações → Contas: confirmar Codex e Claude conectados;
4. Equipe: orquestrador = Codex, Worker 1 = Claude;
5. escolher um projeto **de código** com pasta local;
6. enviar *"crie hello.txt com o texto pronto"*;
7. se falhar de novo, abrir **Detalhes**: a falha classificada, as ferramentas
   recusadas e o diretório de trabalho estarão ali. É essa tela que responde
   "por que nada mudou?".

Sem PowerShell. Sem instalar Node. Sem copiar credencial. Sem servidor. Sem
API paga.

### 2. `API_E2E_VERIFIED` — não declarado

Nenhuma chamada real a `api.openai.com` ou `api.anthropic.com` foi feita.

## Limitações que ficam, ditas na cara

**Streaming.** `ProviderCapabilities.streaming` é `false` nos dois adapters de
API, e isso é honesto.

**Listar sessões existentes.** Nenhum dos CLIs oferece listagem não
interativa. O app oferece as sessões que ele mesmo iniciou.

**Conversas do Claude Desktop.** Não há caminho oficial pelo CLI e o produto
não inventa um.

**Sessão do orquestrador.** `codex exec resume` existe e não é usado de
propósito.

**Varredura truncada.** Acima de 20 000 arquivos a snapshot para e diz que
parou — uma varredura truncada não prova que um arquivo não existe, e fingir o
contrário seria a mesma desonestia pelo outro lado.

## Segurança do repositório

Público. Nada de credencial, chave de exemplo ou dado pessoal foi adicionado.
A pendência de `docs/SECURITY_HISTORY_CLEANUP.md` **não foi tocada**.

## Próximo passo menor e concreto

Rodar o roteiro do item 1 com o novo instalador e o mesmo `hello.txt`.

O que mudou no que você vai ver: enquanto o Claude trabalha, o painel diz **há
quanto tempo** e **em que ferramenta**. Se ele ficar dez minutos sem produzir
nada, a execução para sozinha e diz *"o worker ficou sem dar sinal e foi
interrompido"* — em vez de ficar em "executando automaticamente" até o limite
de uma hora. Se falhar de outro jeito, **Detalhes** continua nomeando a causa.

Mande a tela. É ela que responde "por que nada mudou?".

---

## Portões humanos desta sessão

### `SUBSCRIPTION_USE_APPROVAL_PENDING`

A documentação do Claude Agent SDK diz que um produto de terceiros não deve
oferecer login claude.ai nem os limites da assinatura sem aprovação prévia.
Isso decidiu o ACP (não é o caminho padrão) e levanta uma pergunta que **não é
minha para responder**: se o aplicativo for distribuído a outras pessoas, e não
apenas usado por você, vale perguntar formalmente aos fornecedores.

Nada foi contornado, nada foi alterado para exigir chave paga, e o limite está
escrito em `docs/ACP_AND_SUBSCRIPTION_POLICY.md` em vez de escondido.

### `LOCAL_REAL_AUTH_TEST_PENDING`

Continua de pé, com o roteiro acima. Nenhum teste desta sessão usou conta real:
não há Codex nem Claude legítimos no CI, e este ambiente não é Windows.
