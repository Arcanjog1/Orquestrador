# Provar o loop autônomo com as contas reais, sem terminal

Roteiro para executar a prova final do MVP inteiramente pela janela do AI
Orchestrator no Windows. Nenhum passo pede PowerShell, CMD, `npm` ou editor de
texto: as duas verificações abaixo são linhas de comando que se colam no próprio
aplicativo.

Escrito em 2026-09-05, para a branch `claude/lovable-on-latest-core`.

---

## 1. O que já está provado, e o que falta

| | |
|---|---|
| Loop, reprompt automático, evidência, verificação, DoneGate | provados de forma determinística (agentes falsos, git/verificador/gate reais) |
| Cadastro de verificação pela interface | provado, inclusive na janela Electron real |
| Duas iterações a partir de uma verificação cadastrada na interface | provado |
| **Codex e Claude reais, com contas conectadas** | **falta** — é o único elo em aberto |

O que falta não é código: é uma máquina Windows com as duas contas conectadas
pela interface. Este documento é o roteiro dessa sessão.

## 2. Antes de começar

O comando de verificação é executado **sem shell**, e o executável é procurado
no `PATH` do sistema (`resolveExecutable`, em `src/preflight/preflight.ts`).
Os roteadores gerenciados pelo aplicativo — Codex, Claude Code e o MinGit —
ficam na pasta de dados do aplicativo e **não** entram no `PATH`, então não
podem ser chamados pelo nome numa verificação.

Consequência prática: as verificações deste roteiro usam `node`, que precisa
estar instalado e no `PATH` da máquina. É o caso de quem desenvolve este
projeto. Numa máquina só de uso final isso não é garantido — ver a limitação
registrada no fim do documento.

## 3. Passo a passo

1. Abra o AI Orchestrator.
2. **Settings → Accounts & Integrations**: conecte a conta OpenAI (Codex) e a
   conta Anthropic (Claude). As duas precisam aparecer como **Conectado**.
   *Credencial do ambiente* não serve: o aplicativo exige a conta no perfil
   isolado dele, e o readiness recusa o envio se faltar qualquer uma.
3. Crie um projeto descartável numa pasta vazia — nunca a Modulação Automática,
   nunca um projeto Revit real, nunca o repositório do próprio Orquestrador.
   A pasta precisa ser um repositório git para a evidência ser coletada.
4. **Settings → Verificações do projeto → Adicionar verificação**, e preencha:

   | campo | valor |
   |---|---|
   | Id | `hello-exact` |
   | Nome | `Hello exact content` |
   | Comando | a linha da secção 4 |

5. Volte ao Chat e envie **uma única** mensagem:

   > Crie um arquivo chamado hello.txt contendo exatamente:
   >
   > Olá AI Orchestrator
   >
   > Depois verifique se ele foi criado corretamente.

6. Acompanhe a timeline até `DONE` ou até uma revisão humana. Não envie mais
   nada: tudo o que acontecer depois é do loop.

## 4. Verificação de uma etapa

Cole exatamente esta linha no campo *Comando*. Ela sai com 0 quando `hello.txt`
tem o conteúdo combinado, e com 1 em qualquer outro caso, dizendo o que
encontrou:

```
node -e "process.exit((function(f){try{return require('fs').readFileSync(f,'utf8').trim()}catch(e){return null}})('hello.txt')==='Olá AI Orchestrator'?0:(console.error('hello.txt is '+JSON.stringify((function(f){try{return require('fs').readFileSync(f,'utf8').trim()}catch(e){return null}})('hello.txt'))+', expected Olá AI Orchestrator'),1))"
```

Ela é uma expressão só, sem `;`, `>`, `<`, `|`, crase ou `$(` — os operadores de
shell que o `screenCommand` recusa. Por isso passa pela mesma tela de segurança
que qualquer outra verificação, é dividida em três argumentos (`node`, `-e`, o
script) e roda sem shell. Nada foi afrouxado para ela existir.

Terminando em `DONE`, está provado: **Codex real → Claude real → evidência →
verificação → revisão do Codex real → DoneGate**. Falta ainda o reprompt
automático, que é a secção seguinte.

## 5. Verificação de duas etapas, para provar o reprompt

Repita o roteiro num projeto novo, trocando só o comando da verificação por
este. Ele exige `hello.txt` e, **depois que esse passar**, também um `bye.txt`
com `Tchau`:

```
node -e "process.exit((function(h,b){return h!=='Olá AI Orchestrator'?(console.error('hello.txt is '+JSON.stringify(h)+', expected Olá AI Orchestrator'),1):b!=='Tchau'?(console.error('bye.txt is '+JSON.stringify(b)+', expected Tchau'),1):0})((function(f){try{return require('fs').readFileSync(f,'utf8').trim()}catch(e){return null}})('hello.txt'),(function(f){try{return require('fs').readFileSync(f,'utf8').trim()}catch(e){return null}})('bye.txt')))"
```

A mensagem enviada continua sendo a mesma da secção 3, falando só de
`hello.txt`. Um trabalhador que obedeça perfeitamente à primeira instrução
mesmo assim reprova na primeira verificação, e a única frase no sistema inteiro
que menciona `bye.txt` é a saída dessa reprovação. Se um segundo prompt chegar
ao Claude pedindo `bye.txt`, ele só pode ter vindo de:

```
verificação reprova → buildFeedback() → Codex real → decision.task → Claude real
```

O aplicativo mostra a segunda iteração na timeline. Terminando em `DONE`, o
reprompt automático real está provado.

## 6. O que conferir depois

Na própria interface: a timeline deve mostrar as fases reais — análise,
orquestrador, trabalhador, evidência, verificação, revisão, concluído — e o
contador de iterações do run.

Se quiser o registro completo lido do banco (turnos, prompts, veredictos,
gate), `scripts/lib/loop-evidence.mjs` imprime tudo; é ferramenta de
desenvolvimento e não faz parte deste roteiro.

## 7. Limitação registrada

Uma verificação só pode chamar o que estiver no `PATH` da máquina, ou um caminho
absoluto. Os roteadores que o aplicativo instala e gerencia não são alcançáveis
pelo nome. Numa máquina sem Node instalado, portanto, não existe hoje um
interpretador garantido para uma verificação de conteúdo escrita só pela
interface — restam os comandos do próprio projeto (`npm run ...`, um script já
versionado) ou um caminho absoluto para um executável existente.

Fechar isso seria uma mudança pequena e contida no produto (permitir que uma
verificação resolva, pelo nome, os executáveis que o aplicativo já gerencia),
mas é mudança de produto e não foi feita: fica registrada aqui como o próximo
gap conhecido, para decisão de quem mantém o projeto.
