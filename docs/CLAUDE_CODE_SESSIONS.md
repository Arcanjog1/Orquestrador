# Sessões do Claude Code: CLI, Desktop, e por que uma não aparece na outra

A pergunta: *"vejo o consumo na minha conta Claude, mas não vejo a execução
aparecer na interface do Claude Code Desktop"*.

A resposta curta: **é assim mesmo, por decisão da Anthropic, e está
documentado.** Não é defeito do Orquestrador, e não há nada para consertar no
código — há algo para mostrar na tela, e isso foi feito.

Documentação consultada em **7 de setembro de 2026**. Termos e comportamentos
mudam entre versões; as citações abaixo são literais para que possam ser
reconferidas.

---

## 1. Por que a execução não aparece no seletor de sessões

> Claude Code leaves sessions created with `claude -p` or the Agent SDK **out
> of the session picker and out of `claude --continue`**. You can still resume
> one by passing its session ID to `claude --resume <session-id>`.
>
> — <https://code.claude.com/docs/en/sessions>

O Orquestrador executa o worker com `claude --print` (`-p`), que é o modo não
interativo documentado. Sessões criadas assim são **deliberadamente omitidas**
do seletor (`claude --resume` sem argumento, `/resume`) e de
`claude --continue`.

Ou seja: a execução aconteceu, consumiu da sua conta, gravou transcrito — e
simplesmente não é listada. O único jeito de voltar a ela é pelo **id**.

## 2. Por que não aparece no Claude Code Desktop

> If you already use the Claude Code CLI, Desktop runs the same underlying
> engine with a graphical interface. You can run both simultaneously on the
> same machine, even on the same project. **Each maintains separate session
> history**, but they share configuration and project memory via CLAUDE.md
> files.
>
> — <https://code.claude.com/docs/en/desktop>

E, na página de sessões:

> The **desktop app**, Claude Code on the web, and the VS Code extension **each
> maintain their own session history**. This page covers the CLI.

Duas histórias separadas. Uma sessão do CLI não aparece no Desktop porque o
Desktop não lê a história do CLI — não porque o Orquestrador esteja fazendo
algo errado.

**Claude Code ≠ Cowork.** O aplicativo Claude Desktop tem três abas: *Chat*,
*Cowork* e *Code*. O que o Orquestrador dirige é o **Claude Code CLI**, o mesmo
motor da aba *Code*. Nada neste projeto fala com Cowork, e nada aqui deve
passar a falar.

## 3. Existe um caminho oficial de transferência? Existe — e não serve aqui

> To move a CLI session into Desktop, run `/desktop` in the terminal. Claude
> saves your session and opens it in the desktop app, **then exits the CLI**.
> This command is available on macOS and x64 Windows when you are signed in
> with a Claude subscription. It is not available with API key authentication
> or on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry.
>
> — <https://code.claude.com/docs/en/desktop>

Existe, então. E não pode ser usado por este aplicativo, por três motivos, cada
um bastante:

1. **É um comando da interface de terminal.** A documentação do modo headless é
   explícita: *"Built-in commands that only run in the terminal interface, such
   as `/login`, aren't available in `-p` mode."*
2. **Ele encerra o CLI.** Um worker no meio de uma delegação sairia, e a
   execução morreria — trocaríamos um incômodo por uma falha.
3. **É limitado por plataforma e autenticação.**

Então **não foi implementado**, como você pediu: *"Se não houver, não invente a
funcionalidade."* Aqui há, mas não para este cenário, e fingir que há seria a
mesma desonestidade.

### O que foi feito no lugar

A tela de **Detalhes** de uma execução agora mostra, por conexão:

- o **id real da sessão** que o CLI reportou;
- o **diretório de trabalho** daquela sessão;
- a **conexão** (conta) a que ela pertence;
- e o comando documentado, pronto para copiar:

  ```
  claude --resume <id-da-sessão>
  ```

O aplicativo **não executa** esse comando. Ele o mostra. Se você quiser
continuar aquela conversa à mão no seu terminal — e de lá, se quiser, rodar
`/desktop` — o caminho é seu e é oficial. O que o Orquestrador faz é parar de
esconder o id.

---

## 4. Continuidade: o que o Orquestrador faz, e por que

O requisito é que o Claude continue o trabalho anterior em vez de receber cada
delegação como tarefa nova.

### O mecanismo oficial

