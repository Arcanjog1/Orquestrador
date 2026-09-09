# Fase 2: agentes e políticas de execução

Base remota: `16ddb4d71bbe5b040099c639b2db3332312084cc`, branch `claude/ai-orchestrator-buzz-arch-vblrau`. Implementação em clone novo; nenhuma alteração em main ou nos perfis originais.

## Arquitetura e compatibilidade

`shared/agent-policy.ts` contém o registro extensível de papéis e os contratos portáveis. Papel semântico, provider e conta são independentes. Os slots legados ORCHESTRATOR/CODING_WORKER continuam compatíveis com o loop e o histórico; PROGRAMMER, ANALYST/REVIEWER, DESIGNER, TESTER e RESEARCHER são papéis de delegação. IMAGE_GENERATOR permanece UNAVAILABLE porque não há adapter de imagem implementado.

`AgentService` gerencia agentes, políticas globais, políticas de projeto e equipes padrão. Os IDs permanecem estáveis ao renomear; a exclusão desativa o agente sem apagar evidências. A migração 21 adiciona snapshots de invocações, chamadas de política, confirmações e escopos; não recria nem remove tabelas existentes. Novos projetos herdam a equipe padrão; projetos existentes mantêm sua configuração.

`resolveAgentPolicy` intersecta agente, global, projeto, conta e capacidades declaradas pelo runtime. FIXED usa apenas o ID principal e bloqueia incompatibilidades. CONTROLLED_AUTO considera somente o principal e fallbacks explicitamente permitidos, em ordem. Um pedido do supervisor não amplia essa lista. Confirmações premium são vinculadas à execução, agente, modelo e fingerprint das políticas; mudanças invalidam a confirmação.

`AgentExecutionPolicy.invoke` é a fronteira antes de chamadas de supervisor e delegado, inclusive reparo de esquema, recuperação de sessão e retomada. Ela relê políticas, conta tentativas persistidas e aplica ferramentas, timeout e limites de uso. Chamadas recusadas geram auditoria, mas não uma invocação fictícia no grafo. Falhas lançadas pelo runtime consomem tentativas. Na inicialização, chamadas interrompidas são encerradas sem inventar uso ou observações.

A disponibilidade de modelo vem do backend: ajuda/capacidades do Claude, cache de modelos e capacidades do Codex, ou descoberta do provider API quando habilitado. Aceitação de ID pelo CLI não prova acesso da conta nem identifica o modelo realmente usado: esses campos podem permanecer desconhecidos.

## Ferramentas e execução

Claude recebe `--tools` com allowlist real e `--strict-mcp-config`; permissões amplas do workspace não reinserem escrita ou shell em analistas. Codex recebe sandbox read-only/workspace-write, configurações de ferramentas e bloqueio de funcionalidades não permitidas. Perfis Codex com MCP configurado são recusados quando o contrato não pode ser garantido. Não há fallback automático de assinatura para API paga.

O scheduler escolhe agentes ativos compatíveis com o tipo de tarefa e a política de roteamento. A DAG existente é mantida; propostas GitHub podem executar em paralelo e só entram no join autorizado. Escrita local permanece serial: esta fase não implementa checkouts Git isolados por delegado local. A visualização Worktree mostra invocações reais e snapshots, não representa novos worktrees Git locais.

Os adapters são determinados pelo provider e tipo de conexão da conta (Codex CLI, Claude Code CLI, OpenAI API, Anthropic API). Não há carregamento de adapters arbitrários. As restrições de ferramentas usam os mecanismos desses runtimes; não constituem uma nova sandbox de sistema operacional para o Claude nem controlam hooks externos configurados pelo usuário.

## Interface

A tela Agentes e modelos permite CRUD, escolha independente de papel/provider/conta, FIXED/CONTROLLED_AUTO, listas permitidas/bloqueadas/fallbacks, raciocínio e tetos, ferramentas, permissões, tentativas, timeout, uso e paralelismo. A mesma tela contém catálogo/regras globais, roteamento e equipe padrão. O projeto oferece sua própria camada de restrição. Os detalhes da execução mostram solicitado, limitado, enviado e observado separadamente, com confirmação premium explícita.

## Validação reproduzível

- `npm run typecheck`
- `npm test`
- `npm run -w apps/desktop test:electron`
- `npm run package`
- `npm run -w apps/desktop test:packaged`
- `node apps/desktop/scripts/agents-accounts-live.mjs --source-home=... --output=... --cancel-test --policy-boundary` (ver argumentos no script; teste opt-in com contas locais já conectadas)
- `node apps/desktop/scripts/repository-query-live.mjs --source-home=... --source-chromium=... --binary=... --output=...`

Os testes novos cobrem interseção das políticas, papéis, chamadas repetidas, premium/retomada IPC, tentativas após exceção, recuperação, snapshots, bloqueios Astra/Fable, ferramentas reais no argv, CRUD Electron e persistência no pacote. A suíte existente cobre DoneGate, grounding/fileReads, consultas read-only e menus.

Duas contas Claude autenticadas foram executadas simultaneamente via fronteira central em Windows. Os hashes de identidade e de sessão diferiram; cancelar a primeira não cancelou a segunda. O provider recebeu `sonnet`; modelo e raciocínio observados ficaram desconhecidos. Não houve uso de API paga nem execução nos perfis originais. O harness guarda caminhos dos perfis temporários para descarte explícito; não inclui credenciais no relatório.

## Limites da evidência

Limites de tokens/custo são conferidos entre chamadas. Uma chamada pode ultrapassar o saldo; ausência de uso informado impede novas chamadas quando existe limite. Estimativas de custo de assinatura não são cobrança API comprovada. Não foram realizados testes pagos de Astra/Fable ou APIs. Não foi comprovada em provider real cada combinação de papel/modelo/provider: a matriz da entrega distingue testes simulados, Electron, pacote e provider real.

O resultado final de CI, o SHA publicado e o link do instalador devem ser verificados na release por commit, não inferidos deste documento. O relatório de entrega registra os 47 itens e as matrizes requeridas.
