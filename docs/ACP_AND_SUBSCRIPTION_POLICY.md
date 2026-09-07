# ACP e o uso das assinaturas

O que foi verificado na documentação oficial, o que isso decide, e o que
continua sendo uma pergunta para o dono do produto — não para mim.

Consultado em **7 de setembro de 2026**. Termos mudam; nada aqui deve ser
tratado como permanente.

---

## A pergunta

O requisito é claro e razoável: *"eu já pago ChatGPT e Claude, não quero ser
obrigado a comprar crédito de API para ter dois agentes"*.

O Buzz conecta agentes por **ACP** (Agent Client Protocol), e a pergunta era se
o ACP melhoraria a comunicação deste orquestrador — e, principalmente, se os
adapters ACP funcionam com assinatura.

## O que foi verificado

### 1. Os adapters ACP, como o Buzz os documenta

`crates/buzz-acp/README.md`, commit `44d19f5`:

> ```bash
> export OPENAI_API_KEY="sk-..."   # required — use an OpenAI API key, not a ChatGPT subscription
> ```
>
> **API key note:** `codex-acp` always attempts a ChatGPT WebSocket login
> first, which logs a `426 Upgrade Required` error. This is expected and
> non-fatal — it falls back to `OPENAI_API_KEY` automatically.

e, para o Claude:

> ```bash
> export ANTHROPIC_API_KEY="sk-ant-..."
> ```

Ou seja: **no arranjo que o Buzz documenta, os dois adapters ACP são movidos a
chave de API paga.** Exatamente o que este produto se recusa a exigir.

### 2. `codex-acp`, a montante

O README do próprio adapter é mais generoso que o do Buzz. Ele declara anunciar
métodos de autenticação ACP na inicialização, entre eles *ChatGPT login*, com
`NO_BROWSER=1` para escondê-lo em ambientes sem navegador, além da chave de API
e de um gateway compatível.

Então o login de assinatura **existe** nesse adapter. O `426` que o Buzz
descreve é o que acontece no ambiente do Buzz, não uma lei da natureza.

### 3. `claude-agent-acp`, a montante — e a frase que decide

Esse adapter, pela sua própria descrição, *"implements an ACP agent by using
the official Claude Agent SDK"*.

A documentação do Claude Agent SDK diz, textualmente:

> **Unless previously approved, Anthropic does not allow third party developers
> to offer claude.ai login or rate limits for their products, including agents
> built on the Claude Agent SDK. Use the API key authentication methods
> described in the Quickstart instead.**
>
> — <https://code.claude.com/docs/en/agent-sdk/overview>

Isso é direto e não precisa de interpretação criativa: um produto de terceiros
construído sobre o Agent SDK **não deve oferecer login claude.ai nem os limites
da assinatura**, salvo aprovação prévia. O caminho indicado é chave de API.

---

## A decisão

**O ACP não vira o caminho padrão.**

Não por gosto arquitetural. Porque, para o lado Anthropic, o adapter ACP é
construído sobre o SDK cuja documentação diz que um produto de terceiros deve
usar chave de API — e chave de API obrigatória é precisamente o que este
produto se recusa a impor.

**O caminho padrão continua sendo o que já existe:** os CLIs oficiais, `codex`
e `claude`, executados como processos filhos, cada um no seu diretório de
configuração isolado, autenticados pelo login oficial do próprio fornecedor.

O ACP fica registrado como **opção futura de transporte**, não como obrigação —
e se um dia for adotado, será atrás da mesma fronteira `AgentRunner` que já
existe, sem substituir os adapters CLI.

### Por que isto não é uma perda

O ACP daria: sessões, cancelamento, permissões estruturadas e notificações de
progresso durante o turno.

Deste conjunto, **o que faltava aqui já foi obtido sem ele**:

- sessões — `claude -p --resume <id>`, já implementado, com o id lido do
  envelope e chaveado por (conversa × conexão);
- cancelamento — `AbortController` até o processo filho, já implementado;
- permissões — `--permission-mode acceptEdits`, e recusas lidas do envelope;
- progresso durante o turno — `--output-format stream-json`, adicionado nesta
  sessão, que é o que resolveu a janela parada.

