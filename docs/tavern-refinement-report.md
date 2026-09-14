# Refinamento do AI Orchestrator — relatório de entrega

Data: 14/09/2026. Branch: `codex/tavern-refinement`.
Base: `origin/main`, commit `ab93dbc0210cdbbeeeff6fdcf4d02755dd2786d9`.
Clone de trabalho: `tavern-refinement`, dentro da pasta original do projeto.

## Resumo executivo

Refinamento do aplicativo Electron existente, orientado pelas duas artes fornecidas:
taverna, madeira, pergaminho, personagens e mapa de missão. O projeto original permanece
na pasta de origem; o código entregue está no clone e na branch indicados acima.

## Problemas encontrados

- A versão compacta do diário tinha seis entradas; o mapa tinha cinco, com regras próprias de agrupamento.
- O agrupamento compacto substituía funções e tarefas por textos fixos de Programador/criação de arquivo.
- Muitas colunas e espaços reservados faziam os nós encolherem demais. O desenho não acompanhava bem a chegada de novos marcos.
- Detalhes de Git, modelos e diagnósticos disputavam espaço com o objetivo.
- Equipe e respostas desapareciam abaixo de 1280 px.
- A arte do ferreiro tinha quadriculado incorporado; os personagens apareciam pequenos nos cards.
- A detecção de rejeições comparava apenas a rodada anterior, permitindo ciclos A → B → A.
- A equivalência de missões removia letras maiúsculas e operadores relevantes para caminhos e código.
- A assinatura de lotes não considerava mudanças nas dependências, critérios e verificações.
- Respostas finais longas podiam consumir o espaço destinado à validação e às pendências.

## O que foi alterado

- Pergaminho mais suave, placas com cantos variados, molduras existentes preservadas, cards menos rígidos e personagens maiores.
- Objetivo e estado da missão no topo; controles do projeto e diagnósticos recolhidos.
- Caminhos com setas, sinais de atividade/bloqueio e distribuição em trilha que aproveita a altura.
- Agrupamento consistente de coordenação, chamadas e validação, sem nomes ou tarefas inventados.
- Respostas curtas com **Ver completo** no próprio painel; a resposta final vem primeiro.
- Diário com linha do tempo, horários, papéis reais, evidências e detalhes completos. A leitura não é empurrada ao final enquanto o usuário consulta entradas anteriores.
- Layout com rolagem mantém equipe e respostas acessíveis em 1024 px.
- Partículas e realce de caminhos discretos, respeitando `prefers-reduced-motion`.
- Nova arte do Programador sem quadriculado, com o original preservado.

## Como o fluxo do orquestrador passou a funcionar

O fluxo existente foi preservado e reforçado: objetivo → plano → seleção/delegação →
execução conforme dependências → retornos → avaliação das evidências → nova ação útil
ou conclusão. O DoneGate continua impedindo conclusão sem prova. A proteção de lotes
atua antes de chamar novamente os agentes. Novos arquivos, leituras, verificações ou
critérios permitem uma nova tentativa; voltar ao mesmo estado medido encerra a repetição
com motivo concreto. Finalização, cancelamento e retomada continuam sendo persistidos.

A coordenação e seleção de funções já existiam; este trabalho não substituiu provedores
nem criou respostas simuladas no produto. Os adaptadores controlados são apenas testes.

## Sincronização do Working Tree e do Raciocínio em linha

`executionTrace` produz os mesmos nós, resumos, textos completos e IDs de origem para
ambas as apresentações. `chronologicalTrace` usa diretamente essa projeção; o mapa
acrescenta apenas coordenadas. Transições agrupadas conservam registros e metadados.
As posições seguem dependências, independentemente da ordem de retorno das chamadas
paralelas. O fallback para históricos antigos continua disponível.

## Redução de loops e repetição

- Histórico de estados de evidência e rejeições identifica também ciclos não consecutivos.
- Missões preservam caminhos sensíveis a maiúsculas, operadores e conteúdo literal.
- Lotes levam em conta dependências reais, evidência, verificações e critérios.
- Mensagens idênticas do mesmo autor são deduplicadas em toda a execução, não apenas contra a última mensagem.
- Prévia pública remove frases idênticas repetidas; o resultado integral permanece disponível.
- A resposta final reserva espaço para validação e bloqueios; a interface preserva essas linhas.
- Mantida a garantia transacional de uma resposta final vigente por execução, incluindo reinício e retomada.

## Evidências visuais e validação manual

As capturas e logs ficam em `artifacts/` (ignorados pelo Git).

- `artifacts/before/worktree.png`: interface antes do refinamento visual.
- `artifacts/after/worktree.png`: missão com ramificações.
- `artifacts/after/agents.png`: equipe e identidades.
- `artifacts/after/workspace-1024.png`, `team-1024.png`, `responses-1024.png`: layout estreito.
- `artifacts/controlled-mission/worktree.png`: missão controlada com arquivo real.
- `artifacts/controlled-mission/linear-plan.png` e `linear-final.png`: diário da mesma missão.
- `artifacts/controlled-mission/controlled-run.json`: eventos e medições persistidos.

