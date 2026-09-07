# Incidente — `CodexCapabilityError` no Windows instalado

**Status:** causa-raiz encontrada, corrigida e coberta por testes de regressão.
**Reteste humano no Windows:** `LOCAL_REAL_AUTH_TEST_PENDING` (ver o fim).

## O que o usuário viu

Objetivo enviado: *"VOCÊ CONSEGUE FAZER ALTERAÇÕES NESSA PASTA?"*

```
Baseline → OK
Resultado → FAILED
1 iteração
0 invocações
Diagnóstico: CodexCapabilityError:
  Esta versão do Codex não oferece um modo não interativo compatível.
```

Zero invocações é o detalhe que aponta o lugar: a execução foi recusada
**antes** de qualquer `codex exec`. O Codex daquela máquina é o gerenciado
0.153.4, que tem `exec` — a frase estava errada sobre o próprio binário.

## Causa-raiz

Dois defeitos, um em cima do outro.

### 1. O overlay de ambiente não chegava à sonda de capacidade

O bloco A3 (commit `de4b4aa`) resolveu o abort da AWS-LC removendo
`OPENSSL_ia32cap` **do ambiente do processo filho**. Esse overlay era montado
em `AppServices.buildRunners` e entregue ao `CodexAdapter` como
`buildEnvironment()`. Mas dentro do adapter ele só era aplicado a **uma**
chamada:

| chamada do adapter | ambiente antes do fix |
|---|---|
| `codex exec …` (a execução real) | overlay aplicado ✅ |
| `codex --help` (sonda de capacidade) | **herdava a máquina** ❌ |
| `codex exec --help` (flags) | **herdava a máquina** ❌ |
| `codex --version` (nível de raciocínio) | **herdava a máquina** ❌ |
| `codex --version` (health check) | **herdava a máquina** ❌ |

Na máquina do usuário, `OPENSSL_ia32cap` está definido no ambiente. A AWS-LC
compilada dentro do Codex 0.105+ lê essa variável em `handle_cpu_env`, chamada
por `OPENSSL_cpuid_setup`, registrada em `.CRT$XCU` — ou seja, **antes de
`main`**. Ela chama `abort()` (0xC0000409 no Windows). Então:

```
codex --help  →  abort antes de main  →  stdout vazio, stderr = "Fatal Error: HW capability …"
              →  parseHelp não acha "exec" na lista de subcomandos
              →  CodexCapabilityError
```

O `codex exec` que teria funcionado nunca foi tentado, porque o portão que
decide se ele pode ser tentado rodava sem a correção que existia justamente
para ele.

O `ClaudeCodeAdapter` já passava o ambiente para a sua sonda; por isso só o
Codex falhava.

### 2. Falha de sonda virava veredito sobre o CLI

`readCapabilities` devolvia apenas `{help, flags, subcommands}` — descartava
`outcome`, `exitCode`, `signal` e `stderr`. Um processo que **nunca rodou** era
indistinguível de um processo que rodou e não tem `exec`. A ausência de uma
palavra numa string vazia era relatada como um fato sobre o produto instalado.

## A correção

**Menor correção correta, em duas partes.**

### `apps/desktop/src/main/adapters/cli-capabilities.ts`

`readCapabilities` agora classifica a execução e devolve o resultado junto com
o texto (`CliCapabilities.probe`):

| estado | significado |
|---|---|
| `OK` | rodou e a página foi lida |
| `EXECUTABLE_NOT_FOUND` | `spawn` falhou (ENOENT, recusa do SO) |
| `PROBE_TIMEOUT` | o filho ainda estava vivo no prazo |
| `PROCESS_ABORTED` | a sonda foi cancelada de fora |
| `EXECUTABLE_INCOMPATIBLE` | morreu por sinal, ou por código de crash do Windows (0xC0000409, 0xC0000005, 0xC000001D, 0xC0000135, 0xC0000142), ou SIGABRT/134 |
| `PROBE_FAILED` | saiu com erro e sem página legível |
| `PARSER_FAILED` | saiu limpo, mas a página não tem nenhuma flag nem subcomando |

A assinatura exata do incidente (`HW capability found … requested`) é
reconhecida e nomeada: `causa=a biblioteca criptográfica dentro do executável
abortou por causa de OPENSSL_ia32cap no ambiente`.

### `apps/desktop/src/main/adapters/codex-adapter.ts`

1. Um único `environment()` monta o ambiente e **todo** filho do adapter nasce
   com ele: `--help`, `exec --help`, `--version` (versão e health check) e
   `exec`. O ambiente é montado uma vez por invocação e o mesmo objeto vai
   para a sonda e para a execução — não existe mais "sonda com um ambiente,
   execução com outro".
