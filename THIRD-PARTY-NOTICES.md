# Avisos de terceiros

O AI Orchestrator **não redistribui** nenhum destes componentes dentro do seu
instalador. Eles são obtidos pelo próprio aplicativo, na máquina do usuário, a
partir de origens servidas pelos respectivos projetos.

Este arquivo registra o que cada componente é e sob qual licença chega.

## Claude Code CLI

- Fornecedor: Anthropic
- Licença publicada no npm: `SEE LICENSE IN README.md`
- **Não é uma licença open-source permissiva.**

Por isso o aplicativo nunca embute o Claude Code no instalador. Ele apenas
executa o download, a partir de uma origem da Anthropic, no computador do
usuário — a mesma coisa que aconteceria se o usuário instalasse manualmente.

Redistribuir o binário dentro do nosso instalador exigiria autorização expressa
da Anthropic, que não é presumida em lugar nenhum deste projeto.

## Codex CLI

- Fornecedor: OpenAI
- Licença: `Apache-2.0`
- Repositório: https://github.com/openai/codex

A Apache-2.0 permitiria a redistribuição. Ainda assim o aplicativo busca o
runtime sob demanda, para manter o instalador pequeno e a versão atualizada.

Ao redistribuir, é preciso preservar os avisos de copyright e a cópia da
licença. O `RuntimeManager` registra os arquivos de licença encontrados na
árvore instalada, no campo `licenseFiles` do manifesto.

## MinGit (Git for Windows)

- Fornecedor: projeto Git for Windows
- Licença: `GPL-2.0`
- Origem: releases oficiais do Git for Windows

O MinGit é a distribuição mínima e portátil que o projeto publica exatamente
para ser embutida em outras aplicações. Ela é baixada e instalada na pasta
privada do aplicativo.

A GPL-2.0 exige que os avisos de licença acompanhem a cópia distribuída e que o
código-fonte correspondente seja disponibilizado. O `GitRuntime` localiza os
arquivos `LICENSE`, `COPYING` e `NOTICE` dentro da árvore extraída e os registra
no manifesto, de modo que eles permanecem junto da cópia instalada em
`%LOCALAPPDATA%\AI-Orchestrator\runtimes\git\current\`.

## Electron, Node.js e demais dependências de build

Serão listados aqui quando o empacotamento do desktop for implementado.

---

## Como este arquivo é mantido

Cada `RuntimeSource` declara a origem e a estratégia de integridade do que
entrega. Cada instalação grava um manifesto com origem, URL, versão,
arquitetura, tamanho, SHA-256, veredito de integridade, nível de confiança e os
arquivos de licença encontrados. Esse manifesto é a evidência de o que foi
instalado e de onde veio.

## Buzz (block/buzz) — estudado, não incorporado

- Fornecedor: Block, Inc.
- Licença: `Apache-2.0`
- Repositório: https://github.com/block/buzz
- Commit consultado: `3c7f288` (Buzz Desktop 0.5.23)

O Buzz foi usado como **referência técnica** para o desenho do barramento de
mensagens entre agentes: a fila por escopo com no máximo um item em voo, o
prazo de posse (*lease*) com expiração, a repetição com recuo exponencial e a
carta morta, e — a ideia mais importante para o nosso caso — a separação entre
um limite de silêncio (*idle timeout*) e um limite absoluto de duração.

**Nenhum código, texto de licença, marca, logotipo ou ativo do Buzz foi copiado
para este repositório.** O que existe aqui foi escrito do zero, em TypeScript,
contra o SQLite que este projeto já usava; o Buzz é Rust, com relay Nostr,
Postgres e Redis, nada disso presente aqui. Como não há obra derivada nem
redistribuição, a Apache-2.0 não impõe obrigações adicionais a este projeto —
mas o crédito fica registrado aqui de qualquer forma, porque a origem das
ideias merece ser dita.

Os arquivos estudados estão citados em `docs/AGENT_MESSAGE_BUS.md`.
