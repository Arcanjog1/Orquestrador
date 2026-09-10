# Disponibilidade de modelo

## O problema que isto corrige

A interface mostrava uma linha só — **“Disponibilidade do modelo não
confirmada”** — no mesmo amarelo de uma falha de verdade. Isso errava duas
vezes: parecia erro quando nada estava quebrado, e escondia a única distinção
que importa para quem usa o app.

Agora existem três estados, e eles nunca se confundem.

| Estado | O que apareceu na interface | Tom | Modelo pode ser usado? |
|---|---|---|---|
| `CONFIRMED_FOR_ACCOUNT` | “Disponível nesta conta” | `ok` | sim |
| `KNOWN_BUT_UNVERIFIED` | “Disponível no catálogo — ainda não verificado nesta conta” | `neutral` | **sim** |
| `UNAVAILABLE` | “Indisponível nesta conta” | `blocked` | não |

`KNOWN_BUT_UNVERIFIED` é uma informação, não um aviso: sem ícone de alerta, sem
amarelo, sem bloqueio. Não ter verificado uma conta não é defeito de nada.

Um identificador que não está no catálogo desta aplicação também não vira erro:
ele aparece como “Modelo personalizado — ainda não verificado nesta conta”,
continua selecionável, e o estado segue sendo `KNOWN_BUT_UNVERIFIED`.

## As regras

1. **Disponibilidade é por conta.** Cada verificação é gravada com o `accountId`
   e roda com o `CLAUDE_CONFIG_DIR` daquela conta. O que a conta A tem não diz
   nada sobre a conta B — `statusFor()` recusa (com exceção) descrever uma conta
   usando evidência de outra, o store descarta um registro arquivado sob a chave
   errada, e `resolveFixedModel()` devolve `blocked-account-mismatch` em vez de
   confiar em evidência alheia.
2. **Silêncio não é negativa.** Se o CLI não expõe modelos nem direitos de
   acesso da conta, o resultado é `not-supported`, dito com todas as letras
   (“O Claude Code instalado não expõe os modelos nem os direitos de acesso
   desta conta. Nenhum modelo foi marcado como indisponível por causa disso.”),
   e **tudo** permanece `KNOWN_BUT_UNVERIFIED`.
3. **`UNAVAILABLE` só com evidência.** Só se chega lá por: uma listagem da conta
   que se declara completa e não inclui o modelo; uma listagem que nomeia o
   modelo como indisponível; uma recusa numa chamada mínima autorizada; ou
   descontinuação registrada no catálogo. Erro de rede, timeout, comando
   desconhecido e saída ilegível **nunca** produzem uma negativa.
4. **Uma confirmação envelhece para “vale reconferir”; uma negativa envelhece
   para “não verificado”.** Direitos de acesso mudam. Manter uma negativa velha
   trancaria um modelo que a conta já pode ter.

## A ação “Verificar modelos desta conta”

`AccountModelVerifier.verify(account)` — botão `verify-account-models`:

1. Runtime não instalado → `runtime-missing`, com a ação “Configurar
   automaticamente”. Nada é marcado como indisponível.
2. Conta desconectada, ou usando credencial do sistema (`ambient-credential`) →
   `account-not-connected`, com a ação “Conectar”. A resposta de uma credencial
   ambiente seria de outro login e não pode ser arquivada como sendo desta
   conta.
3. Caso contrário, os candidatos de `CLAUDE_MODEL_PROBES` são tentados em ordem,
   sempre com o ambiente daquela conta. **Nenhum deles fala com um modelo**;
   nada de uso é consumido.
4. A primeira resposta compreendida vira o registro. Uma listagem só é
   `exhaustive` quando ela mesma afirma (`complete: true` ou `scope: "account"`).
   Sem essa afirmação, a ausência de um modelo não significa nada — e é tratada
   como não significando nada.
5. Nenhum candidato compreendido → `not-supported` (regra 2).

Os comandos em `CLAUDE_MODEL_PROBES` são **candidatos**: o Claude Code CLI não é
obrigado a implementar nenhum deles, e versões diferem. Um comando que o CLI não
entende custa uma invocação rápida e inofensiva; quando nenhum responde, isso é
relatado como um fato sobre o CLI, não sobre a conta.

## A chamada mínima (opcional, consome uso)

`verify-with-minimal-call` só roda com autorização explícita do usuário:

```ts
await verifier.verify(account, {
  minimalCall: { authorizedByUser: true, modelIds: ['claude-opus-5'] },
});
```

A autorização é exigida no tipo **e** conferida em tempo de execução — sem ela,
`ModelVerificationError`. O prompt vai por stdin, como todo prompt neste
projeto. Exit 0 confirma; só uma recusa explícita (`looksLikeModelRefusal`) nega;
qualquer outra coisa fica sem conclusão e o modelo continua
`KNOWN_BUT_UNVERIFIED`. Um punhado de chamadas nunca vira uma listagem completa.

## O que não mudou

- **Modelo FIXED.** `resolveFixedModel()` devolve o modelo atribuído ou `null`.
  Nunca outro. `substitutedModelId` é sempre `null`, e está no tipo para que uma
  substituição futura tenha de ser adicionada de propósito.
- **Tetos.** Um modelo acima do teto é recusado; um modelo cujo nível não é
  conhecido também é (`blocked-unknown-tier`) — um teto que não pode ser provado
  não é um teto.
- **Sem fallback silencioso.** Um bloqueio devolve `requiresUserDecision: true`
  e uma mensagem. Substituir agente continua sendo um ato registrado:
  `recordSubstitution()` recusa motivo vazio, e é o que preenche
  `agent_invocations.substituted_for_agent_id` / `substitution_reason`.

A única coisa que mudou no policy: `KNOWN_BUT_UNVERIFIED` não bloqueia mais.
Não ter verificado uma conta não é motivo para recusar execução — a decisão é
`allowed-unverified`, que roda e continua dizendo que ainda não foi verificado.

## Arquivos

```
src/models/model-types.ts             estados, motivos, ações, tipos do registro
src/models/model-catalog.ts           o que a aplicação conhece (≠ entitlement)
src/models/model-availability.ts      registro → o que a interface mostra
src/models/account-model-verifier.ts  a ação de verificar, por conta
src/models/verification-store.ts      memória por accountId (memória ou settings)
src/models/model-policy.ts            FIXED, tetos, substituição registrada
tests/model-availability.test.ts      19 testes cobrindo as regras acima
```
