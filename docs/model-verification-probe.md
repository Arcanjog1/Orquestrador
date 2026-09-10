# Verificação de modelos em duas etapas

HEAD inicial e remoto: `636e0992a6e2322af233f5bea734c6e7d1ffacbd`.
Branch: `claude/ai-orchestrator-buzz-arch-vblrau`. O remoto não possuía `main` na inspeção inicial.

## Causa e disponibilidade gratuita

O fluxo anterior só consultava metadados e terminava quando o runtime não expunha entitlement. A presença de um modelo no catálogo ou cache de capabilities não comprova acesso por assinatura.

As conexões API OpenAI e Anthropic enumeram modelos via seus endpoints autenticados existentes. Os CLIs só confirmam quando anunciam uma listagem estruturada, vinculada à conta, ou retornam entitlement explícito. `auth status` que só informa login e caches de catálogo não confirmam. Modelos omitidos nunca são recusados por inferência.

## Fluxo

1. Verificar modelos desta conta executa somente introspecção gratuita.
2. Sem evidência, o estado permanece neutro e o card oferece Testar modelo.
3. O diálogo identifica conta, provider, modelo e possível consumo. Cancelar não envia chamada.
4. A confirmação envia uma operação IPC específica com autorização, agentId, accountId e modelId. O main confere a seleção salva antes de iniciar e depois de concluir. Requisições concorrentes na mesma conta são recusadas.
5. Uma única invocação isolada testa apenas o modelo selecionado. Não há fallback, run normal, acesso ao GitHub ou trabalho no workspace.

Claude utiliza o CLAUDE_CONFIG_DIR da conexão, credencial própria, bare mode, ferramentas vazias, MCP estrito vazio, uma rodada e nenhuma persistência de sessão. Codex usa o CODEX_HOME da conexão, exec efêmero, configuração de usuário ignorada, sandbox read-only, shell/web/imagem/apps/multi-agent desativados e o modelo passado diretamente. Variáveis de credenciais herdadas são removidas pelos account managers existentes. Cada probe CLI roda numa pasta temporária fora do projeto. CLIs sem os parâmetros de isolamento necessários devem ser atualizados; nenhuma inferência é enviada nesse caso.

As APIs usam somente a chave daquela conexão, uma requisição, tools vazio e saída limitada (OpenAI 32 tokens; Anthropic 8). Não habilitam automaticamente conexões desativadas.

## Evidência

A estrutura existente account-model-availability guarda histórico limitado às últimas 200 evidências por conta, com providerId, accountId, agentId, modelId, requestedModel, timestamp, verifiedAt, método, origem, estado e motivo. Argumentos CLI são registrados, mas não ambiente, stdout, stderr ou credenciais. Cada modelo conserva seu estado independentemente dos demais. Datas antigas permanecem visíveis e não disparam consumo automático.

CONFIRMED exige resposta OK válida e sucesso do protocolo, além do modelo enviado explicitamente. Claude exige modelUsage com exatamente o ID solicitado. APIs exigem model correspondente e término válido. Codex exige mensagem final e turn.completed com uso, sem eventos de ferramentas ou telemetria de modelo divergente; não passa pelo adapter que poderia retirar o parâmetro.

UNAVAILABLE exige código estruturado específico de modelo ou uma mensagem de recusa integral reconhecida e contendo o ID exato. Não usa busca genérica em texto do assistente. Timeout, cancelamento, rede/DNS, login, CLI ausente, resposta ilegível, rate limit e indisponibilidade do serviço permanecem inconclusivos.

Disponibilidade continua separada das policies existentes. Confirmação não libera bloqueio global, premium, teto ou permissão de agente. FIXED indisponível continua bloqueado, sem substituição automática.

## Validação

- Testes de serviço/IPC: ausência de autorização, seleção divergente, sucesso, recusa, timeout, rede, cancelamento, resposta ilegível, exit 0 genérico, modelo divergente, isolamento por conta, histórico, API limitada, CLI antigo, credencial ausente e concorrência.
- Electron: fluxo real de card, etapa gratuita inconclusiva, abertura e cancelamento do diálogo, confirmação única e reabertura sem novo consumo.
- Regressões existentes: FIXED sem fallback e políticas globais continuam cobertas pela suíte root.
- Nenhum teste com assinatura real foi realizado: não houve autorização explícita para uma conta/modelo específicos. As chamadas dos testes são simuladas.
- A CI Windows executa typecheck, root, Electron, empacotamento e smoke test, e publica o instalador do commit sob a tag desktop-dev-<SHA curto>.

## Contratos oficiais consultados

- [Codex CLI](https://developers.openai.com/codex/cli/reference)
- [Codex configuração](https://developers.openai.com/codex/config-reference)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)
