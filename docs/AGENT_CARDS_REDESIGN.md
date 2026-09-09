# Agentes primeiro: cards e seleção de modelos

Base: 44426690082d97346de3bee2caf26542093e07a5, branch claude/ai-orchestrator-buzz-arch-vblrau.

A tela anterior misturava cadastro, IDs, configurações duplicadas de modelo/raciocínio e políticas globais. O novo fluxo abre na aba Agentes: cards responsivos com função, provedor, conta, modelos, raciocínio, status e ativar/desativar. Política global é uma aba separada. Identidade, Conexão e Modelo organizam o formulário; opções avançadas começam recolhidas. Busca e filtros aparecem apenas quando há mais de cinco agentes.

## Catálogo e nomes

`model-display.ts` centraliza nomes de modelos, funções e raciocínio em português. O nome oficial retornado pelo provider/cache tem prioridade. IDs canônicos permanecem nos valores dos selects, banco e adapters, sem campo de texto no fluxo normal. Identificador de agente aparece apenas em diagnóstico dentro de Avançado.

`agentModels(accountId, role)` obtém modelos da conexão API ou das capacidades/cache da conta no runtime CLI. `agent-model-catalog.ts` aplica metadados de apresentação, bloqueios globais, função, premium e limites da conta. Um modelo novo enumerado aparece sem alteração no React. Ausência de enumeração usa catálogo conhecido do backend, identificado como disponibilidade não confirmada; ausência de níveis conhecidos de raciocínio oferece somente Automático. Não se afirma acesso da conta apenas porque o runtime conhece um ID.

Trocar conta/provedor limpa modelos selecionados e solicita um novo catálogo; respostas atrasadas da conta antiga são descartadas. Raciocínio é a interseção dos modelos que podem ser invocados. Global/account limits restringem as opções; limites adicionais do agente são revalidados antes de salvar.

## Persistência e segurança

Não há alteração de schema: AgentPolicy v1 e IDs anteriores já suportam o novo formulário. A adaptação de leitura é compatível e sem perdas. Agentes com configuração antiga mantêm os valores originais; “Definido na conexão” substitui o rótulo técnico “Legado”. Ao editar e escolher modelos, a confirmação de Salvar escreve a política explícita no formato atual. Abrir a tela não inventa um modelo nem reescreve contas, runs ou histórico. Alterações de nome e desativação continuam possíveis quando um modelo desaparece.

`saveAgent` reconsulta o catálogo no backend para os endpoints IPC existentes de criação/edição. Valida conta/provider, modelos permitidos, regras globais, reasoning e limites adicionais. O renderer não pode enviar metadados de catálogo para se autorizar. Os serviços internos e migrações mantêm a compatibilidade; o enforcement de execução continua em AgentExecutionPolicy e resolveAgentPolicy, sem reescrever loop, routing, DoneGate, worktree ou políticas de execução.

FIXED sempre preserva o principal. CONTROLLED_AUTO armazena explicitamente principal, allowedModels e a ordem de fallback. Selecionar modelos na UI nunca dá liberdade ao router para acrescentar modelos. Uma configuração cujo modelo desapareceu permanece salva e aparece indisponível; não é trocada silenciosamente.

## Evidência

Testes novos cobrem nomes/IDs, catálogo controlado, filtros, bloqueios, manipulação de IPC, reasoning e conta desconectada. O Electron cobre contas com catálogos diferentes, seleção sem digitar IDs, criação de Designer, reabertura, política global separada, Fable bloqueado e desaparecimento de modelo. O self-check do executável empacotado percorre o formulário real e reabre o mesmo Designer em outro processo.

As capacidades usadas nos testes de UI/pacote são fixtures explícitas, não provas de autenticação ou consumo de um provider real. Nenhuma API paga é necessária. CI executa toda a regressão anterior, incluindo isolamento, FIXED/CONTROLLED_AUTO, permissões, consultas read-only, DoneGate e menus.
