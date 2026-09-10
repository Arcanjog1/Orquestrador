# Limpeza de segurança — `relative/path/.claude.json`

Registro do incidente e do que ficou pendente. Escrito na sessão que removeu o
arquivo do HEAD.

> Nenhum valor sensível é reproduzido neste documento — apenas os **tipos** de
> informação envolvidos.

---

## 1. Caminho afetado

```
relative/path/.claude.json
relative/path/backups/.claude.json.backup.<timestamp>
```

O diretório `relative/path/` nasceu de um teste manual do spike do Windows: o
`CLAUDE_CONFIG_DIR` foi apontado para um caminho **relativo** para provar que o
Claude Code CLI recusa caminhos relativos. O CLI, antes de recusar, criou a
árvore de configuração dentro do repositório, e ela acabou sendo commitada junto
com o spike.

Nenhum código, teste, build ou script referencia esse caminho — verificado com
`grep -rn "relative/path"` sobre todo o repositório. A remoção não afeta
execução nem testes.

## 2. Commits que contêm o arquivo

O arquivo foi introduzido em `35f1d25` e permaneceu em todos os commits
seguintes até a remoção:

```
35f1d25  Add the Windows integration spike                  <-- introduzido aqui
e5793df  Spike: add TEST 7 (terminal-free auth) and TEST 8 (runtime acquisition)
d04808f  RuntimeManager: the application installs its own runtimes
7bf0934  Claude accounts managed by the app, with CLAUDE_CONFIG_DIR hidden
42545f6  Runtime version policy, trust policy, rollback and MinGit
f092590  Database layer: swappable driver, schema and runtime_installations
5ca6062  Add the Electron-phase session handoff
```

Ou seja: **7 commits** carregam o blob. O HEAD atual já não o carrega.

## 3. Tipos de informação encontrados

Apenas identificadores; **nenhum token, chave de API ou credencial OAuth**
estava presente. O arquivo de credenciais do Claude Code (`.credentials.json`)
nunca foi criado nesse diretório.

| Tipo | Presente |
|---|---|
| UUID da conta | sim |
| Endereço de e-mail do usuário | sim |
| UUID da organização | sim |
| Identificador/fingerprint de máquina | sim |
| Versão e data da primeira execução do CLI | sim |
| Flags de migração/notificações do CLI | sim |
| **Token de acesso / refresh token** | **não** |
| **Chave de API** | **não** |
| **Senha** | **não** |

## 4. Risco

**Moderado, não crítico.**

- Não há credencial a rotacionar: nada no arquivo permite autenticar como o
  usuário.
- O que vazou é **PII e correlação**: e-mail pessoal, UUID de conta, UUID de
  organização e um fingerprint estável de máquina, ligáveis entre si e ao
  histórico público do repositório caso ele venha a ser tornado público.
- O fingerprint de máquina permite correlacionar futuras execuções/telemetria à
  mesma máquina.
- Enquanto o repositório for **privado**, a exposição está limitada a quem já
  tem acesso a ele (incluindo forks e clones já existentes).

## 5. Estado atual

- [x] Arquivo removido do índice e do disco (`git rm -r --cached relative`).
- [x] `.gitignore` recebeu regras para impedir recorrência:
      `.claude.json`, `.claude.json.backup*`, `.claude/`, `.credentials.json`,
      `.codex/`, `relative/`, `profiles/**/.claude.json`.
- [x] Varredura do restante do repositório: nenhum outro arquivo de estado local
      rastreado. A única ocorrência de string com forma de segredo em arquivos
      rastreados é um **fixture sintético** em `tests/sessions.test.ts`, usado
      para provar que o redator de segredos funciona.
- [ ] **Histórico ainda contém o blob** — pendente de autorização explícita.

## 6. Recomendação futura

1. Nunca apontar `CLAUDE_CONFIG_DIR` (nem `HOME`) para dentro da árvore do
   repositório ao exercitar spikes. O app de produção já faz o certo: os perfis
   vivem em `%LOCALAPPDATA%\AI-Orchestrator\profiles\`, fora de qualquer repo.
2. Manter as regras de `.gitignore` acima.
3. Considerar um hook de pré-commit ou um passo de CI que recuse commits que
   adicionem `.claude.json`, `.credentials.json` ou `.env`.
4. Se o repositório for tornado público, tratar a limpeza do histórico como
   pré-requisito de publicação.

## 7. Passos para remover do histórico (NÃO executados)

Estes passos **reescrevem o histórico** e exigem autorização explícita do dono
do repositório. Nada disso foi executado nesta sessão.

```bash
# 1. Backup completo antes de qualquer coisa
git clone --mirror <repo> repo-backup.git

# 2. Reescrever, removendo o caminho de todos os commits
#    (git-filter-repo é o caminho recomendado; BFG é a alternativa)
git filter-repo --path relative --invert-paths

# 3. Conferir que o blob sumiu
git log --all --oneline -- relative        # deve não retornar nada
git rev-list --all | while read c; do git ls-tree -r "$c" --name-only; done \
  | grep -c 'relative/path'                # deve ser 0

# 4. Publicar (destrutivo)
git push --force-with-lease --all
git push --force-with-lease --tags

# 5. Pedir ao GitHub a expiração dos objetos órfãos (support) e
#    invalidar caches/forks existentes.
```

## 8. Impacto de um eventual force-push

- **Todos os SHAs mudam** a partir de `35f1d25`. Qualquer branch, tag, PR aberto
  ou clone existente passa a divergir do remoto.
- Quem tiver clone local precisa refazer o clone ou executar um reset explícito;
  um `git pull` comum produzirá merge de históricos duplicados.
- PRs abertos contra os commits antigos podem ficar em estado inconsistente e
  provavelmente precisarão ser reabertos.
- Referências a commits em issues, PRs e documentos apontarão para SHAs
  inexistentes.
- **Forks e caches do GitHub podem continuar servindo o blob antigo** mesmo
  depois do force-push, até que o suporte do GitHub faça a limpeza. Ou seja: o
  force-push reduz a exposição, mas não garante apagamento imediato.
- Como não há credencial envolvida, o custo/benefício sugere: fazer a reescrita
  **antes** de qualquer publicação do repositório, e não com urgência enquanto
  ele for privado.

**Conclusão:** a reescrita de histórico fica pendente de autorização separada e
explícita.
