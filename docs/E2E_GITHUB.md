# O teste real: branch, commit, leitura independente e PR

Este é o roteiro para provar o fluxo GitHub direto **no seu Windows**, com a
sua conexão do GitHub. Nada aqui pede token, e nada aqui usa o repositório de
produção do Orquestrador.

O critério é o seu: **o E2E só está aprovado quando estas operações funcionarem
de verdade** — não quando os testes automatizados passarem, e não quando eu
disser que passaram.

## Antes de começar

- Instale o build mais recente (a pré-release `desktop-dev-<commit>` do
  repositório). Ele não é assinado, então o Windows mostra o aviso do
  SmartScreen: *Mais informações → Executar assim mesmo*.
- Em **Contas e integrações**, conecte o GitHub, se ainda não estiver.
- Confira que Codex e Claude Code estão prontos na mesma tela. Eles rodam neste
  computador; só o *código* fica no GitHub.

## 1. Um repositório descartável

**Pelo aplicativo**, se a sua conexão puder:
Adicionar projeto → **Repositório** → *Ou criar um repositório privado novo* →
dê um nome (ex.: `orquestrador-teste`) → **Criar e usar**.

Se aparecer a mensagem dizendo que a conexão não pode criar repositórios, ela é
verdadeira e o caminho oficial é este:

1. Abra <https://github.com/new>.
2. Nome: `orquestrador-teste`. Visibilidade: **Private**. Marque
   **Add a README file** — sem um primeiro commit não há branch padrão nem
   árvore de onde tirar a branch de trabalho.
3. **Create repository**.
4. Volte ao Orquestrador: Adicionar projeto → **Repositório** → escolha
   `orquestrador-teste` na lista (ou digite `seu-usuario/orquestrador-teste`).

Em nenhum dos dois caminhos você informa um token em lugar nenhum.

## 2. Confira o que o projeto diz que pode fazer

Antes de fechar o diálogo, o aplicativo mostra as três capacidades medidas:

| o que olhar | o que deve dizer |
|---|---|
| Branch padrão | o nome real vindo do GitHub (`main`, `master`, o que for) |
| Consultar | sim, pela API do GitHub |
| Editar, branch e PR | **sim, em uma branch de trabalho** |
| Executar código | indisponível: a API do GitHub não executa código |

Se "Editar" disser que a conta não tem permissão de escrita, pare aqui: o resto
do teste não pode funcionar, e o motivo é a permissão da conexão nesse
repositório. Me diga o que apareceu.

Abra o projeto. No cabeçalho, o chip deve dizer **GitHub**, e **não** deve
haver nenhum pedido de pasta.

## 3. A tarefa

Abra uma conversa no projeto e mande algo pequeno e verificável. Por exemplo:

> No README.md, troque o título da primeira linha para `# Teste do Orquestrador`.
> Mantenha o resto do arquivo como está.

## 4. O que precisa acontecer

Acompanhe pela conversa e por **Detalhes** da execução. As sete coisas que
importam, em ordem:

1. **`repository/ready`** — o repositório, a branch de origem e o commit de
   base, resolvidos antes de qualquer chamada a modelo.
2. **O Codex planeja** e delega. O prompt do worker diz que ele **não pode
   escrever arquivos** e mostra o contrato do bloco de alterações.
3. **`branch/created`** — uma branch `orquestrador/run-…`, criada só agora, na
   primeira alteração.
4. **`commit/created`** — um commit, com os arquivos escritos e removidos.
   *Um* commit, não um por arquivo.
5. **`evidence/changed`** — o diff que o **GitHub** calculou entre o commit de
   origem e a branch de trabalho. Não é o relato do worker.
6. **`file-check/passed`** — o aplicativo abriu o arquivo naquele commit e
   comparou os bytes. Isto é leitura independente do resultado.
7. **`pull-request/opened`** — o PR, da branch de trabalho para a de origem.

## 5. Confira no GitHub, fora do aplicativo

Abra o repositório no navegador:

- a branch `orquestrador/…` existe e tem **um** commit;
- o arquivo mudou, e só ele;
- a branch de origem **não mudou** — nenhum commit foi parar nela;
- o PR está **aberto**, e **não** foi mesclado;
- não existe commit vazio.

## 6. As recusas que também precisam funcionar

Elas contam tanto quanto o caminho feliz, porque são o que impede o aplicativo
de mentir. Se quiser exercitá-las:

- **Tarefa que precisa rodar teste** — peça "rode os testes e conclua". O
  comando é recusado e não roda, o critério fica sem prova, e o DoneGate
  **recusa** o DONE. Se ele aprovar, isso é um defeito e eu quero saber.
- **Tarefa sem alteração** — peça algo que já está como pedido. Não deve
  aparecer nenhum commit: a árvore volta idêntica à de base.
- **Cancelar no meio** — a execução para, e nada fica publicado pela metade.

## 7. Se algo falhar

Me mande, do jeito que aparecer:

- a linha da conversa onde parou;
- os passos de **Detalhes** (fase/status/texto);
- o que o GitHub mostra no repositório, se chegou a mudar alguma coisa.

Não preciso de token, nem de print de credencial, nem de log com segredo — o
aplicativo redige o que passa por ele, mas não me mande nada que pareça uma
credencial de qualquer forma.

## O que este teste **não** prova

Que o aplicativo executa código. Ele não executa, e nesta modalidade não
finge que executa: um comando de verificação é recusado e o critério que ele
provaria fica sem prova. Rodar testes de verdade precisa de um executor, que é
uma capacidade separada e ainda não implementada.
