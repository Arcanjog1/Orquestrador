# Os três modos, e o que cada um exige

Um único loop, um único DoneGate, três formas de executar. O que muda entre
elas é **onde as ferramentas rodam** — não como o orquestrador pensa.

| Modo | Precisa de pasta? | Precisa de servidor? | Custo além da assinatura |
|---|---|---|---|
| **1. Conversa** | Não | Não | Nenhum, se as conexões forem CLI |
| **2. Código local** | Sim | Não | Nenhum, se as conexões forem CLI |
| **3. Nuvem** | Não | Sim (opcional) | Infraestrutura + API, quando configurado |

O modo 3 continua existindo, inteiro. Ele deixou de ser o caminho principal;
não foi removido, e nada nele foi desativado.

---

## As três coisas que foram separadas

O acoplamento que esta reorientação desfez:

**A. Orquestração** — decidir o que fazer, delegar, analisar o resultado,
determinar se terminou. Vive em `OrchestrationService` e é a mesma em todos os
modos.

**B. Provider / conexão** — mandar uma mensagem para a OpenAI, a Anthropic ou
o CLI oficial de qualquer uma, e receber uma resposta estruturada. Vive atrás
de `AgentProvider` (`src/providers/provider-types.ts`), que **estende**
`AgentRunner` em vez de substituí-lo.

**C. Ambiente de execução** — onde as ferramentas realmente rodam: local,
remoto, ou nenhum. Vive atrás de `ExecutionEnvironment`.

O orquestrador não sabe qual das três combinações está em uso. Ele recebe
runners e fala com runners.

---

## A distinção que sustenta o produto

> **Uma chamada de API a um modelo não é um agente de programação.**

Uma API gera texto, decisões e tool calls. Editar arquivo, rodar teste e usar
git exige um **executor real**. Isso não é uma opinião de arquitetura: é a
diferença entre uma alteração e a descrição de uma alteração.

O código diz isso em um campo:

```ts
interface ProviderCapabilities {
  toolExecution: boolean;   // este worker mexe em arquivo de verdade?
  // ...
}
```

- `ClaudeCodeAdapter` / `CodexAdapter` (CLI oficial) → carregam executor.
- `AnthropicApiProvider` / `OpenAiApiProvider` → **`toolExecution: false`**.

E o loop age sobre isso, antes de invocar:

```
delegação com requiresTools: true
        ↓
worker declara toolExecution: false
        ↓
RECUSADA — WORKER_CANNOT_EXECUTE_TOOLS, com a lista de quem pode
```

O worker nunca é chamado. Não existe caminho em que "a API disse que editou o
arquivo" vire "arquivo alterado". Teste que fixa isso: *"a worker that cannot
execute tools is refused a coding delegation, and told why"*.

---

## Modo 1 — Conversa

Para analisar um problema, montar um plano, revisar uma resposta, comparar
soluções, gerar prompts, coordenar pesquisa, discutir arquitetura.

```
Você
 ↓
Orquestrador (OpenAI)
 ↓  delega
Claude Trabalho 1  →  responde
 ↓
Orquestrador revisa
 ↓  delega
Claude Trabalho 2  →  responde
 ↓
Orquestrador revisa
 ↓
DONE — resposta final
```

O projeto tem `environment = 'conversation'`, `local_path = ''`, e a execução:

- não resolve ambiente e não provisiona nada;
- não captura baseline;
- não coleta evidência;
- não roda comando;
- não usa o ProcessManager.

O `NO_ENVIRONMENT` que o loop usa nesse modo tem um `ProcessRunner` que
**lança exceção**. Se algum caminho tentasse gerar um processo numa conversa,
ele quebraria em vez de alcançar silenciosamente a máquina do usuário.

### O diretório de trabalho de uma conversa

Mesmo sem pasta de projeto, um agente CLI precisa de *algum* diretório. Deixar
vazio faria o `spawn` herdar o diretório em que o aplicativo foi iniciado — que
pode ser qualquer coisa.

Isso não é só desleixo: os dois CLIs oficiais leem, do diretório de trabalho, o
`CLAUDE.md`, os hooks de `.claude/settings.json` e os servidores de `.mcp.json`.
A doc do Claude Code diz que uma sessão `-p` roda esses hooks e conecta esses
servidores **mesmo numa pasta que ninguém marcou como confiável**. Uma conversa
— um run sem projeto nenhum — poderia acabar executando a configuração de um
projeto alheio.

Então cada projeto de conversa recebe um diretório **vazio**, dentro da pasta
privada do aplicativo (`<app>/conversations/<workspace-id>`). Vazio é o ponto:
não há nada ali para um CLI interpretar como configuração. E dá ao CLI um lugar
estável para guardar a sessão, que é o que faz o `--resume` encontrá-la na
delegação seguinte.