O ganho restante do ACP seria uniformidade entre runtimes futuros. É real, e
não vale o preço de exigir uma chave paga hoje.

---

## A distinção que este produto sustenta — e o limite dela

O que este aplicativo faz, e não faz:

- **Não implementa, não hospeda e não oferece login claude.ai nem login
  ChatGPT.** Não há tela de login nossa, nem fluxo OAuth nosso, nem token
  nosso.
- **Não lê credencial de outro aplicativo.** Nada de cookies, `auth.json` de
  terceiros, tokens copiados do Claude Desktop, transcrições privadas ou
  endpoints não documentados.
- **Não automatiza o site** de nenhum fornecedor.
- **Não tem fallback silencioso para API paga.** As conexões de API existem,
  começam desligadas (`api_enabled = 0`) e precisam ser ligadas de propósito.
- **O que faz** é executar a ferramenta oficial do próprio fornecedor, na
  máquina do usuário, com a autenticação que essa ferramenta guarda no
  diretório dela — a mesma coisa que aconteceria se a pessoa digitasse o
  comando no terminal.

### O que **não** posso afirmar

Não posso afirmar que dirigir programaticamente um CLI oficial autenticado com
assinatura, dentro de um aplicativo de terceiros, esteja coberto pelos termos
de cada fornecedor para o seu caso de uso.

A nota da Anthropic acima trata de produtos construídos sobre o **Agent SDK**.
Este produto não usa o Agent SDK — usa o CLI. São coisas diferentes, e a nota
não fala do CLI. Mas ela mostra que a Anthropic tem uma posição explícita sobre
terceiros e assinatura, e seria desonesto ler isso como um sinal verde para
tudo o que não está literalmente escrito ali.

**`SUBSCRIPTION_USE_APPROVAL_PENDING` — portão humano.**

Você (dono do produto, titular das contas) é quem pode:

1. ler os termos aplicáveis das suas assinaturas ChatGPT e Claude;
2. se for distribuir o aplicativo para outras pessoas, e não apenas usá-lo,
   perguntar formalmente aos fornecedores;
3. decidir.

Enquanto isso não acontece, o produto:

- **não** foi alterado para exigir chave de API;
- **não** foi alterado para contornar nada;
- documenta o limite aqui, em vez de fingir que ele não existe.

Uso pessoal, na sua máquina, com as suas contas, dirigindo as ferramentas
oficiais que você mesmo instalou e nas quais você mesmo entrou, é o cenário
mais defensável dos possíveis. Distribuição para terceiros é uma pergunta
diferente, e é uma pergunta para os fornecedores.

---

## Precedência de autenticação

Um risco concreto e silencioso: uma `ANTHROPIC_API_KEY` ou `OPENAI_API_KEY`
presente no ambiente pode fazer o CLI cobrar da API em vez de usar a
assinatura — sem avisar ninguém, e com a fatura chegando depois.

O que o produto faz:

- monta o ambiente do processo filho explicitamente, a partir do gerenciador de
  contas, com `CLAUDE_CONFIG_DIR` (e equivalente do Codex) apontando para o
  diretório daquela conexão;
- **nunca** altera variáveis de ambiente globais do Windows;
- **nunca** copia credencial entre conexões;
- **nunca** exibe token no renderer nem grava segredo em log ou em SQLite em
  texto puro (há tabela própria, cifrada, nunca listada junto das conexões);
- **nunca** envia `--bare` ao Claude Code: essa flag não lê o login da
  assinatura, e exigir chave é justamente o custo que este produto recusa.

## O que continua proibido, e continua não implementado

Nada disto existe no código, e nada disto deve passar a existir:

cookies · endpoints privados · automação de site · tokens copiados de outro
aplicativo · `auth.json` de terceiros · engenharia reversa de sessão ·
credenciais de terceiros · fallback silencioso para API paga · rodízio entre
contas para contornar limite de fornecedor · `--dangerously-skip-permissions` ·
`bypassPermissions` · sandbox desligado · elevação a administrador.

Uma restrição contratual real se documenta. Não se contorna.
