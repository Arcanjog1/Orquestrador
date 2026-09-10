# Correções do Windows real + organização por projetos

Registrado em 2026-09-06, branch `claude/lovable-on-latest-core`, a partir de
`1bd6aa1`. Quatro problemas vistos no Windows instalado, um pedido de
produto, e o roteiro humano que fecha a prova.

## Bloco A — Codex gerenciado ao lado de um Codex antigo no PATH

**Visto:** "Codex 0.104.0 encontrado no PATH é anterior à versão mínima…",
botão *Atualizar*, e depois "Não foi possível preparar Codex
automaticamente." — sem dizer por quê.

**Causas prováveis, todas corrigidas** (o CI do Windows nunca as viu porque
roda em rede rápida, como administrador e sem antivírus):

| passo | antes | agora |
|---|---|---|
| download (pacote Windows: 136 MB) | teto fixo de 5 min e tudo em memória, duas vezes | streaming para disco com hash incremental; desiste só por inatividade (90 s) |
| `codex.exe --version` no staging (295 MB, primeira execução sob o Defender) | 60 s | 180 s, também na checagem pós-instalação |
| promoção (`rename` do staging para `current`) | um `rename`; EPERM/EBUSY (exe ainda aberto pelo antivírus) ou EXDEV (AppData redirecionado) = falha | tentativas com espera; cópia entre volumes; limpeza do staging nunca derruba uma instalação concluída |
| API do GitHub (release oficial) | qualquer recusa virava "nothing available" | status HTTP e, no limite de taxa, quando reseta |

**Visibilidade:** cada tentativa deixa uma trilha `[fonte] fase: o que
aconteceu` — na exceção, no evento de progresso, no resultado da instalação
e no diagnóstico (`lastFailure`) — mostrada atrás de **Detalhes** no passo 1
do onboarding. Redigida (`redact`), sem cabeçalhos nem tokens.

**Prioridade:** o gerenciado sempre vence no `detect()`. O Codex do PATH não
é renomeado, apagado nem alterado; o aplicativo apenas prefere o seu.

**Automático:** ao abrir, além de subir um gerenciado desatualizado, o
aplicativo instala o gerenciado quando o único Codex é um do PATH abaixo do
mínimo. Sem PowerShell, npm, winget ou download manual.

**Testes:** PATH com 0.104.0 (arquivo real) + gerenciado ausente → instala
→ `getExecutablePath` aponta o gerenciado → arquivo do PATH byte a byte
igual; varredura de inicialização; trilha de falha com limite de taxa e 404;
`rename` recusado três vezes e EXDEV; download lento que termina e download
parado que desiste. A sonda real (`probe-real-runtimes --runtime codex`)
continua instalando o 0.153.4 e atravessando o catálogo com `max` e o
esquema estrito.

## Bloco A2 — o `codex.exe` extraído não responde no Windows real

**Visto (build f6cc402):** as duas fontes (releases do GitHub e registro npm)
baixaram, verificaram e extraíram; as duas terminaram em
`staging-health-check: the executable did not report a version within 180 s`.

**O que essa frase escondia:** ela era emitida para *qualquer* falha de
`readVersion` — processo recusado pelo Windows, processo que morreu com
0xC0000005, saída diferente de zero, saída vazia, ou um travamento real. O
"180 s" não era uma medição; era o teto do timeout copiado para a mensagem.
Nada dizia qual dos casos aconteceu.

**Provado aqui (sem o PC do usuário):**

