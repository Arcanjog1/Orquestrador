# Execution Worktree e delegações dependentes

Implementação incremental sobre a branch `claude/ai-orchestrator-buzz-arch-vblrau`, a partir de `0eefe5f2c15e6a9b614a5a023b0dbd06fd37079b`.

## Motor e persistência

Electron Main continua responsável por `OrchestrationService`, `RunnerPair.workers`, `WorkerSlot`, roteamento por conta, AgentMessageBus, ProcessManager, verificação, AcceptanceCriteriaLedger e DoneGate. O renderer React recebe somente o IPC tipado. SQLite continua a fonte de verdade: `runs`, `run_steps`, `agent_invocations` e mensagens/relatórios. Não há migração nova (schema 19), motor concorrente separado, biblioteca de grafo ou inferência adicional de apresentação.

## fileReads

O defeito era de ordem e transporte: a delegação era feita antes de executar `fileReads` da decisão, e `buildWorkerPrompt` não recebia os bytes. O feedback do supervisor continha apenas a rodada anterior, enquanto os registros de leitura faziam o fluxo parecer abastecido. O modelo podia pedir leitura/delegação novamente, sem progresso de diff, e acionar políticas de não progresso/escalada.

Agora a aplicação lê antes de delegar. `fileContext` conserva a leitura mais recente de cada path e entrega conteúdo real a supervisor/worker com orçamento agregado de 64 KiB, cortes UTF-8 completos e metadados path, origem/SHA, hash, bytes, truncamento e intervalo. `offsetBytes` permite pedir outro trecho. O payload do supervisor é anexado uma única vez. READ e CARRIED são fatos separados; NOT_CARRIED impede a chamada. Ausência explícita de payload é falha mecânica e interrompe a repetição. Uma delegação em lote idêntica sem nova evidência também para.

CARRIED registra a montagem do payload da aplicação; não afirma que um provedor remoto interpretou o arquivo. Testes verificam AgentInput, adaptador Claude e transporte stdin a processo real. Isso não substitui uma inferência autenticada no Claude Code.

Consulta somente leitura pode satisfazer critérios nomeados via `queryProof` quando a resposta cita path e trecho literal efetivamente fornecido ao supervisor, sem alterações nem comandos de verificação registrados. Objetivos de edição continuam sujeitos à evidência de mudanças e ao DoneGate existente. Não se inventa PASS de código executado.

## Grafo e navegação

`execution-graph.ts` projeta deterministicamente os registros em nodes/edges, com IDs estáveis e referências às fontes. Objetivo, invocações, grupos de operações, evidências, verificações, join e estado terminal são visíveis. Apenas intervalos de workers realmente sobrepostos aparecem na mesma linha; dependências explícitas ligam suas invocações. Sem invocação não existe participante. Registros antigos são reconstruídos com os dados disponíveis, sem inventar dependências que não eram persistidas.

`ExecutionWorktree.tsx` usa SVG para conexões e cards HTML acessíveis, com pan, zoom, ajuste, foco, seleção, navegação parent/children, teclado, colapso e descarte de elementos fora da viewport. O painel lateral mostra detalhes, modelo/raciocínio, duração e consumo somente quando registrados. A resposta integral do provedor permanece no relatório; o resumo usa campos estruturados e primeiras linhas. A antiga Activity continua em “Ver execução linear”. A conversa reaberta carrega sua última run persistida; o seletor permite abrir execuções anteriores. Ações do histórico não alteram inadvertidamente a run atual.

A barra Windows conserva controles nativos de janela, com titleBarOverlay, região de arraste e menu via Alt. O CSS mantém contraste, estados textuais e preferência por movimento reduzido.

## Execução de subtarefas

A decisão pode conter até oito `delegations` com `taskId`, `workerId`, `task`, `dependsOn` e `requiresTools`. A validação rejeita IDs duplicados, dependências ausentes e ciclos. Tarefas prontas são agendadas em ondas, respeitando conta/runtime exclusivo. Resultados de dependências acompanham o prompt seguinte; falha/cancelamento impede dependentes.

GitHub direto permite até três invocações simultâneas quando não há teto de orçamento configurado. Cada tarefa recebe diretório próprio e a mesma base SHA para propostas da onda. Propostas sobre o mesmo path geram conflito; nenhuma delas é aplicada automaticamente. Propostas compatíveis são reunidas em um único commit usando RepositoryOperations e suas permissões existentes. Um join parcial não pode passar diretamente a DONE. Cada resultado guarda a invocação, estado, resumo e arquivos da própria tarefa, sem atribuir a todos os arquivos da onda.

Execução local e runs com teto configurado são sequenciais: preservam isolamento e os limites rígidos sem reservas especulativas. Não foi introduzido Git worktree temporário. O componente visual Execution Worktree não é um checkout Git.

`run.cancelTask` cancela somente o runner da subtarefa ativa, persiste a invocação como cancelada e ignora sucesso tardio. Cancelar a run sinaliza todas as branches. Estados terminais nunca mantêm nós ativos.

## Verificação e limites de evidência

- Testes de domínio: bytes/ranges/budget de contexto, queryProof, schema, DAG, reconstrução, stdin real, relatórios longos, independência/dependências, conflitos, repetição e cancelamentos.
- Electron: interface real Chromium, IPC, histórico, permissões, contas e testes anteriores preservados.
- Smoke: aplicativo empacotado, SQLite, preload/IPC, onboarding, grafo de fixture persistida, detalhes, zoom, janela e recarga. Fixtures de agentes são explicitamente identificadas.
- `scripts/probe-execution-github.mjs --create-disposable`: cria um repositório privado de teste, usa o transporte GitHub real da aplicação, lê árvore/conteúdo, cria branch/commit, confere bytes e evidências, abre PR draft e confirma que a base não mudou. Requer `gh` autenticado; token fica só em memória.
- Prova executada: [PR descartável](https://github.com/Arcanjog1/orchestrator-e2e-20260909150632/pull/1), commit `933b5fd46e6339fc3816ad657266ebfe07fd0765`, base `2af8222faac130f9d7af70cb0d5b2ec4a1269bd0` preservada.

Não se afirma validação de inferência multi-agent autenticada com Codex e duas contas Claude: o host não expõe Claude Code no PATH. A concorrência do motor foi exercitada com runners controlados; GitHub e Windows/Chromium são transportes reais. Respostas já truncadas pelo runtime antes de chegar ao aplicativo não podem ser recuperadas. Runs históricas anteriores ao novo registro de taskId conservam apenas as relações reconstruíveis dos fatos existentes.
