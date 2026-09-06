# AI Orchestrator — auditoria funcional e o que falta provar à mão

Escrito em 2026-09-06, para a branch `claude/lovable-on-latest-core`, a partir
do baseline `2ddeaea`. Este documento registra o que a fase "produto completo"
mudou, o que continua fora, e o roteiro humano que fecha a prova.

---

## 1. O que a auditoria encontrou e o que foi feito

| Área | Antes | Depois |
|---|---|---|
| Equipe do projeto | Pickers listavam *agentes* ("Codex") no lugar de contas; só dois ids de agente eram gravados | Provider fixo por função, **conta** real pelo nome (ex.: *Codex Trabalho*), modelo e raciocínio por função, tudo persistido em `workspace_agents` (migração 3) e lido pelo loop |
| Readiness | Aceitava agente sem conta | Exige conta em cada função; a recusa nomeia a conta ("A conta "Codex Trabalho" não está conectada") |
| Conversas | Só listar e criar | Renomear, arquivar/restaurar, buscar, apagar com confirmação (mensagens saem; execuções ficam; nada em disco é tocado); reabrir ao escrever numa arquivada |
| Falha "Sem progresso detectado" | Toda falha virava esse card, inclusive a de decisão do Codex | O loop grava, por tentativa, saída, código de saída e trecho do que o CLI imprimiu; a falha diz o que aconteceu; **Detalhes** mostra o registro; "sem progresso" só para limite de iterações |
| Reparo de decisão | O prompt de reparo ia sozinho para um `codex exec` novo, sem o objetivo | O reparo reenvia o prompt original com a correção anexada |
| Contexto da conversa | Cada run só via o próprio objetivo | O prompt do orquestrador leva a conversa anterior, então "Continuar" faz sentido |
| Revisão humana | Botões sem efeito | Continuar (novo run com contexto), Dar instrução (foco no compositor), Cancelar (encerra o run bloqueado) |
| Evidência / diff | Diálogos vazios | `workspace.changes` (git, só leitura) alimenta Alterações, Evidence e o painel; `run.detail` traz etapas, invocações e verificações |
| Compositor | Modo, anexo, microfone, Pausar — todos sem função | Removidos; ficou o que existe: texto, enviar, cancelar |
| Reinício | Run ficava RUNNING para sempre no banco | Marcado como interrompido na próxima abertura |
| Cancelar login Claude | `cancelAll` no ProcessManager compartilhado (mesmo defeito do Codex) | Sinal próprio do processo de login; teste com ProcessManager real |
| Projetos | Só adicionar | Renomear, abrir pasta, remover da lista (pasta intacta); branches reais; `git switch` com pergunta se a árvore estiver suja |
| GitHub | "Sem login próprio" | Login por device flow com GitHub App próprio; token cifrado por `safeStorage` (DPAPI); nunca no renderer, em URL, em `.git/config` ou em log; lista de repositórios (privados inclusive) no seletor de projeto; clone/fetch/branch/commit/push com o login; abrir PR e ler checks |
| Settings | Idioma, auto-run, auto-retry, motivos de revisão, densidade, handoff — sem efeito; tema não aplicado | Só controles reais: iterações e tempos lidos pelo loop, tema aplicado e lembrado, iniciar com o sistema via item de login do SO, confirmar antes de push |
| Onboarding GitHub | Texto estático | O mesmo card de login do GitHub; pular é explícito |

## 2. Registrar o GitHub App (passo humano)

O aplicativo não embute nenhum Client ID nem segredo. Cada instalação usa o app
do próprio usuário:

1. GitHub → Settings → Developer settings → **GitHub Apps** → *New GitHub App*.
2. **Name**: `AI Orchestrator` (ou outro). **Homepage URL**: qualquer página
   sua (o repositório do projeto serve).
3. **Enable Device Flow**: marcado. **Callback URL**: não é necessária.
   **Webhook → Active**: desmarcar.
4. **Repository permissions**: Contents *Read and write*; Pull requests *Read
   and write*; Metadata *Read* (obrigatório); Checks *Read*.
   **Account permissions**: Email addresses *Read*.
5. Criar. Na página do app, **Install App** na sua conta e nas organizações
   cujos repositórios privados devem aparecer.
6. Copiar o **Client ID** (não o Client secret) e colar em
   *Settings → Accounts & Integrations → GitHub*. Só o Client ID entra no
   aplicativo.

Um OAuth App clássico com device flow também funciona (o aplicativo pede os
escopos `repo read:org read:user user:email`); a diferença é que o OAuth App
vê todos os repositórios do usuário sem instalação por organização.

## 3. Roteiro humano (o que só uma pessoa no Windows pode provar)

1. Instalar `AI-Orchestrator-Setup.exe` do pre-release `desktop-dev-<sha>` mais
   recente e abrir.
2. Contas: conectar OpenAI (Codex) e Anthropic (Claude) — ambas **Conectado**.
3. GitHub: colar o Client ID, **Conectar ao GitHub**, digitar o código no
   navegador; o card deve mostrar avatar e login.
4. Projeto: **Adicionar projeto** → lista de repositórios inclui um privado →
   clonar numa pasta; conferir que `.git/config` tem só a URL do remoto.
5. Equipe: **Orquestrador → Editar equipe** → contas pelo nome → Salvar;
   fechar e reabrir o aplicativo; a equipe continua.
6. Branch: chip da branch lista as branches; trocar com a árvore limpa; trocar
   com um arquivo alterado deve perguntar.
7. Loop real: seguir `docs/PROVA_LOOP_REAL.md` (verificação de uma etapa e de
   duas). Se falhar, o card deve dizer o motivo e **Detalhes** deve mostrar a
   saída do Codex — esse é o registro que o bug original não tinha.
8. Conversas: renomear, arquivar, buscar, apagar; confirmar que as execuções
   seguem em **Histórico de execuções**.
9. Git: Commit pelo cabeçalho, Push (pede confirmação), Abrir PR; conferir o
   PR no GitHub e o estado dos checks no chip.
10. Cancelar um run em andamento; conferir no Gerenciador de Tarefas que só os
    processos daquele run terminaram.
11. Settings: tema Light/Dark/System; iterações = 2 e conferir que o próximo run
    para em 2; iniciar com o sistema; confirmar antes de push desligado.
12. Fechar o aplicativo com um run em andamento; reabrir; o run aparece como
    interrompido, não como "executando".

## 4. Limitações conhecidas

- **Verificações** só chamam executáveis no `PATH` ou por caminho absoluto; os
  runtimes gerenciados (Codex, Claude Code, MinGit) não são alcançáveis pelo
  nome (limitação registrada em `docs/PROVA_LOOP_REAL.md`).
- **Diff por execução**: o diálogo de alterações mostra a árvore de trabalho
  *agora* em relação ao último commit; o loop não arquiva o diff de cada
  iteração em disco.
- **Login GitHub em Linux sem keyring**: `safeStorage` pode não estar
  disponível; o aplicativo recusa guardar o token e diz isso. No Windows
  (DPAPI) e macOS (Keychain) está sempre disponível.
- **Tokens de GitHub App com expiração**: a renovação por `refresh_token` está
  implementada, mas não foi exercitada contra o GitHub real.
- **Sem pausa**: o loop não pausa; existe cancelar. O botão foi removido em vez
  de fingir.
- **Idioma**: só PT-BR.
- **Nada aqui substitui o teste humano** da secção 3: as contas reais, o
  navegador, o instalador e o Windows não entram no CI.