| fato | como |
|---|---|
| GitHub e npm entregam o **mesmo** `codex.exe` 0.153.4 (SHA-256 `444a3f00…518b`, 295.408.944 bytes) | os dois pacotes baixados e comparados byte a byte; o CI do Windows repete a comparação (`--compare-sources`) |
| o executável é PE x64, subsistema console, CRT estático (sem `vcruntime140.dll`), assinado (Authenticode) | cabeçalho PE e tabela de importação lidos do arquivo |
| nem o download por Node nem o `tar.exe` gravam `Zone.Identifier` | mecanismo: só o navegador/Explorer marcam; o probe confere o ADS em cada instalação |
| nenhum handle nosso fica aberto: o download fecha o arquivo antes de extrair, o `tar.exe` e o PowerShell (Authenticode) são processos que já saíram | leitura do pipeline; o probe tenta abrir o arquivo para escrita antes de executar |
| antes de `--version` ser tratado, o `codex.exe` 0.153.4 executa `arg0_dispatch`: lê `CODEX_HOME/.env`, cria `CODEX_HOME/tmp/arg0/`, faz limpeza de diretórios antigos e grava `apply_patch.bat` | fonte do Codex (`codex-rs/arg0`, `install-context`) na tag `rust-v0.153.4` |
| a segunda fonte era um download de 141 MB para chegar ao mesmo resultado | mesmo hash acima |

**O que só o PC do usuário pode responder — e agora responde.** O health
check do staging virou duas camadas:

1. *Estático:* existe, tamanho estável (duas leituras), SHA-256, cabeçalho
   MZ/PE, máquina (x64/arm64), subsistema, assinatura, abrir para escrita
   (handle alheio), `Zone.Identifier`.
2. *Execução:* `codex.exe --version` pelo ProcessManager, com registro de
   PID, evento de criação, primeiro byte em stdout/stderr, `exit`, `close`,
   erro de spawn (código), cada tentativa de encerrar (`taskkill /T`, depois
   `/T /F`) e se o processo saiu.

Cada resultado tem seu estado: `ACCESS_DENIED`, `FILE_LOCKED`,
`FILE_MISSING`, `INVALID_EXECUTABLE`, `SPAWN_FAILED`,
`PROCESS_STARTED_NO_OUTPUT`, `PROCESS_STARTED_STDERR_ONLY`,
`PROCESS_HUNG`, `PROCESS_EXITED_NO_VERSION`, `PROCESS_EXITED_NONZERO`,
`PROCESS_CRASHED` (com o nome do NTSTATUS), `PROCESS_KILLED`.

Se a primeira execução falha, o mesmo arquivo é executado de mais quatro
formas, cada uma para separar um suspeito: **segunda execução** (30 s — um
primeiro início retido pelo antivírus responde agora), **child_process
direto** sem o ProcessManager (nosso wrapper?), **sem janela de console**
(`windowsHide`, só no Windows), **`CODEX_HOME` vazio** (o conteúdo do
`~/.codex` atual?) e **cópia em pasta controlada** (a pasta de staging?). A
conclusão de cada comparação vai para o registro. Se a segunda execução
responde, o build é instalado e o registro diz que o primeiro início demorou.

**Fonte × máquina:** quando o download, o hash e a extração passaram e a
máquina não executou, a instalação para na primeira fonte e diz: "falha local
de execução, não da fonte: as outras fontes entregam o mesmo executável e não
foram baixadas". Uma fonte que falha de verdade (404, hash errado, arquivo
que não extrai) continua caindo para a próxima.

**Detalhes → Copiar detalhes:** o bloco inteiro (estado, executável com
bytes/SHA/PE/assinatura/MOTW, argv, cwd, ambiente com nomes e valores seguros,
cada execução com PID/saída/encerramento, conclusões) copia com um clique,
no onboarding e no diálogo de login. Sem segredos: proxies aparecem como
"definido", tokens nunca aparecem.

**ProcessManager:** o registro (`trace`) faz parte de todo resultado; um filho
que sai mas cujos pipes ficam presos por outro processo (handle herdado no
Windows) agora conclui em 5 s com a saída que chegou, marcado
`streamsLingered`, em vez de esperar o timeout inteiro.

**O que não mudou:** 180 s continua sendo o teto da primeira execução; o
gerenciado só é promovido quando o caminho do produto executou o binário;
`detect()` continua preferindo o gerenciado; o Codex do PATH continua
intocado.