### O DoneGate de conversa

Não é o gate de código afrouxado — é **outro gate**, `evaluateConversationDone`.
Afrouxar o de código seria o começo do fim: em pouco tempo alguém aceitaria uma
afirmação no lugar de uma evidência.

Ele exige:

1. uma resposta final de verdade, não uma string vazia;
2. todo critério que o **próprio orquestrador** declarou, resolvido;
3. a última invocação do worker realmente concluída.

E devolve `verification: []` — sempre. Um run de conversa não rodou verificação
nenhuma, e relatar uma que não existiu é exatamente a desonestidade que o gate
existe para impedir.

Quem marca um critério como satisfeito num run de conversa é o **orquestrador**,
ao revisar (`satisfiedCriteria`), não o worker. Isso continua sendo separação de
papéis: o worker não produz decisões, então não pode escrever esse campo.

---

## Modo 2 — Código local

Preservado inteiro. É o modo em que o produto edita código de verdade.

```
Você → Orquestrador → Worker com executor → arquivo alterado
     → Evidence (git) → Verification → revisão → DoneGate
```

O `RuntimeManager` continua instalando e gerenciando Node, Git (MinGit) e os
CLIs. **O usuário não precisa instalar nada manualmente**, e o aplicativo
continua sendo um `.exe`.

O DoneGate de código não mudou uma linha:

- evidência lida do git pelo programa, nunca do relato do worker;
- toda verificação re-executada do zero na hora do gate;
- verificação pedida **por id**, resolvida contra a lista que só um humano
  escreve;
- run que não mudou nada não passa, salvo `allowNoChanges`.

---

## Modo 3 — Nuvem (opcional)

Coordinator, provisionamento de workspace remoto, fronteira de execução,
publicação — tudo preservado.

O que mudou é só a **exigência**: quem não configurou host, API ou billing
continua usando os modos 1 e 2 sem ver um erro de conta de nuvem. Nada é
provisionado, iniciado ou cobrado sem configuração e autorização explícitas.

---

## Como um projeto escolhe o modo

Pela coluna `workspaces.environment`, que já dizia onde um run executa e agora
tem uma terceira resposta:

| valor | significa |
|---|---|
| `local` | uma pasta neste computador |
| `cloud` | um workspace isolado provisionado em outro lugar |
| `conversation` | lugar nenhum, porque não há nada para executar |

Uma coluna, uma fonte de verdade. O `runs.kind` é gravado **quando o run é
criado** — se o projeto mudar depois, o histórico continua dizendo qual gate
aquele run precisou passar.

---

## O contrato de delegação

A decisão do orquestrador identifica:

| campo | para quê |
|---|---|
| `action` | delegate / verify / done / blocked |
| `task` | o objetivo da delegação |
| `workerId` | **qual worker da equipe** |
| `requiresTools` | se precisa mexer em arquivo |
| `acceptanceCriteria` | critérios de aceite |
| `verificationCommands` | ids de verificação (nunca linha de comando) |
| `workerRequirements` | capability + reasoning, em tiers, nunca nome de modelo |
| `satisfiedCriteria` | o que a revisão considerou resolvido (só conversa) |
| `summary` | uma linha para a pessoa — na `done`, é a resposta final |
| `reason` | obrigatório em `blocked` |

O aplicativo valida `workerId` contra a equipe real. Um id que não existe volta
como `UNKNOWN_WORKER` **com a lista verdadeira** — nunca é redirecionado em
silêncio para outra conexão.

---

## Duas contas Claude

São duas **conexões**, com o mesmo provider e credenciais separadas. Não há um
segundo adapter: há duas instâncias do mesmo, cada uma com seu `connectionId` e
sua credencial.

Cada invocação é auto-contida — o loop monta um prompt completo por chamada, do
mesmo jeito para CLI e para API. Não existe estado de conversa compartilhado
entre workers, então **o contexto de uma conta não pode chegar à outra por
construção**, e não por disciplina de quem escreve o prompt.

O roteamento entre elas é por papel e capacidade. **Não** por cota restante:
rodízio de contas para driblar rate limit não está implementado e não deve ser.

---

## Roteamento automático de modelo

Preservado. O orquestrador pede em **tiers** (`fast`/`balanced`/`strong`/`max`),
nunca um nome de modelo; o app resolve o tier contra o que aquele provider e
aquela conta realmente aceitam.

Duas regras que os adapters de API respeitam:

- um nível interno como `MAX` **nunca** é enviado com esse nome. Cada adapter
  filtra contra o conjunto que a API documenta e, se o nível não couber, envia
  sem nível e registra a nota;
- nenhum alias de modelo é inventado. `getAvailableModels()` pergunta ao
  provider (`GET /v1/models`) com a credencial daquela conexão.

Override manual continua disponível, e a escolha é registrada em cada
invocation.
