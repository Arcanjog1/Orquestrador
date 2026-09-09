# Inventário funcional antes das correções

Baseline remoto: 27c39eb3d047ccae33462e71c996cc70be8b43bd. Branch: claude/ai-orchestrator-buzz-arch-vblrau. Clone novo functional-audit. Schema 19. Electron 44.1.1. Nenhum AGENTS.md encontrado.

Renderer React → preload tipado → validação/roteador IPC → serviços main → núcleo e SQLite. Scripts test/typecheck/build; desktop test:electron/package/test:packaged. CI Linux+Windows com NSIS e smoke de reabertura.

Baseline executado no Windows: 909 testes, 906 passam, 3 skips, 0 falhas. Testes existentes não provam toda funcionalidade. Pacote e provedores ainda pendentes nesta auditoria.

| FUNCIONALIDADE | IMPLEMENTADA? | TESTADA? | RUNTIME? | EMPACOTADO? | STATUS | RISCO | BUG | CORREÇÃO |
|---|---|---|---|---|---|---|---|---|
| onboarding | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| login | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| contas | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| provedores | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| agentes | Parcial: CRUD ausente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | P1 | Identidade derivada da conta | Pendente |
| workers | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| orchestrator | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | P1 | Em investigação | Pendente |
| modelos | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| reasoning | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| model ceiling | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | P1 | 5 testes reproduzem bypass manual/fallback/flags | Pendente |
| premium policy | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| projetos | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| sidebar | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | ⋯ ainda não reproduzido | Pendente |
| conversas | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| runs | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| GitHub | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| private repositories | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| public repositories | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| local | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| repository tree | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| fileReads | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| fileChecks | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| change proposals | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| branch | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| commit | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| PR | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| Activity | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| permissions | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| resumption | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| cancelamento | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| DoneGate | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| evidências | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| AcceptanceCriteriaLedger | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| routing | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | P1 | Em investigação | Pendente |
| duas contas | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| persistence | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| restart | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| histórico | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| updater | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
| interface | Código presente | Baseline global; cenário pendente | Pendente | Pendente | Auditoria aberta | A classificar | Em investigação | Pendente |