## Bloco A3 — a causa real: `OPENSSL_ia32cap` no ambiente

**Visto (build fad1fcb, Detalhes copiados do PC):** as seis execuções do
`codex.exe` 0.153.4 (íntegro, PE x64, assinado, SHA-256 `444a3f00…518b`)
terminaram em `PROCESS_CRASHED`, saída `0xC0000409`, stderr:

```
Fatal Error: HW capability found: 0x178BFBFF 0x7EF8320B, but HW capability requested: 0x20000000 0x00.
```

**Origem exata da frase.** AWS-LC, a biblioteca criptográfica compilada
dentro do Codex desde a 0.105 (`aws-lc-sys` 0.37.0 = AWS-LC 1.67.0 na 0.105;
0.39.0 = AWS-LC 1.71.0 na 0.153.4), em
`crypto/fipsmodule/cpucap/cpu_intel.c`, função `handle_cpu_env`, chamada por
`OPENSSL_cpuid_setup`. O código é literal:

```c
env1 = getenv("OPENSSL_ia32cap");
if (env1 == NULL) { return; }          // sem a variável, nada acontece
...
if (!invert && (intelcap0 || intelcap1)) {
  if ((~(1u << 30 | intelcap0) & reqcap0) || (~intelcap1 & reqcap1)) {
    fprintf(stderr, "Fatal Error: HW capability found: 0x%02X 0x%02X, but HW capability requested: 0x%02X 0x%02X.\n", ...);
    abort();                             // 0xC0000409 no Windows, SIGABRT no Linux
  }
}
```

Os dois valores "found" são CPUID folha 1 EDX e ECX como a biblioteca os
leu (bit 30 do EDX é reescrito como "é Intel"; zero aqui = AMD). Os dois
"requested" são o que a **variável de ambiente `OPENSSL_ia32cap`** pediu:
`0x20000000` = bit 29 do EDX (TM, monitor térmico Intel; ausente em AMD).
Não há exigência do binário: o Codex é compilado sem `target-cpu`/
`target-feature` (workflow `rust-release.yml`), a AWS-LC decide em tempo de
execução, e sem a variável a função retorna antes de qualquer checagem.

No Windows a AWS-LC registra `do_library_init` em `.CRT$XCU`: roda **antes
de `main`**, então `--version` nunca chega a executar. Por isso todas as seis
variações (segunda execução, `child_process` direto, sem console,
`CODEX_HOME` vazio, cópia em pasta controlada) morreram igual: todas herdavam
o mesmo ambiente.

**Reproduzido aqui, no binário oficial 0.153.4 (Linux, mesma AWS-LC):**

| comando | resultado |
|---|---|
| `codex --version` | `codex-cli 0.153.4`, exit 0 |
| `OPENSSL_ia32cap=0x20000000 codex --version` | a frase acima, `Aborted` (exit 134) |
| `OPENSSL_ia32cap=0x400 codex --version` (bit reservado, ausente em toda CPU) | a frase, `Aborted` |
| `OPENSSL_ia32cap=~0x20000000 codex --version` (forma invertida) | `codex-cli 0.153.4` |
| `child_process` com a variável / sem a variável | SIGABRT / exit 0 |

**Por que a 0.104 funciona.** O `codex-x86_64-pc-windows-msvc.exe` 0.104.0
oficial (100.562.920 bytes) não contém a AWS-LC — só `ring` (34 strings
`ring-0.17.14`, zero `HW capability`, zero `OPENSSL_ia32cap`). O 0.105.0
(112.553.960 bytes) já traz `aws-lc-sys-0.37.0` e a frase. A 0.153.4 traz
`aws-lc-sys-0.39.0`. O regresso é "a AWS-LC passou a fazer parte do binário
Windows", não uma exigência nova de hardware.

