# Referências externas — catálogo de pesquisa

Catálogo de projetos externos que podem servir de **inspiração arquitetural**
para o AI Orchestrator.

Este arquivo é um **catálogo**, não uma instrução de leitura obrigatória.
Nada aqui está adotado, implementado ou aprovado. Nenhuma destas referências
faz parte da arquitetura atual do projeto.

---

## Política de consulta

Leia esta seção antes de abrir qualquer link abaixo.

### O agente NÃO deve

- abrir todos os links automaticamente;
- clonar todos os repositórios;
- carregar documentação inteira no contexto;
- instalar dependências dessas referências;
- executar código externo apenas para estudá-las;
- substituir a arquitetura existente sem justificativa explícita.

### O agente DEVE

- consultar uma referência **somente** quando a tarefa em curso for relevante
  para o tema dela;
- começar pela documentação ou pelos arquivos específicos necessários, não pelo
  repositório inteiro;
- limitar a pesquisa ao escopo da tarefa;
- registrar quais fontes e quais commits foram consultados;
- distinguir **funcionalidades comprovadas** (lidas no código, com teste ou uso
  real) de **ideias ainda não verificadas** (lidas no README ou no marketing);
- preservar o backend, os adapters, o bus e o DoneGate existentes.

Em caso de conflito entre uma referência externa e as **decisões
inegociáveis** de [`SESSION_HANDOFF_ELECTRON.md`](SESSION_HANDOFF_ELECTRON.md)
(seção 3), as decisões do projeto prevalecem. O estado atual do trabalho está
em [`PROVIDER_IMPLEMENTATION_HANDOFF.md`](PROVIDER_IMPLEMENTATION_HANDOFF.md).

---

## 1. Buzz

- **URL:** https://github.com/block/buzz
- **Tema:** comunicação, eventos e coordenação entre agentes.
- **Finalidade:** referência sobre como agentes trocam mensagens e eventos e
  como essa troca é coordenada.
- **Quando consultar:** ao trabalhar no bus de eventos, no roteamento de
  mensagens entre agentes ou no protocolo de coordenação. **Leia primeiro**
  [`AGENT_MESSAGE_BUS.md`](AGENT_MESSAGE_BUS.md): o barramento já existe e já
  registra o que foi aproveitado do Buzz (commit `3c7f288`) e o que ficou
  deliberadamente de fora. Só vá ao repositório externo se aquele documento não
  responder.
- **Ideias possivelmente úteis:** vocabulário de eventos; separação entre
  transporte e semântica da mensagem; tratamento de entrega, ordem e falha.
- **Não adotar automaticamente:** o transporte concreto e quaisquer
  dependências de rede/serviço. O intermediador do AI Orchestrator é local; a
  decisão de que "GitHub não é intermediador de mensagens" permanece. O bus
  existente não é para ser reescrito.

## 2. npcpy

- **URL:** https://github.com/NPC-Worldwide/npcpy
- **Tema:** agentes, memória, contexto, knowledge graphs e workflows.
- **Finalidade:** referência ampla sobre modelagem de agentes, memória e
  encadeamento de workflows.
- **Quando consultar:** ao desenhar modelo de contexto, memória de sessão ou
  representação de conhecimento entre execuções.
- **Ideias possivelmente úteis:** estruturas de contexto por agente; formas de
  representar relações entre artefatos; composição de workflows.
- **Não adotar automaticamente:** é um projeto Python. Nada de portar stack,
  runtime ou dependências. O AI Orchestrator é TypeScript/Electron com runtimes
  nativos gerenciados.

## 3. Agent Orchestrator

- **URL:** https://github.com/Untrivial-ai/agent-orchestrator
- **Tema:** gerenciamento e execução de agentes.
- **Finalidade:** referência sobre ciclo de vida, despacho e supervisão de
  agentes.
- **Quando consultar:** ao mexer em gerenciamento de sessões, estados de
  execução ou supervisão de processos de agente.
- **Ideias possivelmente úteis:** máquina de estados de execução; modelo de
  cancelamento e timeout; separação entre orquestrador e executor.
- **Não adotar automaticamente:** qualquer motor de orquestração alternativo.
  Já existe um — `src/orchestrator/` e `src/sessions/`. Consumir ideias, não
  substituir o motor.

## 4. Orquestrador Maestro

- **URL:** https://github.com/IAPro-Community/Orquestrador-Maestro
- **Tema:** orquestração multiagente e workflows.
- **Finalidade:** referência de um orquestrador multiagente com escopo próximo
  ao deste projeto.
- **Quando consultar:** ao avaliar divisão de papéis entre agentes, delegação de
  tarefas ou formato de plano/execução.
- **Ideias possivelmente úteis:** papéis de agente; formato de tarefa e
  critérios de aceitação; relatórios de execução.
- **Não adotar automaticamente:** o modelo de conclusão de tarefa. O
  `DoneGate` (`src/orchestrator/done-gate.ts`) exige validação independente —
  um agente dizer "pronto" não encerra nada. Essa regra não é negociável.

## 5. Claude Desktop Multi

- **URL:** https://github.com/sypnose-cloud/claude-desktop-multi
- **Tema:** múltiplas instâncias e isolamento de contas no desktop.
- **Finalidade:** referência sobre rodar mais de uma conta Claude isolada na
  mesma máquina.
- **Quando consultar:** ao mexer em `src/accounts/` (isolamento por
  `CLAUDE_CONFIG_DIR`, troca de conta, perfis).
- **Ideias possivelmente úteis:** estratégias de isolamento de perfil; pontos de
  atenção em Windows; armadilhas de estado compartilhado entre instâncias.
- **Não adotar automaticamente:** qualquer técnica que exija terminal do
  usuário final, permissões elevadas (UAC), instalação global ou manipulação de
  arquivos internos do Claude Code fora de contrato documentado. Também não
  redistribuir o Claude Code.

## 6. Mem0

- **URL:** https://github.com/mem0ai/mem0
- **Tema:** memória persistente e recuperação de contexto.
- **Finalidade:** referência sobre armazenar, indexar e recuperar memória de
  longo prazo.
- **Quando consultar:** ao desenhar persistência de contexto entre sessões ou
  recuperação seletiva de histórico.
- **Ideias possivelmente úteis:** granularidade do que vale a pena lembrar;
  políticas de expiração e resumo; separação entre memória e log bruto.
- **Não adotar automaticamente:** serviços gerenciados, bancos vetoriais
  externos ou qualquer envio de dados do usuário para fora da máquina. A
  persistência atual é local (`src/database/`, `node:sqlite`).

---

## Como registrar uma consulta

Quando uma referência for efetivamente consultada durante uma tarefa, registre
no relatório final da sessão:

- referência e URL;
- commit ou arquivo específico lido;
- o que foi verificado no código versus o que é apenas ideia do README;
- decisão tomada e justificativa.

Nada é adotado sem justificativa registrada e sem preservar backend, adapters,
bus e DoneGate existentes.
