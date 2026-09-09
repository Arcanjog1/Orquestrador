# Matriz final da auditoria funcional

Data: 2026-09-09. Ler com [o relatório](FUNCTIONAL_AUDIT.md). “—” significa não exercitado nessa camada; não significa falha. PASS é restrito aos casos nomeados. Testes Electron são integração de janela real, e não prova de empacotamento por si só. Doubles jamais contam como REAL PROVIDER. Resultado final dos comandos/CI/instalador: `functional-audit-artifacts/DELIVERY_VERIFICATION.md`, entregue junto à auditoria.

| FEATURE | STATUS | UNIT | INTEGRATION | PACKAGED | REAL PROVIDER | REAL WINDOWS | BUG | RISK | FIX |
|---|---|---|---|---|---|---|---|---|---|
| onboarding | PASS nos casos | — | Electron 10–11 | checklist | — | Electron/pacote | — | Primeiro login externo não incluído | Preservado |
| login | PARTIAL | managers/progresso | Electron 17–18; GitHub 26 | — | auth status Claude | Janela real; auth simulada | T1 corrida no teste | Fluxo externo completo não provado | Double apenas na fronteira do teste |
| contas | PARTIAL | claude/codex-accounts | Electron 16; policies | persistência via agentes | Uma identidade Claude | Processos/profile | B4 | Duas identidades NOT TESTED | Estado e política por conta |
| provedores | PARTIAL | providers/adapters | transporte controlado | runtime diagnose | Claude Code 2.1.252 | CLI real | B6 | API paga NOT TESTED | Bloqueio de flags incompatíveis |
| agentes | PASS nos casos | audit-agents | IPC e Electron 41 | CRUD/restart | — | Renderer/pacote | B1 | Papéis fixos suportados | CRUD e sessão por agentId |
| workers | PARTIAL | routing/adapters | delegações controladas | grafo de invocações | Um Claude | ProcessManager | B2/B4/B6/B9 | Dois externos NOT TESTED | Tetos e isolamento |
| orchestrator | PARTIAL | routing | audit-orchestrator | grafo | — | Integração local | B3 | Codex externo com teto NOT TESTED | Teto antes de chamar/reparar |
| modelos | PARTIAL | audit-model-observation | routing/invocações | — | Alias enviado; observado ausente | CLI real | B8 | Catálogo estático | Enviado separado de observado |
| reasoning | PARTIAL | routing/providers | adapters | — | low enviado; observado ausente | CLI real | B2/B6 | Reasoning interno não observado | Clamp e bloqueio |
| model ceiling | PASS controlado | audit-hard-ceilings | audit-orchestrator; desktop-routing | — | — | Integração local | B2/B3/B6 | Sem matriz externa de modelos | Interseção agente/conta |
| premium policy | PASS controlado | account-policy; audit-hard-ceilings | adapters/routing | — | — | Integração local | B2/B9 | Não certifica cobrança | Bloquear premium/default desconhecido |
| projetos | PASS nos casos | workspace/project | Electron 12–14,22–25,29–36 | workbench/grafo | — | Git/renderer real | — | Não cobre todo tipo de projeto | Preservado |
| sidebar | PASS nos casos | — | Electron 20,23,35,40 | workbench | — | Mouse/teclado reais | ⋯ não reproduzido | Todos os controles não exauridos | Sem patch AppSidebar |
| conversas | PASS nos casos | chat/session | Electron 20,22–23,35 | workbench | — | Renderer real | — | Sem teste externo multiprovedor | Preservado |
| runs | PASS nos casos | state-machine | orchestration; Electron 24 | grafo | Carry direto, não run inteira | Integração local | B3 | Run completa com dois externos ausente | Bloqueio explicável |
| GitHub | PARTIAL | github-client/access | Electron 26; audit-github-auth | — | Leitura via gh | safeStorage consultado | B5/B7 | Credencial do produto ausente | Diagnóstico e recovery |
| private repositories | PARTIAL | github-access/reader | owner/selected/401/403/404 | — | README privado via gh | Claude recebe conteúdo | B7 | Concessão externa NOT TESTED | Liberar acesso/verificar |
| public repositories | PASS nos casos | github-repository-reader | github-project-run | — | Leitura anônima octocat/Hello-World | RepositoryReader real | — | README de 13 bytes | Preservado |
| local | PASS nos casos | workspace/file | git fixtures | workbench | — | Git local real | — | Pastas de teste isoladas | Preservado |
| repository tree | PASS nos casos | github-discovery/reader | projeto GitHub controlado | — | — | Integração local | — | Árvore externa grande não provada | Preservado |
| fileReads | PASS nos casos | file-reads/context | carry/read-only | grafo de leitura | 147/147 bytes + citação | Claude real | — | Um arquivo externo pequeno | Preservado e revalidado |
| fileChecks | PASS nos casos | file-check | evidence/permissions | — | — | Filesystem real | — | Sem matriz externa completa | Preservado |
| change proposals | PASS controlado | github-operations | propostas controladas | — | — | Integração local | — | Nenhuma nova escrita externa | Preservado |
| branch | PASS nos casos | git | Electron 25; git fixtures | — | Push da branch de trabalho | Git real | — | Sem merge main | Preservado |
| commit | PASS nos casos | git | git fixtures | — | Commits desta entrega | Git real | — | Não prova todos os fluxos da UI | Preservado |
| PR | PASS controlado | github-operations | fake GitHub | — | — | Integração local | — | Nenhuma PR nova nesta auditoria | Preservado |
| Activity | PASS nos casos | execution-graph | invocações de dois agentIds | detalhes/zoom/reload | — | Renderer/pacote | B8 | Dois externos NOT TESTED | Observação e identidade |
| permissions | PASS nos casos | tool-permissions | permission-resumption; Electron 37 | — | — | Renderer real | — | Sessão externa nova NOT TESTED | Preservado |
| resumption | PASS controlado | permission-resumption | mesma run/recusa/cancel | — | — | Integração local | — | Dois logins externos não provados | Preservado |
| cancelamento | PASS nos casos | cancellation | Electron 21; dois processos | estado terminal no grafo | — | Child processes reais | — | Cancel Claude duplo NOT TESTED | Preservado |
| DoneGate | PASS controlado | done-gate | read-only/verification | — | — | Integração local | — | Sem run externa de ponta a ponta | Preservado |
| evidências | PASS nos casos | evidence/fileChecks | integração do gate | detalhes | hash/bytes/citação | Filesystem/CLI | — | Não extrapolar uma leitura | Preservado |
| AcceptanceCriteriaLedger | PASS controlado | done-gate/ledger | persistência/replay | — | — | SQLite local | — | Sem critério externo novo | Preservado |
| routing | PASS controlado | policy/model-router | desktop-routing/audit | — | Um envio sonnet/low | CLI e integração | B2/B3/B4/B6/B9 | Política comercial externa opaca | Filtro completo e falha fechada |
| duas contas | PARTIAL | managers | audit-process/routing-isolation | — | NOT TESTED: mesma identidade | Dois Node reais | B4 | Duas quotas não provadas | Isolamento por slot/profile |
| persistence | PASS nos casos | repositories/schema | reopen SQLite | agentes/grafo | — | Dois processos de app | B1 | Config antiga sem observação | Migração 20 |
| restart | PASS nos casos | session repositories | reopen | mesmo SQLite, dois processos | — | Pacote Windows | B1 | Não é upgrade NSIS instalado | Escopo legado preservado |
| histórico | PASS nos casos | chat/invocations | Electron 20; tombstone | grafo/reload | — | Renderer/pacote | B1 | Remoção de agente é lógica | Histórico retido |
| updater | NOT TESTED real | baseline de serviços | Não reexercitado especificamente | — | — | Instalador gerado; sem instalar | — | Atualização do usuário não provada | Sem alteração |
| interface | PARTIAL | contrato/validação | 41 casos Electron | smoke e screenshots | — | Mouse/teclado/renderer | B1/B7/B8 | Acessibilidade/double click incompletos | Formulários e diagnóstico |