> `claude --resume <session-id>` — Resumes the named session directly

E o id vem do envelope: com `--output-format json`, a resposta traz
`session_id`. O Orquestrador lê esse campo e o guarda. Nada aqui analisa
transcrito: a documentação diz que o formato do `.jsonl` é interno e muda entre
versões — *"scripts that parse these files directly can break on any release"*
— então o produto não os lê.

### A chave: projeto × conversa × conexão

A tabela `agent_sessions` é chaveada por **(conversa × conexão)**, e a busca
exige ainda que o **diretório de trabalho** seja o mesmo.

Isso é mais restrito do que o CLI hoje exige:

> You can run `claude --resume <session-id>` from any directory: Claude Code
> looks for the ID in the current project directory and its git worktrees
> first, **then in every other project on this machine**. […] Before v2.1.223,
> the lookup stopped at the current project directory and its git worktrees.
>
> — <https://code.claude.com/docs/en/sessions>

A restrição é **de propósito**, e atende exatamente ao que você pediu: *"Não
retomar uma sessão de outro projeto por engano."* O CLI hoje aceitaria; o
Orquestrador não oferece. Duas conexões Claude na mesma conversa são duas
linhas, então a sessão do *Claude Trabalho 1* nunca pode ser entregue ao
*Claude Trabalho 2* — os transcritos já vivem em `CLAUDE_CONFIG_DIR`
diferentes, e isto faz a mesma separação valer para o que o aplicativo pede.

### Quando a sessão não existe mais

O padrão de retenção é 30 dias (`cleanupPeriodDays`), e uma pessoa pode limpar
antes disso. Um id gravado semanas atrás pode simplesmente não existir:

> If no stored session matches the ID, Claude Code reports
> `No conversation found with session ID: <session-id>`.

O Orquestrador reconhece essa resposta, **esquece** o id e refaz a mesma
delegação uma vez com sessão nova — em vez de falhar uma execução por
contabilidade. O passo fica registrado como `session-expired`, então o motivo
real aparece, e não como "o worker falhou".

### O que não fazemos

- **`--bare` nunca é enviado.** *"bare mode doesn't use your subscription
  login"* e *"never reads OAuth credentials or the system keychain"* — exigiria
  `ANTHROPIC_API_KEY`, que é justamente o custo que este produto recusa.
- **Não lemos `~/.claude/projects/**.jsonl`.** Formato interno, muda entre
  versões, e ler transcrito de outro programa não é caminho oficial.
- **Não listamos sessões existentes.** Nenhum CLI oferece listagem não
  interativa. O aplicativo oferece as sessões que ele mesmo iniciou, e diz
  isso.

---

## 5. O que o Codex recebe, e o que o Claude recebe

Contexto não é o histórico inteiro.

**O Codex (supervisor)** recebe: o objetivo, o estado atual, o último
relatório do worker, as evidências que o *aplicativo* coletou, os resultados
das verificações que o *aplicativo* reexecutou, e as decisões anteriores da
própria execução. Ele roda `--sandbox read-only` e não inspeciona o workspace:
o prompt diz isso com todas as letras, e diz que EVIDENCE e VERIFICATION são a
fonte da verdade.

**O Claude (worker)** recebe: a delegação atual, e a **sessão certa** — que é
onde o contexto anterior realmente está. É por isso que o resume importa: o
contexto não é reenviado, ele já está na sessão.

E a regra que não se afrouxa: **uma memória não é prova de execução.** O que um
agente relata é uma alegação. Só evidência e verificação decidem, e só o
DoneGate conclui.

---

## 6. Como acompanhar a execução dentro do Orquestrador

Que é, no fim, o requisito principal — mais do que ver a sessão no Desktop.

Durante a execução, o painel mostra: há quanto tempo o agente trabalha, há
quanto tempo está sem produzir nada, a ferramenta em execução quando o runtime
informa, e **Cancelar**. Dez minutos de silêncio interrompem a execução com um
motivo dito por extenso.

Em **Detalhes**, por invocação: provider, tipo de conexão, worker, modelo,
raciocínio, tokens, custo, falha classificada, ferramentas recusadas, e o
diretório de trabalho — mais, agora, o id da sessão e o comando de resume.

Nada disso confunde consumo com alteração de arquivo: quem diz que um arquivo
mudou é o `GitEvidenceCollector` (ou a varredura do sistema de arquivos), nunca
a contagem de tokens.