Para abrir o código entregue, execute na pasta deste clone:

```powershell
npm run desktop
```

No ambiente desta sessão, o npm foi localizado em `C:/Users/CIVIX/.cache/orchestrator-tools`.
Se ele não estiver no PATH, acrescente essa pasta antes do comando.

Para reproduzir a auditoria visual com banco isolado:

```powershell
npm run desktop:build
node apps/desktop/scripts/rpg-visual.mjs --output=artifacts/after
node apps/desktop/scripts/rpg-visual.mjs --mission --output=artifacts/controlled-mission
```

Confira: objetivo no topo; detalhes recolhidos; nós clicáveis; zoom e navegação;
mesmos marcos no diário; respostas expansíveis; resultado único; equipe acessível
com a janela em 1024 px. Os scripts não usam contas nem serviços reais de modelos.

## Pendências e limites

- As artes são referência de composição, não uma reprodução pixel a pixel. Foram preservados os sprites e cenários existentes; o resultado mantém diferenças de ilustração e resolução.
- O ImageGen não devolveu alpha na extração do ferreiro. A versão final usa fundo de pergaminho e composição CSS; não é um PNG transparente. Prompt e procedência estão no README dos assets.
- O fluxo foi validado com adaptadores controlados, processos e arquivos reais. Chamadas autenticadas a OpenAI/Anthropic em produção não foram feitas.
- Não foi gerado instalador nem feita publicação remota; a entrega é o clone local com código e evidências.

## Arquivos alterados

- `.gitignore`
- `apps/desktop/scripts/rpg-visual.mjs`
- `apps/desktop/src/main/services/orchestration-service.ts`
- `apps/desktop/src/renderer/assets/heroes/README.md`
- `apps/desktop/src/renderer/assets/heroes/programmer-arcane-smith-v2.png`
- `apps/desktop/src/renderer/components/orch/ActivityPanel.tsx`
- `apps/desktop/src/renderer/components/orch/ExecutionJournal.tsx`
- `apps/desktop/src/renderer/components/orch/ExecutionWorktree.tsx`
- `apps/desktop/src/renderer/guild-theme.css`
- `apps/desktop/src/renderer/pages/Workspace.tsx`
- `apps/desktop/src/shared/execution-trace.ts`
- `apps/desktop/src/shared/hero-identity.ts`
- `apps/desktop/src/shared/mission-layout.ts`
- `apps/desktop/tests/electron-integration.mjs`
- `docs/tavern-refinement-report.md`
- `src/database/repositories.ts`
- `src/execution/events.ts`
- `src/orchestrator/progress-guard.ts`
- `src/orchestrator/rejected-progress.ts`
- `tests/completion-contract.test.ts`
- `tests/execution-trace.test.ts`
- `tests/mission-refinement.test.ts`

## Testes executados

- TypeScript: `npm run typecheck` — aprovado.
- Build Electron/React: `npm run desktop:build` — aprovado.
- Integração Electron: **46 testes aprovados, 0 falhas**, no aplicativo real. O teste de fechamento do editor foi corrigido para consultar o diálogo, pois o mesmo texto também existe no painel de equipe.
- Revisão final da projeção: **25 testes aprovados, 0 falhas**, após a última alteração dos metadados agrupados.
- Suíte completa: `node --test --test-concurrency=4 "dist-tests/tests/**/*.test.js"` — **1.085 aprovados, 0 falhas, 3 ignorados pela plataforma**, total de 1.088.
- O teste de atividade de processos teve uma falha transitória sob concorrência alta; os 19 testes desse módulo passaram isoladamente e a suíte completa passou com concorrência 4. Não houve relaxamento dos limites do produto.
- Novos testes cobrem ciclos A → B → A, caminhos e operadores literais, dependências sem ciclos/colisões, preservação de fontes e bloqueios em resumos longos.
- Missão controlada: um Orquestrador, um Programador, subprocesso real, arquivo de 36 bytes, verificação independente e resposta final única. Mapa e diário têm os mesmos cinco marcos e IDs de origem após reiniciar o aplicativo.
- Auditoria visual: ramificações, resumo e expansão, sete identidades, tema claro, movimento reduzido, configurações e acesso aos painéis em 1024 px.

Logs principais: `artifacts/test-suite-verified.log`, `artifacts/activity-recheck.log`,
`artifacts/typecheck.log`, `artifacts/build-final.log`, `artifacts/electron-verified.log`,
`artifacts/final-projection-tests.log`, `artifacts/after/results.json`
e `artifacts/controlled-mission/results.json`.

## Veredito final

**CONCLUÍDO — implementação e validação local.**

Código, testes e evidências estão no clone indicado. Os limites de fidelidade visual,
transparência do sprite e validação com provedores autenticados estão explicitados acima.
Não há publicação remota ou alteração da instalação já utilizada pelo usuário.
