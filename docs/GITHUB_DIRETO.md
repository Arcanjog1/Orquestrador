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

## Descobrir os arquivos, sem pasta e sem pedir caminho

Um projeto sem checkout não tem pasta para procurar — e ler um arquivo que não
se pode **nomear** não é uma capacidade. Por isso a árvore de arquivos é lida
uma vez, pela API, **antes da primeira chamada a modelo**, e vai no prompt do
supervisor:

```
FILES IN THIS REPOSITORY at 08495d913e72 (3 arquivo(s) no total):
  README.md (31 bytes)
  src/auth/login.ts (52 bytes)
  src/index.ts (35 bytes)
```

Com isso, "consegue ler os arquivos q tem nesse repositorio?" é respondida pelo
próprio aplicativo, sem worker, sem clone e sem pedir caminho a ninguém. Para
um repositório grande a listagem inicial é limitada, e o supervisor pede o
resto — ou um recorte — com `listFiles`:

```json
{ "listFiles": { "prefix": "src/", "contains": "login", "limit": 200 } }
```

Três coisas que não acontecem:

- **A árvore truncada nunca é apresentada como completa.** Quando o GitHub
  trunca, isso é dito, no passo `repository-tree/truncated` e no prompt.
- **Um arquivo que não existe é a ausência daquele arquivo**, e não um
  repositório vazio.
- **Faltar a lista de arquivos não é motivo para revisão humana.** Se o
  supervisor parar dizendo que precisa dela, o aplicativo a busca e a
  execução continua. `NEEDS_HUMAN` fica para o que o aplicativo realmente não
  consegue obter sozinho — uma permissão, uma decisão, um acesso.

## Quando o GitHub responde "não encontrado"

Quatro situações diferentes chegam como o mesmo 404, de propósito: um token não
pode servir para descobrir quais repositórios privados existem. O aplicativo
não repete o código de status — ele diz qual das quatro é, e abre a página
oficial que resolve:

| o que está acontecendo | o que aparece | onde se resolve |
|---|---|---|
| ninguém conectado | a leitura saiu anônima, e um repositório privado responde "não encontrado" a isso | Contas e integrações |
| login expirado e não renovado | a mesma coisa, e por isso mesmo | Contas e integrações |
| App autorizado na conta, mas **não instalado** no dono | autorizar a conta e instalar o App são coisas diferentes | github.com/settings/installations |
| instalado, mas sem **este** repositório na instalação | "Only select repositories" não inclui este | a instalação, direto |
| o repositório realmente não existe, ou mudou de nome | confira o nome, com maiúsculas e minúsculas | — |

Nada disso é deduzido de haver um token guardado: a resposta vem do que o
GitHub respondeu à requisição, mais o que a instalação cobre. Uma leitura
autenticada que falha **nunca** é repetida sem credencial — o 404 anônimo de um
repositório privado é indistinguível de ausência, e essa repetição era o que
transformava "sem acesso" em "não existe". E depois de acertar a instalação,
**Verificar de novo** mede outra vez; não supõe nada por você ter aberto a
página.

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
