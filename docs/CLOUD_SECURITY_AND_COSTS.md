# Nuvem — segurança, isolamento e custos

Este documento é sobre o que acontece quando alguém confia um repositório
privado e duas chaves de API a um servidor. Cada regra abaixo está no código,
com o arquivo que a implementa e o teste que a fixa.

## 1. Identidade e autorização

**Nada que o Renderer envia é autorização.** O `accountId` de um corpo de
requisição é, no máximo, uma dica a conferir contra o que o token diz.

- Uma requisição se identifica por um **token de dispositivo** no cabeçalho
  `Authorization: Bearer`. É a única forma de obter identidade.
- O token é guardado **apenas como hash SHA-256** (`desktop_sessions.token_hash`).
  Um banco roubado não devolve token utilizável, e revogar é atualizar uma
  linha.
- Toda leitura de execução recebe o principal: `findRun(id, principal)` é a
  única forma de pedir uma execução, então um handler **não consegue esquecer**
  de restringir a consulta.
- A execução de outro inquilino responde **404**, não 403: de onde o outro
  está, ela não existe. Nem o nome do repositório vaza pela listagem.

> `src/cloud/coordinator/store.ts` · testes: *"a token is stored only as a
> hash"*, *"an expired session is refused"*, *"one principal can never read
> another's run"*, *"the API refuses everything without a token"*.

## 2. Não existe endpoint genérico de execução

A API tem quatro coisas: criar uma execução, ler seu estado, ler seus eventos,
cancelá-la. **Não há e não haverá** um endpoint que receba um comando.

Um shell remoto alcançável com um bearer token é a diferença entre um serviço
de build e uma botnet.

> `apps/coordinator/src/http.ts` · teste: *"there is no generic execution
> endpoint to find"* (sonda `/v1/exec`, `/v1/shell`, travessia de caminho).

## 3. Texto de modelo nunca vira comando

A regra do produto local vale igual na nuvem, e é mecânica, não uma linha de
prompt:

- todo processo é lançado com **vetor de argumentos**, nunca com `shell: true`
  e nunca com uma string;
- o prompt vai por **stdin** (`docker exec -i`), como localmente;
- o orquestrador pede uma verificação **por id**. Os ids são resolvidos contra
  `verification_definitions`, em que só uma pessoa escreve. Um id desconhecido
  volta como falha; nunca é executado;
- as verificações **viajam com a execução** e continuam sendo definições
  escritas por uma pessoa — o modelo não ganha um caminho novo por estar na
  nuvem.

> `src/cloud/container-provisioner.ts`, `orchestration-service.ts` · teste:
> *"the environment overlay survives the trip into the container"* (afirma
> `!args.includes('sh')`, prompt fora do argv).

## 4. Isolamento do workspace

Cada workspace remoto é um contêiner, e cada sessão tem o seu — duas conversas
do mesmo projeto **nunca** compartilham checkout, então uma não sobrescreve
alteração não commitada da outra.

| Propriedade | Como |
|---|---|
| Sem privilégios | `--cap-drop ALL`, `--security-opt no-new-privileges` |
| Nunca root | `--user 1000:1000`, e `USER node` na imagem |
| Sem fork bomb | `--pids-limit 512` |
| Entrypoint não é shell | `sleep infinity` |
| Rastreável após crash | `--label cloudWorkspaceId=…` |

> `src/cloud/container-provisioner.ts` · teste: *"a workspace is created with
> least privilege and a ceiling on every resource"*.

## 5. Repositório privado, sem credencial durável

O mecanismo é o oficial e o mais estreito que existe: **token de instalação de
GitHub App**.

1. JWT RS256 assinado com a chave privada do App (`exp` ≤ 10 min, `iat`
   recuado 60 s para tolerar relógio adiantado);
2. `GET /repos/{owner}/{repo}/installation`;
3. `POST /app/installations/{id}/access_tokens` com
   `repositories: [nome]` e `permissions: {contents: read}`.

Ou seja: **um repositório**, **uma permissão**, **uma hora**.

O que **não** é usado, e por quê:

- o token OAuth da pessoa — credencial durável e ampla, num servidor,
  alcançando tudo que ela alcança;
- credencial copiada do desktop (`auth.json`, cookie) — login pessoal movido
  para onde nunca foi autorizado a estar.

**O token nunca entra na URL.** O clone autentica por `GIT_ASKPASS` lendo um
arquivo 0600 em `/run/orchestrator` (fora do workspace), apagado logo depois.
O que fica em `.git/config` é o remote https limpo: `git remote -v`, uma linha
de log e qualquer coisa que o modelo leia mostram zero credenciais.

