# Contrato de conclusão e mínima orquestração

Correção iniciada em `8fdb66f2b98162eb3be5daaf3546b5db05044b69`, na `main`. A implementação foi feita na ordem: contrato de implementação/evidência/DoneGate, depois política de complexidade. Nenhum asset, tema, animação ou CSS do RPG foi alterado.

## Incidente confirmado

O registro local `run-d39351ac420f4440a0d1` confirma 10 invocações, duas chamadas de implementação, seis verificações de arquivo e encerramento na iteração 9 por limite de tentativas. O workspace dessa execução era uma pasta local sem Git. O banco original foi consultado somente para leitura.

| Pergunta | Causa confirmada no registro e no fluxo anterior |
|---|---|
| A. Por que PASS não encerrou? | O primeiro `file-check` passou na iteração 2. Na 3, `readProofProblems` ignorou esses checks e recusou o DONE. Havia ainda uma obrigação falsa de executar testes. |
| B. Por que faltava árvore? | A inicialização local de `queryEvidence` não coletava árvore/existência e, sem Git, nem criava o snapshot mínimo. O texto sobre a visão Working Tree também acionava a obrigação de árvore. |
| C. Por que faltava conteúdo grounded? | `readProofProblems` aceitava apenas `queryProof.citations` sobre `fileReads` entregues ao supervisor; `fileChecks` com bytes e hash não entravam nessa avaliação. |
| D. Por que prova virou reimplementação? | A rejeição era uma lista de strings devolvida ao modelo. Nenhum estado ou regra do motor reservava a próxima ação à coleta de prova. |
| E. Por que houve segunda delegação? | A iteração 4 retornou um DAG com uma nova missão de criação. Essa representação e os novos critérios passaram pelas proteções de repetição. |
| F. Onde nasceu 36 → 37? | O primeiro task dizia `AI Orchestrator Team Test\nStatus: OK`, sem newline extra. O task e as constraints da iteração 4 passaram a exigir `AI Orchestrator Team Test\nStatus: OK\n`. Não foi uma conversão do filesystem: a segunda instrução mudou. |
| G. Por que fatos repetidos pareceram novos? | Havia registros novos por medição/iteração; os critérios variaram entre português, inglês, newline literal e escape textual, embora o hash de 37 bytes permanecesse igual. |
| H. Por que o anti-loop não interrompeu? | O detector de rejeições só via propostas DONE; as iterações 5–8 foram `verify`. O detector geral também dependia de critérios mutáveis e, anteriormente, da resposta do agente. |
| I. Por que NEEDS_HUMAN? | `AgentExecutionPolicy` convertia inclusive `ATTEMPTS` em `NEEDS_HUMAN`. O limite interno não identificava uma ação que o usuário pudesse resolver. |

Dois erros adicionais foram reproduzidos: `Test` dentro do literal era interpretado como comando de execução; e `compareFileBytes` retornava sucesso após comparar texto, antes de verificar `expectSizeBytes`. No incidente, os checks pediram 35 bytes para um texto de 36 e 36 para um texto de 37.

## Contrato novo

- `mission-contract.ts` preserva objetivo, critérios canônicos, caminhos, conteúdo, bytes hexadecimais, tamanho, SHA-256 e política de newline. Literais delimitados por cercas, aspas ou bloco explícito são dados. Expectativas já fixadas não podem ser substituídas por outra decisão.
- `FileCheckResult.measurement` contém caminho, existência, tamanho, SHA-256, codificação, conteúdo/range, origem e resultado da comparação exata. O verificador local e o GitHub usam o mesmo comparador.
- O DoneGate reabre os arquivos antes de decidir e avalia o bridge sobre essas medições frescas. Uma comparação exata satisfaz o conteúdo do output; uma explicação semântica continua exigindo leitura e citações entregues ao supervisor.
- A árvore é uma listagem real e limitada, coletada separadamente. Um único arquivo não é tratado como prova de toda a árvore. Listagens incompletas continuam incompletas.
- `CompletionState` separa implementação de verificação. Worker com execução concluída e prova global pendente não é rotulado como parcial por esse único motivo.
- Critérios de uma missão literal são fixados e associados apenas a medições compatíveis. Comparar conteúdo não prova comportamento funcional ou outro arquivo.

| Rejeição | Ação |
|---|---|
| `MISSING_PROOF`, `UNVERIFIED_OUTPUT` | Coletar prova; não pagar outra implementação. |
| `FAILED_CRITERION`, `IMPLEMENTATION_MISMATCH` | Correção permitida quando existe falha medida. |
| `MECHANICAL_FAILURE` | Diagnosticar infraestrutura; não escalar modelo como correção. |
| `PERMISSION_REQUIRED` | Usar o fluxo de autorização. |
| `USER_INPUT_REQUIRED` | Solicitar o requisito ou conexão que falta. |
| `VERIFICATION_STALLED` | Encerrar como FAILED com diagnóstico, antes de uma terceira coleta equivalente. |

A identidade de evidência usa o fato medido, resultado, path, hash, bytes e critério. Timestamps, IDs e número de iteração não são progresso. Uma nova paráfrase também não é progresso de verificação. Diagnósticos de tarefas semânticas distintas continuam sendo informação útil, sem se tornarem prova automática de código correto.

## Mínimo processo necessário

`complexity.ts` classifica a missão antes da primeira decisão. TRIVIAL seleciona no máximo um executor; SIMPLE normalmente usa um Programador e testes determinísticos. STANDARD admite investigação/revisão; COMPLEX admite múltiplos subsistemas e paralelismo. Uma falha real permite promoção, registrada junto de sua causa. A classificação não amplia permissões, modelos ou contas.

O fluxo literal é: plano → um executor → filesystem/bytes/hash → DoneGate → resposta final. O aplicativo produz os checks canônicos mesmo se o plano do modelo não os enviar. As transições de medição e gate não invocam um modelo. Após PASS não há nova consulta ao Orquestrador.

As métricas persistidas incluem `complexityClass`, `plannedAgents`, invocações esperadas/reais, invocações de workers, passos determinísticos, retries e estagnação. O mapa compacto possui cinco nós; o diário possui seis entradas, preservando o mesmo conjunto de IDs de `execution_events`. Detalhes completos permanecem expansíveis. As demais missões mantêm suas ramificações reais.

## Regressões e reprodução

`tests/completion-contract.test.ts` cobre 36 bytes, formato original sem cercas, missing proof, mismatch de 37 bytes, spec drift, dedupe, proibição de redelegação para reparar prova, estagnação e conflito entre texto/tamanho. `tests/minimum-orchestration.test.ts` configura Analista, Programador e Testador e prova os fluxos TRIVIAL, SIMPLE e STANDARD.

```powershell
npm run typecheck
npm test
npm run desktop:test
npm run package
npm run -w apps/desktop test:packaged
node apps/desktop/scripts/rpg-visual.mjs --mission --binary="apps/desktop/release/win-unpacked/AI Orchestrator.exe" --output=out/completion-contract/packaged
```

A missão visual usa adaptadores determinísticos de agente, subprocesso real para criar o arquivo, filesystem real, SQLite real, DoneGate real e a interface Electron real. Ela não consome chamadas de provedores. O relatório registra essa origem para não confundir teste reproduzível com benchmark de uma LLM conectada. O CI existente executa a mesma missão empacotada em Windows e Linux e publica o instalador Windows por commit.

Conteúdo obrigatório, UTF-8, 36 bytes, sem newline final:

```text
AI Orchestrator Team Test
Status: OK
```

O newline de fechamento da cerca acima é apresentação. O teste compara os bytes, não essa representação Markdown.
