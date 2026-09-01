# Windows Spike — passo a passo

Este spike prova, **na sua máquina Windows**, que as integrações locais funcionam
antes de construirmos a aplicação desktop em cima delas.

Ele leva cerca de **5 a 10 minutos**.

---

## O que ele NÃO faz

- Não toca nos seus projetos nem nos seus repositórios.
- Não roda nenhum comando git destrutivo.
- Não faz commit, push ou merge.
- Não mostra nenhum token, senha ou conteúdo de arquivo de credencial.
- Escreve arquivos **apenas** dentro de uma pasta temporária, apagada no final.

A única coisa que ele pode criar fora da pasta temporária são as **duas pastas de
perfil do Claude** que você escolher no TEST 3 (por exemplo `C:\Users\Gabriel\.claude-personal`).
Isso é intencional: são os diretórios das suas duas contas.

---

## Antes de começar

Você precisa ter instalado:

| | Como conferir |
|---|---|
| Node.js 20.11+ | `node --version` |
| Git | `git --version` |
| Claude Code CLI | `claude --version` |
| Codex CLI | `codex --version` |

Se o `codex` não estiver instalado, o TEST 1 vai falhar e o relatório vai dizer
isso claramente — os outros testes continuam rodando normalmente.

---

## Passo 1 — Baixar o código

Abra o **PowerShell** ou o **Prompt de Comando** e rode:

```
git clone https://github.com/Arcanjog1/Orquestrador.git
cd Orquestrador
git checkout claude/new-session-3am7mo
```

Se você já tem o repositório clonado, use apenas:

```
cd C:\caminho\para\Orquestrador
git fetch origin
git checkout claude/new-session-3am7mo
git pull
```

---

## Passo 2 — Instalar as dependências

```
npm install
```

> Não precisa rodar `npm run build`. O spike compila sozinho se precisar.

---

## Passo 3 — Rodar o spike

```
node spike/windows-spike.mjs
```

É só isso. O script conduz você pelas etapas e explica cada uma antes de executar.

---

## O que ele vai te perguntar

O spike faz poucas perguntas. Você pode aceitar o padrão apertando **Enter**.

1. **"Ready to start?"** → Enter (sim).

2. **TEST 1 — "send a tiny real prompt to Codex?"**
   Gasta um pouquinho da sua cota do Codex (um pedido curtíssimo).
   → Enter (sim). É esse teste que descobre como o Codex aceita ser chamado.

3. **TEST 2 — "ask Claude Code to create one small file?"**
   Gasta um pouquinho da sua cota do Claude.
   → Enter (sim). Cria um arquivo dentro de um repositório git temporário.

4. **TEST 3 — as duas pastas de perfil.**
   Ele sugere:
   ```
   C:\Users\<voce>\.claude-personal
   C:\Users\<voce>\.claude-work
   ```
   → Enter para aceitar, ou digite outro caminho absoluto.

5. **TEST 3 — "log in to profile A / B now?"**
   Se o perfil ainda não estiver autenticado, ele abre o `claude auth login`
   normal, no navegador, **usando só aquele perfil**.
   → Faça o login de cada um. É exatamente isso que precisamos comprovar.

6. **TEST 3 — "run one tiny prompt under each profile?"**
   → Opcional. Diga **sim** se quiser a prova mais forte de que cada execução
   usa mesmo a conta selecionada (gasta um pouquinho das duas cotas).

7. **TEST 4 — "cancel a REAL Claude invocation mid-flight?"**
   → Opcional, mas **recomendo dizer sim**. É o teste que mostra se sobra
   processo órfão de verdade.

---

## Passo 4 — Me mandar o resultado

No final o spike grava:

```
spike\spike-report.txt
```

**Me mande esse arquivo.** É com ele que eu decido a implementação final do
adapter do Codex, do adapter do Claude Code, do gerenciador de contas e do
cancelamento.

O arquivo já passa por remoção de segredos antes de ser gravado — pode conferir
antes de enviar.

---

## Sobre o TEST 3 (contas múltiplas)

Esse é o teste mais importante e o que tem a maior chance de reprovar.

Para o resultado valer, **nenhuma variável de ambiente da Anthropic pode estar
definida**. Se você tiver `ANTHROPIC_API_KEY` ou `ANTHROPIC_AUTH_TOKEN` no
sistema, os dois perfis vão parecer autenticados pela *mesma* credencial, e o
spike vai reprovar de propósito, explicando o motivo.

Para conferir:

```
echo %ANTHROPIC_API_KEY%
echo %ANTHROPIC_AUTH_TOKEN%
```

(no PowerShell: `$env:ANTHROPIC_API_KEY`)

Se aparecer algum valor, abra um terminal limpo sem essas variáveis e rode o
spike de novo.

O spike considera o TEST 3 aprovado somente quando:

- os dois perfis estão autenticados ao mesmo tempo;
- cada perfil tem o **próprio** arquivo de credencial dentro da própria pasta;
- autenticar o perfil B não derrubou o perfil A;
- cada execução usou comprovadamente a pasta de configuração do perfil escolhido.

---

## Se algo der errado

| Problema | O que fazer |
|---|---|
| `codex não é reconhecido` | O Codex não está no PATH. O TEST 1 vai reprovar e dizer isso; os outros testes seguem. |
| `claude não é reconhecido` | Instale o Claude Code CLI e abra um terminal novo. |
| Erro de ExecutionPolicy no PowerShell | Use o **Prompt de Comando** (`cmd.exe`) em vez do PowerShell. |
| O login do perfil não abre o navegador | Copie a URL que aparece no terminal e cole no navegador. |
| O spike travou | `Ctrl+C`. Ele limpa a pasta temporária sozinho. Depois é só rodar de novo. |

---

## Rodar de novo sem responder nada (opcional)

Se quiser repetir o spike sem as perguntas:

```
node spike/windows-spike.mjs --non-interactive --live
```

Outras opções:

```
--non-interactive, -y     não pergunta nada, usa todos os padrões
--live                    permite os testes que gastam cota
--profile-a <caminho>     pasta do perfil A
--profile-b <caminho>     pasta do perfil B
--help                    mostra essa lista
```

Sem `--live`, o modo não-interativo **não gasta cota nenhuma** — ele só faz a
detecção e os testes locais (4, 5 e 6).

---

## O que acontece depois

Com o `spike-report.txt` em mãos eu vou:

1. definir o adapter do Codex a partir das capacidades **reais** detectadas
   (sem inventar flag nenhuma);
2. definir o adapter do Claude Code;
3. confirmar ou corrigir o ProcessManager para Windows;
4. definir o gerenciador de contas/perfis;
5. só então começar a migração para o monorepo e a interface Electron/React.

Nada disso é decidido antes do relatório.
