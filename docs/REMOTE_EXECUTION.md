# Local e remoto: o que roda de verdade, e o que não roda

Documentação consultada em **8 de setembro de 2026**, reconferida e ampliada em
**9 de setembro de 2026**. As citações são literais para poderem ser
reconferidas; termos e comportamentos mudam entre versões.

Você pediu duas coisas nesta seção, e elas puxam em direções opostas se a
resposta for preguiçosa: *"deixe clara a diferença entre local e remoto"* e
*"se não houver integração oficial adequada, apresente Remoto como
indisponível/configurável, explicando o requisito real. Não invente um backend
que não existe."*

A resposta honesta tem três partes, não duas — porque **existe** um caminho
oficial de execução remota com assinatura, e ele **não** é acionável por este
aplicativo hoje. Dizer "não existe" seria tão errado quanto inventar.

---

## 1. Local — funciona, e é o único modo que altera arquivos

O Codex e o Claude Code rodam como processos filhos **neste computador**, na
pasta do projeto. É o modo que o aplicativo dirige de ponta a ponta: ele
inicia os CLIs, lê o que eles produzem, coleta a evidência com `git`,
reexecuta as verificações e só então o DoneGate conclui.

Fechar o aplicativo encerra a execução, porque os processos são dele.

## 2. Nuvem (coordenador próprio) — real, e exige que **você** o rode

O modo `cloud` deste aplicativo aponta para um **coordenador** — o serviço em
`apps/coordinator/`, que faz parte deste repositório. O trabalho acontece em um
workspace isolado, o repositório é clonado lá dentro, e a execução continua com
este computador desligado.

Não é um backend inventado: o código está aqui. O que ele exige é real também —
alguém precisa hospedá-lo e conectá-lo em **Configurações → Nuvem**. Sem
coordenador conectado, a interface diz exatamente isso e não oferece o modo.

## 3. Claude Code na web — oficial, com assinatura, e **fora do alcance deste laço**

Isto é o que mudou desde a última investigação, e é a parte que não pode ser
resumida como "não existe".

> Claude Code on the web runs tasks on Anthropic-managed cloud infrastructure at
> claude.ai/code […] Sessions persist even if you close your browser.
>
> — <https://code.claude.com/docs/en/claude-code-on-the-web>

E dá para criar uma sessão dessas **pelo terminal**, com a assinatura:

> Start a cloud session from the command line with the `--cloud` flag:
> `claude --cloud "Fix the authentication bug in src/auth/login.ts"`

Então por que o Orquestrador não faz isso por você? Por dois motivos
documentados, e nenhum deles é preguiça:

**Primeiro: criar a sessão não funciona em modo headless.**

> Claude Code rejects `--bg`, and rejects `--cloud` with a task description
> [when combined with `-p`]
>
> — <https://code.claude.com/docs/en/headless>

O aplicativo dirige o CLI com `claude -p`. `claude --cloud "tarefa"` é
interativo — pede um terminal, mostra uma lista de progresso, e continua aberto.
Um worker do Orquestrador não pode ser isso.

**Segundo: não há como ler o resultado de volta.** Existe um caminho para
*enviar* uma mensagem a uma sessão que já existe —

> `claude -p "your message" --cloud <session-id>` […] The CLI queues the message
> into the session and **exits without waiting for a reply**.

— mas nada documentado para listar sessões da nuvem ou ler o que elas
produziram sem interface. `/tasks` e `--teleport` são interativos.

E o laço deste aplicativo **depende** de ler o resultado: ele coleta evidência,
reexecuta verificações e só o DoneGate conclui. Um worker cujo resultado não
pode ser lido não é um worker deste laço; seria um botão que dispara algo e
mente sobre o que aconteceu depois.

### O que foi feito no lugar

A interface **nomeia** o caminho oficial em vez de fingir que ele não existe ou
que este aplicativo o dirige. Onde a execução remota é oferecida, o aplicativo
mostra o comando documentado, pronto para copiar:

```
claude --cloud "<o objetivo>"
```

Você o roda no seu terminal, a sessão vive em claude.ai/code, e você a
acompanha lá ou no aplicativo do celular. O Orquestrador não executa esse
comando, não lê essa sessão, e **não diz** que a acompanhou.

Requisitos, ditos onde o comando aparece, porque são reais:

- login de assinatura (`claude auth login`) — *"`--teleport` requires claude.ai
  subscription authentication"*, e o mesmo vale para `--cloud`;
- a política `allow_remote_sessions` da organização ligada;
- acesso ao GitHub, ou o *fallback* de bundle local;
- research preview para Pro, Max e Team.