> `src/cloud/github-app-access.ts`, `cloud/image/orq-askpass` · testes: *"an
> installation token is narrowed to one repository"*, *"the repository token
> never reaches a URL, an argument or the git config"*.

**SSO de organização:** um 403 na busca da instalação é relatado como
`UNAUTHORIZED` nomeando SSO, porque é assim que uma organização com SAML
responde a uma instalação não autorizada. O produto não contorna isso — a
autorização é um human gate.

## 6. Credenciais dos modelos

**Assinatura não é API.** ChatGPT Plus/Pro e Claude Pro/Max são licenças de uso
pessoal dos aplicativos daqueles fornecedores. Nada nelas autoriza um
aplicativo de terceiro a usar aquele login em um servidor.

O que o produto faz:

- o Codex é autenticado com `codex login --with-api-key`, que lê a chave da
  **stdin** — o caminho não interativo documentado pela própria CLI, e a razão
  pela qual a chave nunca aparece na lista de processos do contêiner;
- o Claude Code recebe `ANTHROPIC_API_KEY` no ambiente do `exec` que precisa
  dela;
- sem chave, a execução **falha dizendo isso**, em vez de fingir estar logada.

O que o produto **não** faz: transferir `auth.json`, usar cookies, automatizar
login web, ou tratar a assinatura de alguém como credencial de servidor.

> `apps/coordinator/src/coordinator.ts`, método `signIn`.

## 7. Segredos e registro

- Segredos ficam **fora do workspace** (`/run/orchestrator`, 0700), então nada
  que o checkout contenha os alcança andando pela árvore.
- Toda mensagem de falha que vai para o log durável passa por `redact()`.
- O token do dispositivo é guardado com a proteção do sistema no desktop e
  **não pode ser lido de volta pela interface** — a captura de tela daquela
  janela não é uma credencial.
- O endpoint precisa ser **https**; `http` só é aceito em loopback, para um
  coordenador auto-hospedado na mesma máquina. Não há opção para desligar isso.

> `validation.ts` (`cloudEndpoint`) · testes: *"a coordinator reached over
> plain http on a real network is refused"*, e o Electron *"never reads the
> token back"*.

## 8. Custos

Compute em nuvem cobra por segundo. As duas formas de a conta fugir estão
fechadas, e ambas no coordenador — porque é exatamente quando o desktop está
fechado que um contêiner esquecido custa mais.

### Tetos, aplicados ao runtime (não só registrados)

| Limite | Padrão | Variável |
|---|---|---|
| CPU | 2 | `ORQ_LIMIT_CPUS` |
| Memória | 4096 MB | `ORQ_LIMIT_MEMORY_MB` |
| Disco | 20480 MB | `ORQ_LIMIT_DISK_MB` |
| Vida máxima | 4 h | `ORQ_LIMIT_LIFETIME_MS` |
| Ociosidade | 30 min | `ORQ_LIMIT_IDLE_MS` |
| Rede | lista de hosts | `ORQ_ALLOWED_HOSTS` |

### Reaper

Duas varreduras, a cada minuto:

1. **expirado** — passou do teto de vida. É o relógio parando uma execução que
   não pararia sozinha;
2. **órfão** — a execução terminou mas o workspace continua segurando recursos.
   É o que uma queda entre "terminou" e "foi liberado" deixa, e o que nada mais
   limparia.

Um workspace vivo de uma execução em andamento **não é tocado** — recuperá-lo
mataria trabalho em curso.

> `apps/coordinator/src/reaper.ts` · teste: *"the reaper reclaims what expired
> and what a crash left behind"*, incluindo que a segunda varredura não recolhe
> nada duas vezes e que a execução em andamento sobrevive.

### Onde o dinheiro vai

Não há preços inventados aqui. As categorias, sim:

| Categoria | Observação |
|---|---|
| Compute | O contêiner enquanto vive. Dominado pela latência dos modelos, não pela CPU. |
| Armazenamento | Imagem + checkout. O checkout some com o workspace. |
| Banco | O store durável. Linhas, não blobs: diffs e stdout ficam em arquivo. |
| Rede | Clone de entrada, chamadas de API de saída. |
| Log | Um evento por passo do loop, texto. |
| **Modelos** | Quase certamente o maior item, e o único não coberto pelos tetos acima — é uso de API, não de compute. |

**Nenhuma infraestrutura paga foi contratada.** Fazer isso é human gate.

## 9. O que ainda depende de uma pessoa

Ver `CLOUD_SESSION_HANDOFF.md`. Resumidamente: conta de nuvem, billing,
instalação do GitHub App na organização (com autorização SSO), chaves de API, e
o primeiro teste ponta a ponta real.
