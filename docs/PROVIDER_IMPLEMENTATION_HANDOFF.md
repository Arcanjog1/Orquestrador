# Handoff — central de agentes

Estado ao fim da terceira sessão da reorientação.

## Baseline

| | |
|---|---|
| Repositório | `Arcanjog1/Orquestrador` (público) |
| Branch | `claude/ai-orchestrator-reorientacao-ytlkw0` |
| HEAD do início desta sessão | `ca4849a` |
| Instalador | a pre-release `desktop-dev-*` **mais recente** desta branch, em [Releases](https://github.com/Arcanjog1/Orquestrador/releases) |
| `main` | **não existe** neste repositório |

Sem reset, sem merge, sem force-push, sem apagar branch.

## O que esta sessão corrigiu

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

Rodar o roteiro do item 1 com o novo instalador e o mesmo `hello.txt`. Se
falhar, mandar a tela de **Detalhes** — ela agora nomeia a causa.