### O que foi reconferido em 9 de setembro

A pergunta era se existe um caminho oficial que permita ao aplicativo **dirigir**
uma execução na nuvem — iniciar, acompanhar, ler o resultado, coletar evidência e
fechar o DoneGate — usando a assinatura, sem clonar nada no Windows e sem abrir
um terminal. A resposta continua sendo **não**, e agora com mais detalhe.

**O que é oficial e existe:**

- Um endpoint documentado dispara uma Routine e cria uma sessão de nuvem:
  `POST https://api.anthropic.com/v1/claude_code/routines/{trig_...}/fire`, com
  o cabeçalho `anthropic-beta: experimental-cc-routine-2026-04-01` e um token
  por routine. É cobrado como **uso da assinatura do Claude Code**, não como API
  paga. Devolve `{type, claude_code_session_id, claude_code_session_url}`.
- O trabalho acontece em VMs geridas pela Anthropic, e *"Sessions persist even if
  you close your browser"*. O Claude publica em branches com prefixo `claude/`.
- `claude -p "sua mensagem" --cloud <session-id>` enfileira uma mensagem numa
  sessão que já existe, e sai sem esperar resposta.

**O que não existe, e é o que este laço precisa:**

- O disparo é *fire-and-forget*: *"The request returns once the session is
  created. It does not stream session output or wait for the session to
  complete."*
- O token da routine tem escopo **"One routine only; no read access."** Não há
  endpoint documentado para ler estado, resultado ou diff de uma sessão de
  nuvem, nem para cancelá-la.
- `claude --cloud "<tarefa>"` é interativo e é recusado junto com `-p`; `/tasks`
  e `--teleport` também são interativos.

Ou seja: dá para **começar** e para **mandar mensagem**. Não dá para **ler de
volta**. E o laço deste aplicativo é feito de leitura: ele coleta evidência,
reexecuta verificação e só então o DoneGate conclui. Apresentar isso como
"orquestração automática completa" seria falso, e é exatamente o que o pedido
proíbe.

### As alternativas que fechariam o laço — e o que custam

Nenhuma foi provisionada, porque ambas custam dinheiro e isso precisa de
autorização explícita.

| caminho | fecha o laço? | o que exige | custo |
|---|---|---|---|
| **Coordenador próprio** (`apps/coordinator/`, já neste repositório) | sim | hospedar o serviço em algum lugar e conectá-lo em Configurações → Nuvem | a hospedagem, quanto ela custar |
| **Managed Agents** (`client.beta.sessions`, beta `managed-agents-2026-04-01`) | sim | é a superfície da **plataforma** Claude, não a assinatura | cobrança por API, separada da assinatura |
| **Routine `/fire` + Claude Code na web** | **não** | um token de routine | nada além da assinatura |

O coordenador é o único que já está escrito. Managed Agents é uma API paga, e o
pedido é explícito: *"Não introduza API paga como fallback automático"* — então
ela fica registrada aqui como alternativa distinta, e não é usada sem uma
autorização de custo dada em palavras.

## 4. O que continua valendo, sem exceção

- **Nenhuma API paga vira obrigatória**, e não há fallback automático para
  cobrança. `--bare` — que exigiria `ANTHROPIC_API_KEY` — nunca é enviado.
- **Nada de scraping, cookies copiados, automação de login ou endpoint
  privado.** O único caminho para a nuvem da Anthropic citado aqui é uma flag
  documentada do CLI oficial, rodada por você.
- **O GitHub é a fonte do código, não um executor.** Conectar um repositório lê
  arquivos pela API REST documentada; não executa nada, e a interface diz isso
  no lugar onde se conecta.

## 5. Como a interface diz isso

Cada projeto na sidebar mostra o que ele é, e o cabeçalho mostra onde a
execução acontece:

| ícone | projeto | execução |
|---|---|---|
| GitHub | tem repositório | leitura pela API; para alterar código, associe uma pasta |
| pasta | tem pasta local | **local**, neste computador, altera arquivos |
| nuvem | workspace de nuvem | no coordenador, continua com o app fechado |
| balão | nem pasta nem repositório | analisa, planeja e revisa; não altera arquivo nenhum |

Um projeto sem pasta diz, no seu próprio diálogo de configurações: *"Sem pasta,
o projeto analisa e planeja, mas não altera arquivo nenhum."* Essa frase existe
para que nenhuma execução termine com a pessoa procurando um arquivo que nunca
poderia ter sido escrito.
