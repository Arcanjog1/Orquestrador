# Menus ⋯: salto de 36 px e ativação involuntária

Reproduzido em Windows no executável extraído do instalador publicado
`desktop-dev-0331189`, antes de alterar o produto. SHA-256 desse instalador:
`d825e204ff47bcf61a92c90f0f81be4323cdf0fcb480f71c263bfe3b703cccfa`.

## Causa e sequência observada

1. `pointerdown` no ícone ⋯ abre o `DropdownMenu` modal do Radix.
2. `react-remove-scroll-bar` aplica `body[data-scroll-locked]` com
   `padding-top: 0px`. Isso sobrescrevia o `padding-top: 36px` que a aplicação
   usava para reservar a barra de título do Windows.
3. Sidebar, conteúdo e âncora do portal sobem 36 px. O primeiro item do menu
   ocupa a posição onde o cursor foi pressionado.
4. `pointerup` chega ao item **Abrir**, não ao trigger. O `MenuItem` do Radix
   trata a liberação sem pressão prévia nesse item com `currentTarget.click()`.
5. O `click` programático (`detail=0`) chama `projectActions.open` uma vez.
   Depois aparece o `click` nativo (`detail=1`) no ancestral comum, `BODY`.
   No menu da conversa, a mesma sequência abre o diálogo **Renomear**.

Portanto havia duas operações lógicas: abrir o menu e ativar um item. Não havia
um `dblclick` nativo no clique único, nem um handler de abertura na linha pai.
O `mousedown`/`mouseup` compatível é suprimido quando Radix previne o
`pointerdown`; por isso o diagnóstico precisa observar também `pointerup`.

O teste do pacote anterior mediu:

| Medida | Antes | Menu aberto / transição |
|---|---:|---:|
| Padding superior do body | 36 px | 0 px |
| Topo da sidebar | 36 px | 0 px |
| Topo visual do Worktree | 350,5 px | 314,5 px |
| `window.scrollY` | 0 | 0 |
| `nav.scrollTop` | 319 | 319 |
| Transform do grafo | `translate(64px, 170px) scale(1)` | igual |
| `menuOpen` | — | 1 |
| `projectOpen` | — | 1 (2 com dois cliques físicos rápidos) |
| Navegação / troca de seleção / fit | — | 0 / 0 / 0 |

A ausência de mudança em `scrollY` sozinha escondia o defeito: o salto era de
layout. Space/Enter também faziam a tela subir, mesmo sem ativar um item.

## Correção mínima

O inset da barra de título passa do `body` para `#root`, em `styles.css`.
Assim, o bloqueio modal continua funcionando e não remove o espaço reservado
pela janela. O portal mantém a âncora sob o cursor. Não foi necessário alterar
os handlers do Radix, bloquear propagação, desativar a modalidade ou alterar o
Worktree. O trigger de conta ganhou `type="button"` e um nome acessível.

Todos os menus já usam `components/ui/dropdown-menu.tsx`, que encapsula Radix.
Um novo `OverflowMenuTrigger` não corrigiria o conflito global de layout e
duplicaria a abstração existente.

## Inventário completo

Busca no renderer: `DropdownMenu`, `DropdownMenuTrigger`, `ContextMenu`,
`Ellipsis`, `MoreHorizontal`, `MoreVertical` e `⋯`.

| Implementação | Uso real | Validação |
|---|---|---|
| `AppSidebar.tsx`, `renderProject` | Projeto ativo e inativo | Mouse, teclado, scroll e grafo |
| `AppSidebar.tsx`, `renderSession` | Conversa | Mouse, teclado, scroll e grafo |
| `Settings.tsx`, `AccountCard` | Conta | Mouse, teclado e scroll |
| `ConnectionsCard.tsx`, card de conexão | Conexão CLI e conexão API | Ambas exercitadas |
| Agentes | Botões diretos; não há ⋯ | Tela com agente cadastrado, ausência de trigger |
| Execuções / Worktree | Botões diretos; não há ⋯ | Execução persistida e ausência de trigger |
| Evidências | Botões diretos; não há ⋯ | Diálogo aberto e ausência de trigger |

