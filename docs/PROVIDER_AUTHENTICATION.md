# Autenticação dos providers — o que a assinatura cobre e o que a API cobra

Pesquisa feita contra a documentação oficial em **2026-09-07**, antes de qualquer
linha de código de autenticação. As fontes estão no fim do documento.

A pergunta que este documento responde é a única que importa para o custo:

> Eu já pago ChatGPT e Claude. O que consigo fazer **sem contratar nada a mais**,
> e o que exige uma API com cobrança separada?

---

## 1. As cinco coisas que não podem ser confundidas

O enunciado do produto pede explicitamente que estas sejam distinguidas. São
mesmo cinco coisas diferentes, com regras diferentes:

| # | Caminho | O que é | Cobrança |
|---|---------|---------|----------|
| 1 | **Assinatura na ferramenta oficial** | O usuário roda o Claude Code CLI / Codex CLI dele, logado na conta dele | Incluído na assinatura |
| 2 | **Assinatura por integração programática autorizada** | Um app de terceiro oferecendo login claude.ai / limites do plano | **Não permitido pela Anthropic sem aprovação prévia** |
| 3 | **API com cobrança separada** | `api.anthropic.com` / `api.openai.com` com chave própria | Por token, fatura à parte |
| 4 | **Execução local** | Ferramentas rodam na máquina do usuário | Sem custo de infraestrutura |
| 5 | **Execução remota** | Container/servidor provisionado | Custo de infraestrutura |

O erro que este produto **não** comete: presumir que 1 e 3 são a mesma coisa, ou
que 2 é livre.

---

## 2. Anthropic / Claude

### 2.1 O que a documentação oficial diz sobre apps de terceiros

Da página oficial do Claude Agent SDK, citada literalmente:

> *"Unless previously approved, Anthropic does not allow third party developers to
> offer claude.ai login or rate limits for their products, including agents built
> on the Claude Agent SDK. Use the API key authentication methods described in the
> Quickstart instead."*

Consequência direta e não negociável para este produto:

- **O AI Orchestrator não implementa, não embute e não simula um login claude.ai.**
- **O AI Orchestrator nunca lê, copia ou reaproveita `auth.json`, cookies,
  keychain ou credencial de outro aplicativo Claude.**
- Se o produto embutisse o Agent SDK e tentasse fazê-lo consumir a assinatura do
  usuário, estaria exatamente no caso 2 — proibido sem aprovação prévia.

### 2.2 O caminho que **continua** valendo pela assinatura

O que a restrição acima **não** proíbe é o caso 1: o usuário rodando a
**ferramenta oficial dele**, na máquina dele, logada por ele, pelo fluxo de login
da própria ferramenta.

É exatamente o que este produto já faz e que foi **preservado**:

- o aplicativo instala e gerencia o **Claude Code CLI oficial**;
- o login é feito pelo **fluxo do próprio CLI**, que abre o navegador; o
  aplicativo nunca vê, digita ou guarda a credencial;
- cada conta tem seu próprio `CLAUDE_CONFIG_DIR` privado, criado pelo aplicativo,
  cujo conteúdo pertence ao CLI;
- a invocação é `claude --print`, o **modo não interativo documentado**.

O modo `--print` roda com a credencial da assinatura. A exceção documentada é
`--bare`, que **nunca lê credencial OAuth** e exige `ANTHROPIC_API_KEY` — por isso
este produto **não usa `--bare`**.

> **Limite honesto.** Ninguém, nem esta análise, pode afirmar em nome da Anthropic
> que dirigir o CLI oficial do usuário por um processo filho é irrestrito. O que se
> pode afirmar é o que o produto faz: usa a ferramenta oficial, pelo login oficial
> dela, sem tocar em credencial. Se a Anthropic disser que esse uso exige
> aprovação, o caminho a seguir é pedir aprovação — não contornar.

### 2.3 O que a Messages API dá, e o que ela cobra

`POST https://api.anthropic.com/v1/messages`, com `x-api-key` e
`anthropic-version: 2023-06-01`. É o caso 3: **cobrança por token, fatura à parte
da assinatura**. Preços de referência (input/output por milhão de tokens):
Opus 5 $5/$25, Sonnet 5 $2/$10, Haiku 4.5 $1/$5.

**A Messages API sozinha não edita arquivo nenhum.** Ela devolve texto e
`tool_use`; quem lê, escreve e roda comando é o executor do lado de cá. Ver
`docs/ORCHESTRATION_MODES.md`.

Erros que o adapter trata por nome, não por string solta: `401
authentication_error`, `403 permission_error` / `billing_error`, `429
rate_limit_error`, `400 invalid_request_error`, `500 api_error`, `529
overloaded_error`.

---

## 3. OpenAI / Codex

### 3.1 Assinatura

O README oficial do Codex CLI:

> *"Run `codex` and select **Sign in with ChatGPT**. We recommend signing into your
> ChatGPT account to use Codex as part of your Plus, Pro, Business, Edu, or
> Enterprise plan."*

E, na sequência: *"You can also use Codex with an API key, but this requires
additional setup."*

Ou seja, do lado da OpenAI o caso 1 é **explicitamente documentado e
recomendado**: o Codex CLI oficial, logado com ChatGPT, consome os limites do
plano. É o caminho que este produto preserva e prioriza.

### 3.2 API

`POST https://api.openai.com/v1/responses`, com `Authorization: Bearer`. Caso 3:
cobrança por token na conta da plataforma, **separada da assinatura ChatGPT**.

