# O teto de modelo, por conta

## 1. Causa comprovada

A execução escalou o worker até o topo. O topo é definido em
`src/routing/provider-policy.ts`:

```ts
const CLAUDE_MODELS = { …, MAX: ['fable', 'opus'] };
const CLAUDE_EFFORTS = { …, MAX: ['max', 'xhigh', 'high'] };
```

Então `MAX/MAX` significava **`fable` no esforço `max`** — primeiro candidato da
lista, sem nada que pudesse dizer que aquela conta não podia usá-lo. A conta
respondeu:

> You're out of usage credits.

A assinatura não tinha acabado. Faltavam os créditos extras que aquele modelo
consome. Nada no aplicativo sabia que isso podia ser verdade de **uma** conta e
não de outra, porque não existia nenhuma configuração por conta.

## 2. O que passou a existir

Um teto que pertence à **conta**:

| | |
|---|---|
| Teto de modelo | `FAST` · `BALANCED` · `STRONG` · `MAX`, ou sem teto |
| Teto de raciocínio | `LOW` · `MEDIUM` · `HIGH` · `MAX`, ou sem teto |
| Créditos extras | permitir ou não os modelos da lista premium |

Guardado em `accounts` (migração 18), editável em **Contas e integrações** —
sem JSON, sem variável de ambiente, sem arquivo. Duas contas Claude podem ter
tetos diferentes e mexer numa não mexe na outra.

### Os padrões, e por quê

Conta existente e conta nova começam **sem teto de nível** — uma migração não
pode mudar em silêncio como as execuções de alguém são roteadas — e com
**créditos extras desligados**. O único padrão que não pode estar certo é o que
gasta crédito que ninguém autorizou.

## 3. Aplicado *antes* de escolher o modelo

Esta é a parte que resolve o incidente. O teto entra como passo 5b do roteador,
depois do piso, da escalada e da estratégia, e **antes** de qualquer nome de
modelo ser considerado. Tentar o modelo premium e ler a recusa depois é
descobrir gastando — e numa assinatura essa recusa custa uma iteração.

Exemplo real, do teste:

```
Codex pediu MAX/MAX; Solicitado MAX/MAX; limitado a STRONG/HIGH pela política
da conta; modelo opus; raciocínio high
```

O `fable` não aparece nem como alternativa de retentativa.

Se a política não deixar **nada** para rodar, a execução para em `NEEDS_HUMAN`
com o motivo — cair no padrão do CLI ali dentro seria rodar exatamente o modelo
que a política existe para evitar.

Uma escolha **manual** acima do teto também é recusada: um modelo digitado
continua sendo um pedido, e uma política que uma escolha manual atravessasse
não seria uma política.

## 4. Falha mecânica não escala

Já era assim para falha de provider, autenticação, permissão, processo e
timeout — `noProgressStreak` ignora tentativas mecânicas. O que mudou é o que a
pessoa lê. `classifyCreditFailure` separa, **quando o texto sustenta**:

| Causa | Quando |
|---|---|
| `extra-credits` | "out of usage credits", "credit balance", "créditos extras" |
| `subscription-limit` | "usage limit", "quota", "plan limit" |
| `model-not-authorised` | "not authorized to use the model …" |
| `authentication` | "invalid api key", "unauthorized", "not logged in" |
| `unknown` | qualquer outra coisa |

`unknown` é uma resposta legítima e a mais comum. A mensagem diz que o provedor
não foi específico o bastante e que **o aplicativo não vai adivinhar** — mandar
alguém consertar saldo quando o problema era outro é pior que não dizer nada.

A classificação muda a **frase**, nunca se a falha é mecânica: ela sempre é, e
uma falha mecânica nunca compra um modelo mais forte.

## 5. O que a lista premium é, exatamente

`PREMIUM_MODELS` é uma **lista de política deste aplicativo**, não uma
afirmação sobre como um fornecedor cobra. Ela nomeia os aliases que, na conta
para a qual isto foi escrito, precisaram de crédito além do uso normal da
assinatura. Uma conta que tenha esses créditos desliga a política e a lista
deixa de valer para ela. Nada aqui lê saldo — nenhuma API informa um — então o
aplicativo nunca afirma que existe ou não existe crédito.

## 6. O que ainda depende do seu Windows

Tudo acima foi exercitado com CLIs roteirizados. O que **não** foi executado é
a combinação real: a sua conta, o seu Claude Code, o modelo escolhido de fato
sob o teto. É isso que o novo instalador precisa provar.
