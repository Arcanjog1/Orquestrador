# Disponibilidade de modelos por conta

Base: `claude/ai-orchestrator-buzz-arch-vblrau`, HEAD remoto inicial
`162cd84ce887bc550540d3717e62a0ea72712601`.

Referência analisada: `51b0eee6b02ef38509782c74690f326378ba13a1`.
Ancestral comum: `5ca60629c95619e7b04cc09ec2508f8ff6f72217`.
A branch moderna possui 220 commits exclusivos; a referência antiga possui 1.
Nenhum merge ou cherry-pick foi usado.

## Portabilidade conceitual

Foram aproveitados os três estados, evidência isolada por conta, ausência de
evidência como estado neutro, verificação sem inferência e descarte de evidência
expirada. O catálogo e o resolvedor paralelos de `src/models` não foram portados.

`agent-model-catalog` continua decorando o catálogo atual. `accountAllowed` mantém
seu contrato e recebe um estado explícito para apresentação. `official-models` e
`model-display` continuam sendo as fontes de nomes; IDs não são apresentados.
Modelos conhecidos permanecem no catálogo quando uma enumeração é parcial.

`AccountModelAvailability` guarda somente metadados em `settings`, com chave,
conteúdo, provedor e validade de 24 horas conferidos na leitura. O IPC genérico de
configurações não pode escrever essas evidências. IDs de modelos são comparados
exatamente; confirmação de alias não confirma uma versão específica.

O botão dos cards envia o ID do agente. O backend resolve a conta vinculada e
usa seu ambiente isolado. Comandos de listagem só são usados quando o CLI
anuncia o subcomando e JSON no help. Claude também pode fornecer entitlement em
`auth status --json`. Somente dados estruturados de entitlement ou listagens
explicitamente no escopo da conta são aceitos. Omissões nunca geram negativas.
APIs usam apenas sua operação existente de listar modelos.

Timeout, rede, saída desconhecida e CLI sem enumeração deixam o resultado não
verificado. Não há caminho de chamada mínima, prompt, chat ou completion nesta
ação. Uma eventual verificação que consuma uso exigirá autorização explícita e
não faz parte desta correção.

`AgentExecutionPolicy` lê negativas da conta atual e entrega-as ao resolvedor
existente. FIXED mantém o modelo ou bloqueia sem fallback. Confirmação de acesso
nunca substitui permissões globais, premium, allowedModels, raciocínio ou tetos.
Observações de execuções anteriores só contam para a mesma conta. O cache parcial
do Codex não é tratado como uma lista exaustiva de modelos suportados.

## Validação

`account-model-availability.test.ts` cobre isolamento, persistência, expiração,
enumeração, erros, negativas e proteção do IPC. `advanced-agent-execution.test.ts`
cobre a fronteira real de execução e zero chamadas quando bloqueada. A suíte
Electron verifica o botão, a aparência neutra, os três textos e a preservação de
FIXED. Executar a suíte completa moderna com `npm test`, `npm run typecheck`,
`npm run desktop:test`, `npm run package`, `npm run -w apps/desktop test:packaged`
e o workflow Windows da branch.
