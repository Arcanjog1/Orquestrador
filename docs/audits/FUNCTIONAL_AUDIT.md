# Auditoria funcional — 9 de setembro de 2026

Esta auditoria acrescenta gestão independente de agentes, fecha desvios de teto no roteamento e melhora o diagnóstico de autorização GitHub. As provas abaixo distinguem execução local, doubles de provedores e chamadas externas. PASS se refere ao cenário executado, nunca a toda combinação possível.

## 1–3. Origem e inventário

HEAD inicial: `27c39eb3d047ccae33462e71c996cc70be8b43bd`. Branch: `claude/ai-orchestrator-buzz-arch-vblrau`. Repositório: [Arcanjog1/Orquestrador](https://github.com/Arcanjog1/Orquestrador). Clone novo `functional-audit`, separado do trabalho anterior; baseline remoto atualizado por fast-forward. Nenhum reset, force push ou merge na main.

O [inventário anterior às correções](FUNCTIONAL_AUDIT_BASELINE.md) registra 40 áreas, arquitetura e baseline: 909 testes, 906 aprovados, três ignorados no Windows, nenhuma falha. A [matriz final](FUNCTIONAL_AUDIT_MATRIX.md) separa UNIT, INTEGRATION, PACKAGED, REAL PROVIDER e REAL WINDOWS.

## 4–7. Bugs, severidade, causa e correção

| ID | Severidade | Reprodução / causa | Correção e prova |
|---|---|---|---|
| B1 | P1 | `agents.create` inexistente no IPC; identidade determinística por conta impedia criar agentes independentes | CRUD com IDs próprios, edição/desativação e remoção lógica; `audit-agents.test.ts`, Electron e reinício do pacote |
| B2 | P1 | Manual ignorava teto; fallback podia subir acima dele; premium recusado e candidatos esgotados caíam no padrão do CLI | Filtrar todos os candidatos, bloquear escolha manual fora do teto e execução cujo limite não pode ser garantido; `audit-hard-ceilings.test.ts` |
| B3 | P1 | Orquestrador não passava pela política da conta; manual acima do teto ainda invocava o runner | Política antes da primeira chamada e preservada na reparação de resposta; auto FAST/LOW em duas chamadas, manual STRONG bloqueado sem chamada; `audit-orchestrator.test.ts` |
| B4 | P1 | Lista de modelos indisponíveis compartilhada: a recusa de sonnet na conta A levava a conta B a opus | Histórico e modelos indisponíveis por worker; `audit-routing-isolation.test.ts` |
| B5 | P1 | Token GitHub expirado, sem refresh, era classificado como utilizável | Classificação `expired` antes do uso; `audit-github-auth.test.ts` |
| B6 | P1 | Adapter podia retirar flags exigidas; API podia descartar reasoning incompatível | `strictRouting` recusa chamada sem garantia; APIs não fazem HTTP nesses casos; `providers.test.ts` e testes de routing/adapters |
| B7 | P2 | A UI não separava credencial, identidade e autorização de repositórios com passos de recuperação claros | Diagnóstico atualizado, instalação/owner/seleção/permissões, Liberar acesso e Verificar novamente; `audit-github-auth.test.ts`, `github-access.test.ts` |
| B8 | P2 | Modelo enviado era apresentado como efetivo sem comprovação externa | Separar enviado e informado pelo provedor; persistir observação estruturada, mostrar “não informado” quando ausente; `audit-model-observation.test.ts` |
| B10 | P1 | Pausa de política do worker deixava o loop chamar o supervisor novamente (3 chamadas no fluxo simples, 2 no DAG) e podia perder a causa original | Encerrar loop após pausa simples ou rodada paralela, antes de propostas/nova chamada; `audit-orchestrator.test.ts` |
| B9 | P1 | Claude sem modelo explícito/flag verificável podia usar padrão desconhecido com premium desativado | Bloquear esse caminho e tornar obrigatória a preservação do modelo na adaptação; teste de padrão não verificável |

Os testes de reprodução falharam antes das respectivas correções. Logs vermelhos relevantes: `audit-red-ceilings.log`, `audit-agents-red.log`, `audit-orchestrator-red.log`, `audit-isolation-red.log`, `audit-api-red.log`, `audit-premium-default-red.log`, `audit-pause-red.log`. A falha do token expirado também foi registrada em `audit-fixed-targeted.log` durante a investigação. A evidência local completa fica na pasta irmã `functional-audit-artifacts`; nenhum token foi colocado no relatório.

A falha intermitente do teste Electron de login era de instrumentação: o teste reproduzia eventos enquanto um Codex descoberto na máquina iniciava login real. A fronteira de autenticação desses dois testes de mensagens agora usa um double local, mantendo janela, preload, IPC e renderer reais. Não é alegada nova prova de login externo.

## 8. Agent creation verdict

**PASS nos fluxos executados.** Settings → Agentes permite criar nome, papel, conta, modelo, reasoning, tetos e estado ativo; editar, desativar e remover. O provedor acompanha o papel suportado: OpenAI para orquestrador, Anthropic para worker. Não há novos papéis genéricos nesta entrega.

Dois agentes de mesmo nome e mesma conta recebem IDs diferentes. O teste selecionou ambos na equipe, executou duas delegações com runners controlados e conferiu `agent_id`, `account_id` e sessões distintas. A conta fornece credencial; o agente fornece identidade/configuração. Nomes semelhantes não são usados como chave. Papel/provedor incompatível, conta errada e modelo desconhecido são recusados. Agente desativado não pode ser escolhido/executado. Configurar conta desconectada é permitido; executar agente gerenciado exige conexão.

Remoção lógica preserva histórico e não ressuscita na sincronização. Schema 20 preserva sessões antigas no escopo legado e dá aos agentes gerenciados escopo próprio. CRUD pelo renderer foi executado; persistência também é verificada por dois processos do aplicativo empacotado.

## 9–10, 13–16. Tetos, routing, modelo observado, premium e fallback pago

**PASS nos testes de política e integração; validação real de todas as combinações: NOT TESTED.** Vale a interseção dos tetos de agente e conta. Escolha manual acima do teto é bloqueada; reasoning pode descer para nível compatível. Auto e fallback filtram candidatos. Sem candidato ou sem flag capaz de garantir o limite, a chamada não é liberada para um padrão desconhecido.

O orquestrador também recebe limites. O teste força resposta inválida e reparação: ambas usam `gpt-5.1-codex-mini/low` sob FAST/LOW. A tentativa manual `gpt-5.3-codex/max` sob esse teto termina em NEEDS_HUMAN antes de invocar. Recusa de modelo na conta A não altera candidatos da conta B. Falha mecânica e ausência de progresso continuam sem justificar escalada (`cancellation.test.ts`, routing e no-progress existentes).

Premium desativado bloqueia os aliases premium conhecidos, inclusive `fable` e variantes reconhecidas. Não há troca automática de CLI por conexão API paga; os transportes são explicitamente configurados. Isso **não certifica preço, quota ou faturamento do fornecedor**: os tiers são classificação do aplicativo, e a política comercial da conta não é observável integralmente pelo CLI.

Activity/detalhes distinguem solicitação, teto, nível após limite, argumentos enviados e observação externa. Modelo observado vem somente de campos estruturados reconhecidos; texto livre do modelo não comprova sua identidade. Respostas sem esses campos mostram “não informado”. Configurações antigas podem não ter observação persistida.

| ROLE | AGENT | ACCOUNT | REQUESTED MODEL | REQUESTED REASONING | CEILING MODEL | CEILING REASONING | ACTUAL MODEL | ACTUAL REASONING | RESULT |
|---|---|---|---|---|---|---|---|---|---|
| Worker real | ClaudeCodeAdapter, prova fileReads | Um perfil Claude autenticado | sonnet | low | Não exercitado nesta chamada | Não exercitado nesta chamada | Não informado | Não informado | Saída correta, exit 0, 7.271 ms |
| Orquestrador controlado | Supervisor | Conta de teste | Automático → gpt-5.1-codex-mini | low | FAST | LOW | NOT TESTED, double | NOT TESTED, double | Duas chamadas com os argumentos limitados |
| Orquestrador controlado | Supervisor | Conta de teste | gpt-5.3-codex | max | FAST | LOW | Nenhuma chamada | Nenhuma chamada | Bloqueado antes do runner |

## 11–12. Duas contas e isolamento

**REAL TWO-ACCOUNT VALIDATION: NOT TESTED.** Há dois perfis Claude distintos no computador, mas `auth status --json` identificou a mesma identidade do provedor nos dois. Um cadastro estava conectado e o outro desconectado. Duas pastas não comprovam duas contas/quotas independentes. Não foi alterada a autenticação instalada para produzir uma prova artificial.

**PASS com doubles e processos reais locais:** diretórios e variáveis de ambiente distintos, credenciais ambientes removidas, PIDs/saídas separados, cancelamento de A enquanto B conclui. `audit-process-isolation.test.ts` usa dois processos Node reais; eles **não são duas chamadas Claude reais**. Testes existentes dos managers verificam criação, ambiente, remoção limitada ao perfil e cancelamento somente do login correspondente. Quota real simultânea, disconnect externo de A sem afetar B e retomada com duas identidades diferentes permanecem NOT TESTED.

## 17–20. GitHub privado, autorização e recuperação

**PARTIAL.** Uma leitura privada real foi concluída com a autenticação já existente no GitHub CLI, seguida de entrega integral ao Claude. A credencial do próprio aplicativo instalado foi consultada por serviço isolado com Windows safeStorage e estava **ausente**. Portanto isso não prova login/instalação GitHub dentro do produto em conta real.

Fluxo implementado: conectar por código de dispositivo → conferir identidade → verificar acesso → ver owner/instalação, All ou Selected e permissões → Liberar acesso na página oficial → Verificar novamente. O aplicativo não pede ao usuário que copie token para esse fluxo. O teste Electron existente completa login e seleção privada usando servidor GitHub local controlado.

GitHub App usa instalação e seleção All/Selected; OAuth usa escopos e não oferece essa seleção de repositórios. O diagnóstico agora mantém essa distinção e mostra Contents/Pull requests quando informados pela instalação. Base oficial: [diferenças GitHub App/OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps) e [escopos OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

401 orienta reconectar; 403 orienta conferir permissões, organização e limites; 404 mantém a ambiguidade entre ausência e falta de acesso. Isso segue a [documentação REST](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api). Os testes de acesso cobrem owner sem instalação, repo fora da seleção e rechecagem após inclusão. Alterar All/Selected e incluir novo privado no site real do GitHub **não foi executado nesta auditoria**; portanto recuperação real sem token copiado permanece NOT TESTED.

## 21–25. UX, três pontos, interações, permissões e cancelamento

| Área | Veredicto | Evidência / limite |
|---|---|---|
| Projetos | PASS nos casos | Criar, mover conversas, arquivar/restaurar/remover; pasta preservada; Electron |
| Sidebar | PASS nos casos | Histórico, busca e associação por projeto; Electron |
| Overflow / ⋯ | NÃO REPRODUZIDO | Mouse nativo e Space abrem menu sem mudar hash/projeto ativo; nenhuma alteração em AppSidebar |
| Double click | NOT TESTED de forma abrangente | Não há prova universal de que toda ação execute uma só vez |
| Account setup | PARTIAL | Formulários/IPC exercitados; duas identidades externas ausentes |
| Agent setup | PASS nos casos | Criar, editar, desativar, remover e recarregar no renderer |
| Model settings | PASS nos casos | Tetos por conta no renderer e políticas testadas; catálogo limitado |
| GitHub | PARTIAL | Diagnóstico/fluxo controlado; autenticação real do produto ausente |
| Permissions | PASS nos casos | Responder na janela, preservar escopo e retomar mesma run nos testes de integração |
| Run / Activity | PASS nos casos | Cancelamento, estados terminais e participantes derivados de invocações persistidas |
| Error states / Loading | PASS nos casos | Falha de pré-condição termina progresso; respostas e causas exibidas; sem prova universal |
| Keyboard | PARTIAL | Space/Escape no ⋯ e controles de diálogo; não auditado todo atalho |
| Accessibility | PARTIAL | Labels e componentes acessíveis existentes; leitor de tela/contraste completos não exercitados |

O alegado bug ⋯ foi testado com um projeto alvo diferente do projeto ativo. O menu abriu, a navegação não mudou. Não foi acrescentado `stopPropagation` indiscriminado. Nenhum bug de clique duplo foi declarado corrigido sem reprodução.

Cancelamento mantém status terminal mesmo com resultado atrasado; não chama modelo para confirmar. Permissão aprovada retoma a mesma run, sem duplicá-la; autorização posterior ao cancelamento não revive a execução. Há prova em `permission-resumption.test.ts`, `cancellation.test.ts` e Electron. Não foi feita uma nova sessão completa de permissão com dois provedores externos nesta auditoria.

## 26–28. DoneGate, fileReads e Activity

**DoneGate: PASS nos cenários automatizados.** Evidência objetiva continua necessária: comando que falha, critério pendente/falhado, recusa de verificação e worker falho impedem DONE. Leituras não liquidam critérios de mudança. O ledger persiste e deduplica. Cenários read-only e duas iterações sem progresso permanecem cobertos pela suíte existente.

**fileReads: PASS automatizado e uma entrega real.** Em 2026-09-09, a leitura de `README.md` do privado `Arcanjog1/orchestrator-e2e-20260909150632`, revisão `933b5fd46e6339fc3816ad657266ebfe07fd0765`, percorreu GitHub → fileReads → buildWorkerPrompt → ClaudeCodeAdapter → ProcessManager → Claude Code 2.1.252. Foram enviados 147 de 147 bytes, sem truncamento, estado WORKER_CARRIED, SHA-256 `7b7d2dc8fde3e0a0152b164ba2eb784f8acf1ef2e847d077ee2cc18ccda38840`.

A resposta foi `README.md: "Execution Worktree: independently read and verified."`, exit 0. Isso comprova que o destinatário recebeu e interpretou esse trecho. Não foi criada uma nova PR nem modificado esse repositório nesta auditoria. A identidade exata de modelo/reasoning não foi informada pelo retorno estruturado.

**Activity: PASS nos casos automatizados.** O grafo deriva de invocações, preserva respostas completas e não cria participantes fictícios quando há zero chamadas. Dois agentes gerenciados na mesma conta aparecem com IDs distintos no registro de invocação. Dependências, branches/join, estados terminais, detalhes, zoom e reabertura possuem cobertura. Não equivale a prova de dois workers externos simultâneos.

## 29–37. Verificação, commits, CI e instalador

Os resultados finais, hashes dos commits, execução de CI e instalador são registrados em `DELIVERY_VERIFICATION.md` na pasta de evidências entregue após o push. Os testes Electron usam Electron real com renderer/preload do build; nomes antigos que dizem “packaged interface” não os transformam em prova do executável empacotado. Essa prova é separada, em `test:packaged`, com dois processos do binário e o mesmo SQLite.

Scripts executados: `npm test`, `npm run typecheck`, `npm run -w apps/desktop test:electron`, `npm run -w apps/desktop package`, `npm run -w apps/desktop test:packaged`. A CI exigida possui Windows e Linux; o instalador publicado pelo job Windows é identificado por tag `desktop-dev-<commit>`. Não se reutiliza como prova a release antiga `desktop-dev-27c39eb`.

## 38–39. Riscos e funcionalidades ainda não provadas

- Duas identidades Claude reais, quota concorrente, isolamento após disconnect real e execução completa Codex + dois Claude: NOT TESTED.
- Login GitHub do produto, alteração de instalação/owner/All/Selected e concessão de novo privado em conta real: NOT TESTED. A prova privada usou a credencial do GitHub CLI.
- Modelo real exato e reasoning efetivo da chamada externa: não informados pelo provedor. Argumentos enviados são conhecidos; não são apresentados como prova da decisão interna do fornecedor.
- Classificação estática de modelos e lista premium exigem manutenção. Novos modelos sob teto desconhecido são recusados; catálogo não promete disponibilidade por assinatura, preço ou quota.
- APIs foram exercitadas por transportes controlados; nenhuma chamada paga foi usada como prova. Não há certificação externa de cobrança.
- Permissões de organização, SSO, rate limits e paginação extensa de instalações não foram validados com grande conta real.
- Não houve auditoria completa de leitor de tela, double click em todo controle ou atualização automática de uma instalação de usuário. Executável empacotado e reinício são diferentes de executar o assistente NSIS sobre a instalação existente.
- Os três skips da suíte Windows são declarados nos logs; não contam como PASS. Probes opcionais do workflow devem ser lidos separadamente dos gates obrigatórios.

## Aceite A–AE

| Critério | Resposta baseada em evidência |
|---|---|
| A criar agente | PASS: CRUD por serviço/IPC e renderer |
| B persistir | PASS: SQLite e reinício do pacote |
| C conta correta | PASS com runners controlados: IDs de agente/conta nas invocações |
| D isolamento de contas | PASS de ambiente/processos controlados; duas identidades reais NOT TESTED |
| E simultaneidade | Dois processos reais com doubles PASS; dois Claude reais NOT TESTED |
| F worker respeita teto | PASS em routing/adapters/integração |
| G orchestrator respeita teto | PASS: auto e reparação limitados; manual bloqueado |
| H auto routing | PASS nos candidatos e fallbacks exercitados |
| I manual | PASS: modelo acima do teto bloqueado, reasoning limitado |
| J modelo mostrado é real | Enviado e observado separados; real externo não informado |
| K premium off | PASS para aliases e padrões não verificáveis testados; sem certificação de faturamento |
| L fallback pago silencioso | Nenhuma troca CLI→API implementada; transportes explícitos e testes preservados |
| M quota de A não contamina B | Recusa de modelo isolada nos testes; quota externa dupla NOT TESTED |
| N disconnect A não quebra B | Managers/processos controlados; disconnect externo duplo NOT TESTED |
| O público | PASS externo anônimo: RepositoryReader leu README, 13 bytes, octocat/Hello-World, commit 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d |
| P privado autorizado | PASS de leitura externa via gh; login real do produto NOT TESTED |
| Q explica como liberar | PASS no diagnóstico e recuperação controlados |
| R liberar sem copiar token | Implementado por device flow/página oficial; concessão real NOT TESTED |
| S All/Selected | Distinção App/OAuth implementada e testada; alteração externa NOT TESTED |
| T novo privado depois | Rechecagem passa em integração; concessão externa NOT TESTED |
| U ⋯ não abre projeto | PASS: mouse nativo e teclado sem navegação |
| V controles internos | PASS nos controles exercitados; afirmação universal NOT TESTED |
| W ação única por clique | PASS nos cenários exercitados; double click abrangente NOT TESTED |
| X loading termina | PASS nos cenários de falha/cancelamento/terminal; sem afirmação universal |
| Y erros compreensíveis | PASS de conteúdo nos casos testados; avaliação com usuários NOT TESTED |
| Z cancelamento | PASS em integração e processos locais |
| AA permissão retoma mesma run | PASS: testes de autorização, recusa, cancelamento e idempotência |
| AB participantes reais | PASS de derivação de invocações; não confundir com contas externas reais |
| AC fileReads chega | PASS: 147/147 bytes e citação correta pelo Claude |
| AD falha mecânica não escala | PASS nos testes de routing/no-progress existentes |
| AE restart preserva configuração | PASS no banco e processos empacotados |