**Não é o processador.** A CPU do usuário (AMD, AVX/FMA/AES/F16C/RDRAND em
ECX `0x7EF8320B`) roda o binário assim que a variável sai do ambiente do
processo filho. Nenhuma release oficial posterior existe (última tag:
`rust-v0.153.4`) e a checagem continua igual no `main` da AWS-LC hoje, então
nenhuma versão mais nova evitaria o abort com a variável presente.

**Correção (só no processo filho, reversível, documentada):** o health
check do staging reconhece a assinatura exata (`CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE`),
executa o mesmo arquivo sem `OPENSSL_ia32cap`/`OPENSSL_armcap` no ambiente
do filho e, se ele responde, grava a política no manifesto do runtime
(`environment.drop`, com o motivo e os valores vistos). Todo processo do Codex
gerenciado — health check, `codex exec` do orquestrador — nasce sem essas
variáveis. O sistema não é alterado: sem `setx`, sem registro, sem BIOS, sem
mexer no antivírus, sem fingir instruções (a AWS-LC volta a usar o CPUID
real, que é o comportamento padrão da biblioteca), sem tocar em self-tests.
Se mesmo sem a variável o executável abortar, a instalação para na primeira
fonte com "Esta versão do Codex não consegue iniciar neste computador." e o
registro completo.

**O que fica igual:** Codex 0.104 do PATH intocado; `CODEX_HOME`, `auth.json`
e perfis de conta intocados; 180 s continua o teto; catálogo com `max` e
esquema estrito conferidos na sonda real; segunda fonte não é baixada quando
a falha é local.

## Bloco B — GitHub Device Flow

**Visto:** "O GitHub não iniciou o login: resposta inesperada".

**Causa:** essa frase era toda resposta sem `device_code` e sem
`error_description` ao mesmo tempo. O GitHub responde a um Client ID
desconhecido com **404 `{"error":"Not Found"}`** — sem descrição. Um App ID
(número), o exemplo da ajuda ou um Client secret colados no campo davam
exatamente isso.

**Contrato conferido** (docs.github.com, OAuth/GitHub App device flow):
`POST https://github.com/login/device/code`, corpo
`application/x-www-form-urlencoded` com `client_id` (e `scope`, ignorado por
GitHub App), `Accept: application/json` → JSON com `device_code`,
`user_code`, `verification_uri`, `expires_in`, `interval`. Sem o `Accept`, o
GitHub responde form-urlencoded. O cliente agora **lê pelo Content-Type**
(JSON, form-urlencoded, ou página HTML de um proxy).

**Cada caso com sua frase:** Client ID desconhecido (404 / `unauthorized_client`
/ `incorrect_client_credentials`) → onde está o Client ID e o que ele não é;
`device_flow_disabled` → marcar *Enable Device Flow*; limite de taxa →
esperar; HTML → proxy/firewall/antivírus; polling: `authorization_pending`,
`slow_down` (intervalo do GitHub), `expired_token`, `access_denied`,
`incorrect_client_credentials`, `incorrect_device_code`,
`unsupported_grant_type`, `device_flow_disabled`.

**Registro seguro:** status HTTP, content-type, `error`, `error_description`
e um trecho do corpo com `device_code`/`access_token`/`refresh_token`
removidos; vai no evento `account:progress` e aparece atrás de **Detalhes**
no diálogo de login. Client secret: não existe no aplicativo.

**Antes de enviar:** o campo recusa App ID numérico, o exemplo da ajuda e um
token, cada um em suas palavras. **Depois do token:** a conta responde
(`/user`) e os repositórios respondem (`/user/repos`, primeira página) antes
de guardar; a confirmação diz quantos repositórios ficaram visíveis, ou que
o app não está instalado em nenhuma conta.

## Bloco C — Equipe