2. Estado de sonda ≠ veredito. Cada estado tem sua própria frase e seu próprio
   `reason` (`CodexCapabilityError.reason`), e o diagnóstico completo
   (`estado=…; argumentos=…; código=…; causa=…; stderr=…`) vai para
   `userMessage`, que a interface já mostra. Só `CAPABILITY_UNSUPPORTED`
   mantém a frase original.
3. Uma sonda que falhou **não é cacheada**: a execução seguinte pergunta de
   novo ao binário, em vez de repetir para sempre um veredito tirado enquanto,
   por exemplo, o antivírus segurava o arquivo.
4. `exec` é confirmado por **qualquer uma** das duas páginas: o subcomando
   aparecer no `--help` do topo, **ou** o próprio `codex exec --help`
   responder. A segunda é o CLI dizendo que o subcomando existe. Isso remove a
   dependência de uma única leitura de layout sem afrouxar o portão — um build
   que responde `error: unrecognized subcommand 'exec'` continua recusado com
   `CAPABILITY_UNSUPPORTED`.

O mesmo tratamento foi aplicado ao `ClaudeCodeAdapter` (`ClaudeCapabilityError`
ganhou `reason` e o mesmo mapa de estados), porque a armadilha era idêntica
ainda que o sintoma não tivesse aparecido lá.

## O que **não** mudou

- O regex do `parseHelp` continua exatamente o mesmo. O problema era seleção de
  ambiente e diagnóstico, não permissividade de parser.
- `codex exec`, `--skip-git-repo-check`, `--sandbox read-only`,
  `--output-schema`, `-o/--output-last-message`, `-m/--model`,
  `-c model_reasoning_effort="…"` — nenhuma flag nova, nenhuma flag inventada;
  todas continuam sendo enviadas só quando `exec --help` as declara.
- Preferência pelo Codex gerenciado sobre o do PATH, `CODEX_HOME` isolado por
  conta, `auth.json`, catálogo com `max`, esquema estrito, rollback,
  verificação de integridade, teto de 180 s: intocados.
- Nenhuma variável do Windows é alterada; nada de `setx`, registro, BIOS ou
  antivírus. A remoção de `OPENSSL_ia32cap`/`OPENSSL_armcap` continua sendo só
  no ambiente do processo filho — a diferença é que agora ela vale para todos
  os filhos, não só para um.

## Testes de regressão

`tests/desktop-adapters.test.ts`:

| teste | o que prova |
|---|---|
| `the capability probe runs under the same environment as the run itself` | `--help`, `exec --help` e `exec` recebem `CODEX_HOME` e a política de drop |
| `a Codex that aborts at start-up is reported as incompatible, not as lacking a headless mode` | 0xC0000409 + assinatura AWS-LC ⇒ `EXECUTABLE_INCOMPATIBLE`, e a segunda sonda nem é gasta |
| `a probe that timed out, was killed, or could not be spawned is never a capability verdict` | timeout / cancel / ENOENT / SIGABRT / exit≠0 ⇒ cinco `reason` distintos, nenhum com a frase antiga |
| `a failed probe is not cached: the next run asks the binary again` | falha transitória não condena a instalação |
| `` `exec` is confirmed by the subcommand answering, not only by the parent page listing it `` | página de topo ilegível ⇒ pergunta ao subcomando ⇒ roda |
| `a Codex that really has no exec is still refused, and says so` | o portão não foi afrouxado |
| `the version read and the health check run under the overlay too` | as duas chamadas restantes |
| `a Claude Code probe that failed is not reported as lacking a headless mode either` | mesma regra no worker |
| `a Claude Code build with no --print is still refused` | mesmo portão no worker |

Suíte inteira: **397 passam, 1 pulado** (o pulado é anterior a este bloco).
`npm run typecheck` limpo (raiz, main e renderer).

## Reteste humano no Windows — `LOCAL_REAL_AUTH_TEST_PENDING`

O que só a máquina do usuário pode provar (precisa das contas conectadas):

1. Instalar o build novo.
2. Abrir **Detalhes** no passo 1: deve continuar mostrando
   `OPENSSL_ia32cap=<valor>` no ambiente da máquina e a linha
   `política: o Codex gerenciado roda sem OPENSSL_ia32cap…`.
3. Enviar o mesmo objetivo — *"VOCÊ CONSEGUE FAZER ALTERAÇÕES NESSA PASTA?"*.
4. Esperado: a timeline mostra **pelo menos uma invocação do Codex** (era 0).
5. Se ainda falhar, a mensagem agora **nomeia o estado**
   (`EXECUTABLE_INCOMPATIBLE`, `PROBE_TIMEOUT`, `PROBE_FAILED`…), o código de
   saída e a primeira linha do stderr. Copiar essa frase inteira é o suficiente
   para o próximo diagnóstico — não é mais preciso adivinhar.
