# Por que o worker foi recusado, e como autorizar uma operação

Documentação consultada em **8 de setembro de 2026**, contra a versão que você
tem instalada: **Claude Code 2.1.252**. As citações são literais.

---

## 1. Causa comprovada

O aplicativo enviava, e continua enviando:

```
claude --print --permission-mode acceptEdits --output-format stream-json --verbose …
```

E o que `acceptEdits` faz está escrito:

> In addition to file edits, `acceptEdits` mode auto-approves common filesystem
> Bash commands: `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, and `sed`. […]
> Paths outside that scope, writes to protected paths […] **and all other Bash
> commands except the built-in read-only set still prompt.**
>
> — <https://code.claude.com/docs/en/permission-modes>

E, para o PowerShell:

> When the PowerShell tool is enabled, `acceptEdits` mode also auto-approves
> `Set-Content`, `Add-Content`, `Clear-Content`, and `Remove-Item` on in-scope
> paths […] A positional argument that contains a quote character, such as the
> apostrophe in `Set-Content .\notes.txt "It's done"`, **still prompts**.

Junte isso ao modo não interativo:

> With the default `host`, Claude Code sends them to the Agent SDK host or the
> `--permission-prompt-tool` tool. Pass `none` when nobody can answer, and
> Claude Code denies them instead.
>
> — <https://code.claude.com/docs/en/cli-reference>

**A cadeia completa:** o worker escolheu um shell para escrever o arquivo → o
comando não estava na lista curta que `acceptEdits` libera → o Claude Code
pediu permissão → em `--print` não havia ninguém para responder → a chamada foi
recusada → `permission_denials: ["PowerShell","Bash"]` → saída 1 depois de
42 s.

O aplicativo **leu isso corretamente** — a mensagem *"Ferramentas recusadas
nesta execução: PowerShell, Bash."* é escrita por ele, a partir do campo do
CLI. O que faltava era o que fazer em seguida.

### O que a causa **não** é

Descartado com evidência, não por eliminação:

| Hipótese | Por quê não |
|---|---|
| Autenticação | a invocação durou 42 s e produziu um envelope; uma credencial recusada falha em segundos e reporta `authentication` |
| Modelo | roteamento FAST; nenhum modelo desfaz uma permissão |
| Conta isolada | o Codex, na mesma máquina, concluiu em 1,8 s |
| Falha do GitHub | nenhuma chamada ao GitHub nesta tarefa |
| Hook ou política | nenhum hook é configurado por este aplicativo; a recusa veio com os nomes das ferramentas, que é a forma documentada |
| Sandbox do Codex | é do supervisor e é esperada; o worker não roda em sandbox |

---

## 2. O que mudou

### a. Escrever um arquivo não precisa de shell

O adapter passa agora `--allowedTools` com as ferramentas de arquivo:

```
--allowedTools Read Write Edit Glob Grep
```

Isto **não contorna a política — é a política**. `acceptEdits` existe
justamente para deixar o Claude escrever arquivos no diretório de trabalho; a
flag afirma isso independentemente do modo, e:

> `--allowedTools` Tools that execute without prompting for permission. **To
> restrict which tools are available, use `--tools` instead.**

Ou seja: `--allowedTools` não amplia o conjunto de ferramentas, só o que roda
sem perguntar. `Bash` e `PowerShell` continuam **fora** — um comando continua
precisando da sua autorização.

O worker também recebe, antes da tarefa, um bloco curto dizendo qual política
está em vigor. Um worker que precisa descobrir as próprias permissões gasta uma
invocação inteira sendo recusado; são quatro linhas contra 42 segundos.

### b. A recusa vira um pedido que você pode responder

Cada chamada recusada vira uma linha em `tool_permission_requests`, com o que o
CLI informou: ferramenta, `tool_use_id`, **o comando exato**, os argumentos, o
diretório, o agente e a conta. O que o CLI não informou fica `NULL` e a tela
escreve *não informado*.

### c. Você autoriza um escopo, não um computador

O diálogo oferece regras de permissão documentadas, calculadas no processo
principal:

| Situação | O que é oferecido |
|---|---|
| shell com comando conhecido | `Bash(node check.mjs)` — só esse comando |
| " | `Bash(node *)` — o programa com quaisquer argumentos |
| ferramenta de arquivo | o caminho, ou a ferramenta neste projeto |
| **shell sem comando informado** | **nada** |

Um shell **nunca** é oferecido como ferramenta nua. `Bash` sozinho autorizaria
qualquer comando no projeto para sempre, que é exatamente o *"não quero liberar
o computador inteiro"*.

E a regra é validada no processo principal contra as opções que o próprio
pedido publicou: um renderer que enviasse uma regra mais ampla do que exibiu é
recusado.

### d. O que continua proibido

`bypassPermissions`, `--dangerously-skip-permissions`, elevação, sandbox
desativado e liberação global de comandos **não são usados em nenhum caminho**.
Não há código que os alcance.

---

## 3. Como você aprova, na prática

1. a execução para em **NEEDS_HUMAN** e a faixa acima do compositor diz quantas
   operações estão esperando;
2. clique em **Revisar**;
3. o diálogo mostra agente, conta, ferramenta, comando, argumentos, pasta,
   projeto e motivo — com *não informado* onde o CLI não informou;
4. escolha o escopo e clique em **Autorizar**, ou **Recusar**;
5. autorizar **não executa nada**. A tarefa precisa ser enviada de novo.

## 4. Retomada

Não há retomada oficial de um processo recusado: o processo terminou. O que é
oficial, e é o que o aplicativo usa, é **`claude --resume <session-id>`** — a
sessão continua, com o contexto dentro dela. Então, depois de autorizar:

- **a conversa é a mesma**, com as mensagens e as evidências;
- **a conta e o workspace são os mesmos**;
- **a sessão do Claude Code é a mesma**, retomada pelo id oficial;
- **uma nova delegação é necessária**, e a interface diz isso com essas
  palavras em vez de fingir que a anterior continuou.

Nada é retentado automaticamente. Uma aprovação por si só não inicia execução
nenhuma — é o que impede uma operação não idempotente de ser repetida por trás
de você.

## 5. O que ainda depende do seu Windows

O caminho foi exercitado com o CLI **simulado**: um runner que devolve
`permission_denials` exatamente como o envelope documentado, mais 8 testes de
serviço e 1 na interface empacotada. Isso prova o fluxo do aplicativo.

**Não prova** que o seu `claude.EXE` 2.1.252 aceita `--allowedTools` com esses
nomes na sua máquina — o adapter só envia a flag quando o `--help` daquele
binário a declara, mas isso é uma verificação, não uma execução. Um teste com
CLI real no Windows continua pendente, e o roteiro é o da seção 3.

Se, com este build, o `hello.txt` passar a ser criado **sem** nenhum pedido de
autorização, a causa está confirmada na sua máquina: o worker deixou de
precisar de shell. Se ainda aparecer um pedido, ele agora nomeia o comando
exato — e é isso que decide o próximo passo.