Orquestrador: **Model: Padrão do Codex CLI · Reasoning: Padrão do Codex CLI**,
com *Configuração avançada* para fixar modelo e nível. Não há catálogo de
modelos do Codex confiável, então nenhum é inventado. Os níveis oferecidos
são os que a versão instalada aceita (`max` a partir de 0.140.0), lidos do
diagnóstico de runtimes e recalculados quando ele muda. Persistido como
`selection` (`auto` | `manual`) na mesma linha de equipe; um modelo salvo
antes da coluna existir continua fixo. O runner só passa modelo/nível sob
`manual`. Worker: Seleção Automático · Estratégia Balanceado · Configuração
avançada, como antes.

## Bloco D — Projetos

Entidade real: tabela `projects` (id, name, workspace_id nullable, metadata,
created_at, updated_at) e `chat_sessions.project_id` nullable (migração 5).
Projeto ≠ pasta: o projeto organiza conversas e pode apontar para uma pasta
(workspace), que as conversas novas herdam. Sem `project_id` = "Sem projeto".

- Sidebar: **Recentes** (transversal), **Projetos** com cada projeto
  dobrável e suas conversas, **Sem projeto**, **+ Novo projeto**; **Pastas**
  abaixo.
- Nova conversa dentro do projeto (o "+" do projeto): nasce com o projeto e
  na pasta dele, trocando de pasta se preciso.
- Menu da conversa: Renomear · Mover para projeto ▸ (projetos + Sem projeto)
  · Arquivar · Apagar. Menu do projeto: Renomear · Vincular a uma pasta ·
  Excluir.
- Excluir projeto: as conversas vão para "Sem projeto" com mensagens e
  execuções; nenhuma pasta, repositório ou arquivo é tocado.
- Busca: uma lista plana entre projetos, cada resultado com o nome do
  projeto.
- Equipe: continua na pasta (workspace); o projeto herda pela pasta. Não há
  segundo sistema de equipe. Contexto: cada conversa continua isolada.
- Migração: conversas existentes ficam com `project_id = NULL` → "Sem
  projeto"; nada se perde (teste em `tests/database.test.ts`).
- Onboarding, passo 4: cria o primeiro projeto para a pasta escolhida com o
  mesmo serviço.

## Roteiro humano no Windows

1. Instalar o novo build (`desktop-dev-<sha>`).
2. Confirmar que o Codex 0.104 do PATH continua existindo (`where codex`).
3. Abrir o aplicativo: o passo 1 mostra o Codex antigo e prepara o gerenciado
   sozinho (ou pelo botão *Atualizar*): Preparando → Baixando N MB →
   Verificando → Extraindo → Testando → Instalando → Pronto. Se falhar,
   **Detalhes** diz a fase e o motivo; **Copiar detalhes** copia o registro
   inteiro (estado, PID, saída, encerramento, comparações) — cole e envie.
4. Passo 1 fica *Pronto* com Codex 0.153.4 (gerenciado pelo aplicativo). Em
   **Detalhes** deve aparecer `OPENSSL_ia32cap=<valor>` no ambiente e a
   linha `política: o Codex gerenciado roda sem OPENSSL_ia32cap…`. Opcional:
   `where codex` e `echo %OPENSSL_ia32cap%` no cmd, para saber quem definiu
   a variável (o aplicativo não a altera).
5. Contas Codex e Claude conectadas.
6. GitHub: colar o Client ID do GitHub App (Iv1…/Iv23li…), **Conectar**.
7. O diálogo mostra o código; o navegador abre.
8. Depois de autorizar, "GitHub conectado como <login> (N repositórios
   visíveis)". Se falhar, **Detalhes** diz o status e o erro.
9. Equipe: Codex Trabalho · Claude Trabalho · Worker Automático.
10. Criar o projeto "Teste AI Orchestrator" (onboarding ou *+ Novo projeto*).
11. Criar uma conversa dentro dele (o "+" do projeto).
12. Fechar e reabrir o aplicativo.
13. Projeto e conversa continuam na sidebar, no mesmo lugar.
14. Rodar o hello.txt (`docs/PROVA_LOOP_REAL.md`).
