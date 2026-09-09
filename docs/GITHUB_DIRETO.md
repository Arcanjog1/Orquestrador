# Trabalhar no repositório onde ele está

Sem clone, sem pasta escolhida, sem PowerShell, sem PATH. O código fica no
GitHub e o aplicativo trabalha nele por lá, pela API oficial e documentada.

## As três capacidades, que não são a mesma coisa

| capacidade | onde acontece | precisa de quê |
|---|---|---|
| **consultar** — metadados, branches, árvore, arquivos, commits, diffs | API do GitHub | nada, para um repositório público; a conexão, para um privado |
| **editar** — branch, commit, PR | API do GitHub | a conexão do GitHub, com permissão de escrita no repositório |
| **executar código** — instalar dependências, rodar testes, abrir navegador | **em lugar nenhum ainda** | um executor. A API do GitHub não é um |

A interface responde as três separadamente, medindo em vez de prometer, antes
de a tarefa começar. Nada aqui chama a API de executor, e nada chama um espaço
temporário neste computador de "nuvem".

## Como usar

1. **Conecte o GitHub** em Contas e integrações, uma vez.
2. **Adicionar projeto → Repositório.** Escolha um da lista, ou digite
   `dono/nome`. Se quiser um repositório novo e descartável, o próprio
   aplicativo cria um privado pela conexão que você já autorizou — nenhum token
   é pedido em lugar nenhum.
3. **Escolha a branch de origem.** Ela vem do GitHub; o aplicativo nunca supõe
   que se chama `main`.
4. **Abra uma conversa e descreva a tarefa.**

O que acontece então é o laço de sempre: o Codex planeja, o Claude propõe a
alteração como dados estruturados, **o aplicativo** a executa pela API, o
aplicativo mede o resultado no GitHub, o Codex revisa, e o DoneGate decide.

## O que o aplicativo faz, e o que o modelo não faz

Sem checkout o worker **não pode escrever um arquivo**, e é proibido de dizer
que escreveu. Ele propõe a alteração num bloco `orquestrador-changes`, e o
aplicativo valida antes de executar: o commit de base tem que ser o commit em
mãos, cada caminho tem que ficar dentro do repositório, cada campo tem que ser
um campo que o contrato define. Não existe campo de comando, e nada é
executado. Uma proposta que não passa não é aplicada, não é relatada como
aplicada, e volta como explicação para a rodada seguinte.

## As regras de segurança da escrita

- **Um conjunto de alterações vira um commit**, nunca um commit por arquivo:
  blobs, uma árvore sobre a árvore de base, um commit, uma referência movida.
- **Todo commit diz qual head espera.** Se a branch mudou, é conflito, com os
  dois shas nomeados, e nada é escrito.
- **A referência é movida com `force: false`**, dito explicitamente: uma branch
  que se mexe *durante* a sequência ainda não pode ser sobrescrita.
- **Árvore idêntica à de base = nada mudou**, e nenhum commit é criado só para
  a execução parecer produtiva.
- **A branch de origem nunca é escrita, e nada é mesclado.** O PR é oferecido.
- Arquivo grande demais, caminho fora do repositório, caminho do Windows,
  caminho repetido, conteúdo enviado duas vezes ou nenhuma: cada um recusado
  pelo nome, com o motivo e a alternativa que funcionaria.

## Evidência

Vem do GitHub, não do relato do worker: o diff que o próprio GitHub calcula
entre o commit de origem e a branch de trabalho. `fileReads` e `fileChecks`
funcionam igual, contra um commit em vez de uma pasta, usando a **mesma**
comparação de bytes do verificador local.

E a distinção que o DoneGate mantém: um arquivo existir, o conteúdo ter mudado,
os bytes terem sido conferidos e um **teste ter sido executado** são quatro
coisas diferentes. Sem executor, um comando de verificação é recusado e não
roda; o critério que ele provaria fica sem prova; e o DONE é recusado. Nunca um
PASS inventado.

## Quando um executor é necessário

Quando a tarefa exige rodar código: instalar dependências, executar testes,
rodar um linter, abrir um navegador. Nesse caso o projeto diz que a capacidade
está indisponível, em vez de a execução descobrir isso no meio. O executor
temporário neste computador é uma capacidade opcional e ainda **não** foi
implementado; ler e editar pelo GitHub não dependem dele.

## O que não é isto

Não é "nuvem": nada continua com o computador desligado, e nenhum servidor foi
contratado. O coordenador em `apps/coordinator/` continua no repositório como
capacidade opcional futura, e nada neste fluxo depende dele.