`Codex CLI`, `Codex SDK`, `Responses API` e "um modelo de programação disponível
na API" são quatro coisas distintas e o produto não as trata como sinônimos. Em
particular: **um modelo chamado "codex" não é automaticamente um modelo
disponível na API da sua conta.** Por isso o produto **não embute lista de
modelos**: ele pergunta ao provider (`GET /v1/models`) com a credencial da
conexão e só oferece o que voltou de verdade.

---

## 4. As regras que o código obedece

Derivadas do acima, e verificáveis no código:

1. **Nenhum endpoint privado.** Só `api.anthropic.com/v1/*` e
   `api.openai.com/v1/*` documentados.
2. **Nenhuma automação de site.** Não existe browser headless, nem scraping de
   chatgpt.com ou claude.ai.
3. **Nenhuma cópia de credencial.** Nem entre contas, nem de outro aplicativo.
4. **Nenhum nome de modelo inventado.** A lista vem de `GET /v1/models`.
5. **Nenhuma cobrança sem escolha explícita.** O modo API nasce **desligado**;
   nada é enviado a uma API paga antes de o usuário criar a conexão, colar a
   chave e ligar o modo. Ver `docs/API_COST_CONTROLS.md`.
6. **Nenhum fallback automático de assinatura para API paga.** Se o limite da
   assinatura acabar, a execução para em `NEEDS_HUMAN`. Ela nunca "continua na
   API" por conta própria.
7. **Nenhuma rotação de contas para driblar limite.** Duas contas Claude existem
   para organizar trabalho — não para esconder consumo. O roteamento é por
   papel e capacidade, nunca por "esta aqui ainda tem cota".

---

## 5. Resumo por recurso

| Recurso | Assinatura | API paga | Executor local | Servidor |
|---|---|---|---|---|
| Conversar / analisar / planejar (Claude Code CLI `--print`) | ✅ | — | não precisa | não precisa |
| Conversar / analisar / planejar (Codex CLI) | ✅ | — | não precisa | não precisa |
| Conversar / analisar / planejar (Messages / Responses API) | ❌ | ✅ por token | não precisa | não precisa |
| Editar arquivos e rodar testes (Claude Code CLI / Codex CLI) | ✅ | — | **exige** | não precisa |
| Editar arquivos via API pura | ❌ | ✅ por token | **exige** executor próprio | não precisa |
| Execução isolada em nuvem | — | — | — | **exige** (opcional) |

---

## Fontes

- [Claude Agent SDK — overview (restrição a terceiros)](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Code — execução programática / headless (`-p`, `--bare`, `--output-format json`)](https://code.claude.com/docs/en/headless)
- [Codex CLI — README oficial (Sign in with ChatGPT vs API key)](https://github.com/openai/codex)
- [OpenAI Node SDK — tipos da Responses API (`text.format`, `ResponseUsage`, `ReasoningEffort`)](https://github.com/openai/openai-node)

---

## 6. Sessões existentes — o que dá para retomar, e o que não dá

Pesquisado em **2026-09-07**, contra a documentação oficial, antes de
implementar.

### 6.1 O que é oficialmente suportado

**Claude Code.** `claude -p --resume <session-id>` é documentado, e é o
caminho **único** para uma sessão criada em modo não interativo: a doc diz que
sessões criadas com `claude -p` ficam **fora** do seletor interativo e fora do
`--continue`, e que só podem ser retomadas pelo id. O id vem do envelope
documentado `--output-format json`, que também traz `total_cost_usd`.

**Codex CLI.** `codex exec resume <SESSION_ID>` e `codex exec resume --last`
existem como subcomandos não interativos.

### 6.2 O que o aplicativo faz

Guarda o id das sessões **que ele mesmo criou**, por (conversa × conexão), e
retoma a do worker na delegação seguinte. É isso que faz o Claude carregar o
que aprendeu de uma delegação para a próxima em vez de reencontrar o código do
zero a cada volta do loop.

A chave ser `(conversa, conexão)` é o requisito de isolamento virando
estrutura: duas conexões Claude na mesma conversa são duas linhas, então a
sessão de uma conta nunca é entregue à outra. Os transcritos já vivem em dois
`CLAUDE_CONFIG_DIR` diferentes; isto faz o que o app pede combinar com isso. O
diretório de trabalho também precisa bater, porque as duas ferramentas guardam
sessão por projeto.

### 6.3 O que **não** dá, e não é fingido

**Listar as sessões que você já tem.** Nenhum dos dois CLIs oferece uma
listagem não interativa — só um seletor interativo, que um aplicativo não pode
dirigir. E a doc do Claude Code diz, sobre os arquivos de transcrito:

> *"The entry format is internal to Claude Code and changes between versions, so
> scripts that parse these files directly can break on any release."*

Então o aplicativo **não lê transcrito de ninguém**, não varre
`~/.claude/projects`, e não constrói um seletor a partir de arquivos internos
de outro programa. Ele oferece as sessões que ele mesmo iniciou.

**Retomar uma conversa do Claude Desktop pelo CLI.** A doc é explícita: o app
desktop, o Claude Code na web e a extensão do VS Code *"each maintain their own
session history"*, e uma sessão do desktop *"resumes in the app"*. Não há
caminho oficial do CLI para ela, e este produto não inventa um.

**Retomar a sessão do orquestrador.** Tecnicamente possível (`codex exec
resume`), deliberadamente não usado: o orquestrador recebe um prompt completo e
auto-contido a cada volta, e é isso que o impede de se afastar do objetivo.
Retomá-lo trocaria essa propriedade por nada.

**Uma versão sem `--resume`.** Simplesmente começa uma sessão nova a cada
delegação, e nada é prometido em nome dela.