Os botões de abrir projeto/conversa são irmãos do ⋯, dentro de `div`; não há
`button` dentro de `button`, nem uma linha pai com ação de abertura. O teste
verifica a estrutura interativa renderizada.

## Regressão automatizada

`apps/desktop/scripts/overflow-regression.mjs` inicia o Electron real ou um
executável empacotado. Cria banco e perfil Chromium temporários, 18 projetos,
uma conversa com execução concluída, um agente, conta CLI e conexão API sem
credenciais. Nenhum modelo é chamado. Não usa JSDOM nem `.click()` para dirigir
as interações: envia mouse/teclado pelo protocolo do Chromium.

São 28 interações de overflow: clique esquerdo único, dois cliques rápidos,
arraste de 1 px, Space e Enter; todos seguidos de Escape. Inclui repetição e
projeto inativo. Dois cliques físicos podem alternar/fechar o menu, mas não
podem ativar item, navegar, selecionar ou mover conteúdo. Clique único não
pode produzir `dblclick`.

Os probes temporários registram capture/bubble de `pointerdown`, `pointerup`,
`mousedown`, `mouseup`, `click`, `dblclick`, foco, blur, teclado, scroll,
selectionchange e hashchange, além de chamadas `focus()`/`scrollIntoView()`.
Observam transições de layout, não apenas o estado final após o salto voltar.
O foco acessível entra no menu e retorna ao mesmo trigger ao fechar. O teste
aguarda o término da animação de saída; não pressupõe 200 ms em janela de fundo.

IDs ativos vêm das props reais da sidebar; callbacks de abertura são contados
por wrappers que chamam a função original. Os testes de abertura normal
calibram esses contadores com valor 1. Não há instrumentação embarcada no app.
DOM identities detectam remounts. O grafo começa com zoom e pan alterados e
todos os snapshots precisam conservar transform, coordenadas visuais e run.

Contrato para cada clique único:

```text
menuOpen=1
projectOpen=0
conversationOpen=0
navigation=0
selectionChange=0
worktreeFitView=0
menuItemClick=0
```

Casos nomeados incluem `project-overflow-single-action`,
`project-overflow-does-not-open-project`,
`project-overflow-does-not-change-selection`,
`project-overflow-does-not-scroll`,
`project-overflow-does-not-reset-worktree-viewport`,
`nested-button-does-not-trigger-parent`, `overflow-keyboard-space`,
`overflow-keyboard-enter` e `overflow-escape-and-focus-return`.
Conversa, conta e cada tipo de conexão têm sua própria série de cenários.
Agente, execução e evidência têm verificações explícitas de ausência de ⋯.

A regressão da sidebar usa os botões reais para abrir projeto/conversa,
expandir/recolher, renomear e verificar persistência, abrir configurações,
contexto e preparação, arquivar/restaurar e remover preservando a conversa.
Abrir preparação verifica o preflight; não clona um repositório externo.

## Executar e conferir evidência

Depois de `npm run desktop:build`, na raiz do repositório:

```powershell
node apps/desktop/scripts/overflow-regression.mjs --output=out/overflow-electron
node apps/desktop/scripts/overflow-regression.mjs "--binary=apps/desktop/release/win-unpacked/AI Orchestrator.exe" --output=out/overflow-packaged
```

Para registrar um pacote anterior sem interromper nas asserções, acrescente
`--observe`. A saída contém `results.json`, log do processo e screenshots antes
e durante a abertura. O JSON registra `appInfo.packaged` e versões do runtime.
O teste local também foi executado no payload extraído do instalador NSIS.

Validações gerais locais: typecheck aprovado; 41 testes Electron aprovados;
926 testes root aprovados, zero falhas e três skips de plataforma;
smoke do pacote aprovado em dois processos, incluindo persistência e restart.
As duas execuções de overflow são etapas obrigatórias do Windows CI, antes da
publicação do instalador. Upload de evidência é informativo; os testes não são.
O commit, o resultado remoto do CI e o link do instalador constam da entrega.
