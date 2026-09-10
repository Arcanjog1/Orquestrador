# Redesign da guilda RPG

Base: `main`, confirmada por `git fetch origin` antes da implementação.
HEAD inicial: `85fc18d41add4982b87c3b9f4644304f149f9fc3`.

## Implementação

- `guild-theme.css`: tokens semânticos de madeira, pergaminho, ouro e magia; paletas escura e clara; navegação, cards, diálogos e mapa. Importado depois do tema base, sem dependências de rede.
- `HeroPortrait.tsx` e `hero-identity.ts`: sete identidades por função, avatar e sprite, estados `idle`, `working`, `success`, `blocked`, `needs-human`, `offline`. O avatar é um enquadramento CSS do mesmo PNG; nenhuma versão independente pode divergir da identidade. Falhas de carregamento mostram ícone provisório explicitamente identificado.
- `ExecutionWorktree.tsx`: projeção horizontal dos mesmos nós e vínculos de `executionGraph`. Colunas representam progressão; delegações paralelas ocupam trilhas distintas. Pan, zoom, ajuste à tela, recolhimento, navegação por teclado, detalhes, evidências, diff e cancelamento são preservados. Setas esquerda/direita navegam entre pai e filho.
- Cards do mapa: resumos de até 100 caracteres. Respostas lineares: título de até 120 caracteres, uma linha de até 160 caracteres, expansão do conteúdo e das métricas. Resultado final compacto em até 180 caracteres. As mensagens e os relatórios originais não são alterados.
- `ActivityPanel.tsx`: registro ao lado do mapa e da execução linear. Chamadas persistidas mostram função/agente, tarefa, duração medida, status e acesso ao resultado. A equipe continua filtrada pelas invocações reais da run. Histórico de outra run não recebe a Activity da execução atual. Conversas sem pasta não exibem mudanças Git do diretório do aplicativo.
- `AgentsCard.tsx`, `TeamForm.tsx`, `primitives.tsx`: personagens nos cards, seleção e identidades, com conta/provedor/modelo/raciocínio existentes. As políticas continuam acessíveis em sua própria aba. A sidebar oferece acesso direto à guilda.
- Moldura nativa Windows com cores da madeira; os controles nativos e a região arrastável continuam funcionando.
- Build copia os assets para `dist-renderer/assets`, incluídos no `asar` pelo empacotamento existente.

## Animações

Lanterna com flicker discreto, runa e movimento de trabalho, feedback curto de sucesso, entrada de ramificações, hover e transições. Sem canvas, bibliotecas de partículas ou timers extras. `prefers-reduced-motion: reduce` desativa todas as animações e transições.

## Assets e limitações

Os sete PNGs originais estão em `apps/desktop/src/renderer/assets/heroes`. Produzidos pela ferramenta integrada ImageGen; o primeiro mago detalhado foi descartado após a orientação de simplificar os personagens.

Os seis personagens além do ferreiro têm transparência alpha. O ferreiro ainda tem fundo quadriculado incorporado no PNG: é um asset visual provisório, identificado no manifesto, substituível sem mudar os componentes. Uma tentativa de remoção pela ferramenta também retornou RGB e foi descartada. Não se bloqueou o layout por esse acabamento, conforme a instrução do usuário. Avatares são recortes CSS; os estados são efeitos CSS, sem sprite sheets dedicados. A arte promocional de grupo ficou fora desta fase após a orientação de encerrar personagens e passar ao layout.

## Validação reproduzível

```sh
npm run typecheck
npm test
npm run desktop:test
npm run package
npm run -w apps/desktop test:packaged
node apps/desktop/scripts/overflow-regression.mjs --output=out/rpg-overflow
node apps/desktop/scripts/rpg-visual.mjs --output=out/rpg/after
node apps/desktop/scripts/rpg-visual.mjs "--binary=apps/desktop/release/win-unpacked/AI Orchestrator.exe" --output=out/rpg/packaged
```

O teste visual usa SQLite isolado e dados de demonstração persistidos, sem credenciais ou chamadas a provedores. Valida direção horizontal, delegações paralelas, tamanho dos resumos, participantes reais, abertura do resultado, preservação de pan/zoom ao recolher Activity, os sete personagens, movimento reduzido, telas de configuração, modo claro e largura de 1024 px. O CI passa a executar o mesmo teste visual no aplicativo empacotado de Windows e Linux.

Um teste Electron antigo assumia que o repositório público ainda tinha `claude/new-session-3am7mo` como branch padrão. Agora ele compara os valores com metadados atuais do GitHub; as verificações de identidade dos projetos e de falha de metadados permanecem.

## Evidências

Capturas são do Electron real com fixtures isoladas, não mockups. As imagens “antes” pertencem ao HEAD inicial; as imagens “depois” incluem os casos adicionais da guilda.

| Tela | Antes | Depois |
| --- | --- | --- |
| Worktree | [Vertical](rpg-evidence/before-worktree.png) | [Horizontal](rpg-evidence/after-worktree.png) |
| Agentes | [Original](rpg-evidence/before-agents.png) | [Guilda](rpg-evidence/after-agents.png) |
| Activity | [Original](rpg-evidence/before-activity.png) | [Registro](rpg-evidence/after-activity.png) |

Detalhes dos checks, CI, commit e instalador estão no relatório de entrega em `out/rpg/delivery.md` no ambiente de execução.

Os testes por CDP mantêm o foco emulado na janela sob teste; assim Escape e restauração de foco continuam sendo verificados quando outra janela do desktop está ativa.
