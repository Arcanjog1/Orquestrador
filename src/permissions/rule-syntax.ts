/**
 * Turning a refused call into a rule the CLI can actually match.
 *
 * ## What went wrong
 *
 * A person asked whether the orchestrator could reach a GitHub repository.
 * The worker reached for `WebFetch`, the non-interactive run refused it, the
 * application asked for authorisation, **the person authorised it**, and the
 * next attempt still reported:
 *
 * > Claude requested permissions to use WebFetch, but you haven't granted it
 * > yet.
 *
 * The grant was in the database. It was not a grant the runtime could use.
 * The application built the rule by putting the refused call's primary field
 * inside the parentheses - `WebFetch(https://github.com/owner/repo)` - and the
 * documented syntax does not work that way:
 *
 * > You can't match a tool's primary content field this way: `command` for
 * > Bash and PowerShell, `file_path` for Read, Edit, and Write, `path` for
 * > Grep and Glob, `notebook_path` for NotebookEdit, and `url` for WebFetch.
 * > […] Use `Bash(rm *)`, `Read(./path)`, or `WebFetch(domain:host)` instead.
 * >
 * > — <https://code.claude.com/docs/en/permissions>
 *
 * and, for a rule that does not parse into something meaningful:
 *
 * > An allow rule with an unusable pattern doesn't approve anything.
 *
 * So the approval was real, was stored, was sent on the command line, and
 * authorised nothing. This module is the one place that decides what a person
 * is offered, so a rule that reads right and means nothing cannot be built
 * again in some other file.
 *
 * ## The rules that do not bend
 *
 * - **Only syntax the documentation publishes.** Where the documentation does
 *   not define a specifier for a tool, the only thing offered is the bare tool
 *   name, and the dialog says how wide that is.
 * - **Nothing is offered that cannot work.** A path outside the working
 *   directory has no expressible rule here, so none is offered and the reason
 *   is said out loud - better than an approval that quietly does nothing.
 * - **A shell is never offered bare.** The scope for a shell is the exact
 *   command, or that command's program and subcommand with arguments.
 */

/** One thing a person can approve, exactly as it will be sent to the CLI. */
export interface PermissionScope {
  /** The `--allowedTools` rule, in the documented syntax. */
  readonly rule: string;
  readonly label: string;
  readonly detail: string;
}

export interface ScopeInput {
  /** The tool the CLI named in `permission_denials`. */
  readonly toolName: string;
  /** The primary content field the CLI reported: a command, a path, a URL. */
  readonly command?: string | null;
  /** Where the delegation was running, for deciding whether a path is inside. */
  readonly workingDirectory?: string | null;
}

/**
 * Tools that must never be granted from this flow.
 *
 * A bare `Bash` grant would authorise every command in the workspace for ever.
 * The scope offered for a shell is always the exact command; when the CLI did
 * not report one, no scope is offered at all and the dialog says why.
 */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Shell', 'Terminal']);

/**
 * Which tool a file rule must actually be written against.
 *
 * > Claude Code checks file permissions against `Edit(path)` and `Read(path)`
 * > rules only. If you write a path rule for `Write`, `NotebookEdit`, `Glob`,
 * > or the legacy `MultiEdit` tool instead, Claude Code accepts the rule but
 * > never consults it […] Use `Edit(docs/**)` in place of `Write(docs/**)`
 * > […] and `Read(docs/**)` in place of `Glob(docs/**)`.
 * >
 * > — <https://code.claude.com/docs/en/permissions>
 *
 * A `Write(...)` rule is therefore not a narrower `Edit(...)`; it is a rule
 * that is read, accepted, warned about at start-up and never consulted.
 */
const FILE_RULE_TOOL: Readonly<Record<string, 'Read' | 'Edit'>> = {
  Read: 'Read',
  Glob: 'Read',
  Grep: 'Read',
  Edit: 'Edit',
  Write: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
};

/** The scopes a refused call can be approved at. Never widens beyond these. */
export function buildScopes(input: ScopeInput): PermissionScope[] {
  const tool = input.toolName.trim();
  const primary = (input.command ?? '').trim();

  if (SHELL_TOOLS.has(tool)) return shellScopes(tool, primary);
  if (tool === 'WebFetch') return webFetchScopes(primary);
  if (tool === 'WebSearch') return [bare(tool, 'Autoriza buscas na web nesta execução e nas próximas deste projeto.')];
  if (tool in FILE_RULE_TOOL) return fileScopes(tool, primary, input.workingDirectory ?? null);
  if (tool.startsWith('mcp__')) return mcpScopes(tool);
  if (tool.length === 0) return [];
  return [bare(tool, `Autoriza ${tool} neste projeto.`)];
}

function shellScopes(tool: string, command: string): PermissionScope[] {
  if (command.length === 0) return [];
  const scopes: PermissionScope[] = [
    {
      rule: `${tool}(${command})`,
      label: 'Somente este comando',
      detail: `Autoriza exatamente \`${command}\`, e nada mais, neste projeto.`,
    },
  ];
  const prefix = commandPrefix(command);
  if (prefix && prefix !== command) {
    scopes.push({
      rule: `${tool}(${prefix} *)`,
      label: `Qualquer \`${prefix}\``,
      detail:
        `Autoriza \`${prefix}\` com quaisquer argumentos neste projeto. ` +
        'Mais amplo do que o necessário para esta tarefa.',
    });
  }
  return scopes;
}

/**
 * A fetch is authorised by **host**, never by URL.
 *
 * > WebFetch rules use a `domain:` prefix and match against the hostname of
 * > the requested URL.
 *
 * The narrow option is that one host. The wide one is the bare tool, and it is
 * labelled as what it is rather than as a second narrow choice - the two are
 * not variations of the same size.
 */
function webFetchScopes(url: string): PermissionScope[] {
  const host = hostOf(url);
  const scopes: PermissionScope[] = [];
  if (host) {
    scopes.push({
      rule: `WebFetch(domain:${host})`,
      label: `Somente ${host}`,
      detail: `Autoriza buscas em \`${host}\`, e em nenhum outro domínio, neste projeto.`,
    });
  }
  scopes.push({
    rule: 'WebFetch',
    label: 'Qualquer endereço',
    detail: host
      ? 'Autoriza buscas na web em qualquer domínio neste projeto. Mais amplo do que esta tarefa pede.'
      : 'O CLI não informou um endereço utilizável, então não há domínio a autorizar isoladamente. ' +
        'Esta opção autoriza buscas na web em qualquer domínio neste projeto.',
  });
  return scopes;
}

/**
 * The path rules, written the only way the CLI reads them.
 *
 * A path inside the working directory becomes a relative rule, which is what
 * the documented anchor `path` or `./path` means. A path outside it gets
 * **nothing**: a single leading slash is not an absolute path -
 *
 * > A pattern like `/Users/alice/file` isn't an absolute path. The single
 * > leading slash anchors at the settings source, not the filesystem root.
 *
 * - and the `//` form has no published Windows spelling. Offering a rule that
 * might mean the settings directory on one machine and the filesystem root on
 * another would be worse than saying plainly that the folder has to include
 * the file.
 */
function fileScopes(tool: string, path: string, workingDirectory: string | null): PermissionScope[] {
  const ruleTool = FILE_RULE_TOOL[tool] ?? 'Read';
  const relative = path.length > 0 ? relativeInside(path, workingDirectory) : null;
  const scopes: PermissionScope[] = [];
  if (relative) {
    scopes.push({
      rule: `${ruleTool}(${escapePattern(relative)})`,
      label: 'Somente este arquivo',
      detail: `Autoriza ${ruleTool} em \`${relative}\`, dentro da pasta do projeto.`,
    });
  }
  scopes.push({
    rule: ruleTool,
    label: `${ruleTool} neste projeto`,
    detail:
      path.length > 0 && !relative
        ? `\`${path}\` está fora da pasta do projeto, e o Claude Code limita estas ferramentas ao ` +
          'diretório de trabalho: autorizar aqui não alcançaria esse caminho. Para trabalhar nele, ' +
          'a pasta do projeto precisa incluí-lo. Esta opção autoriza ' +
          `${ruleTool} dentro da pasta do projeto.`
        : `Autoriza ${ruleTool} dentro da pasta do projeto.`,
  });
  return scopes;
}

/**
 * An MCP tool is authorised whole, because a narrower rule would be dropped.
 *
 * > When Claude Code loads a settings file, it skips any `mcp__` rule that has
 * > parentheses.
 */
function mcpScopes(tool: string): PermissionScope[] {
  return [
    {
      rule: tool,
      label: 'Autorizar esta ferramenta',
      detail:
        `Autoriza \`${tool}\` neste projeto. Ferramentas MCP não aceitam um escopo mais estreito: ` +
        'uma regra com parênteses é descartada pelo Claude Code.',
    },
  ];
}

function bare(tool: string, detail: string): PermissionScope {
  return { rule: tool, label: `${tool} neste projeto`, detail };
}

/**
 * The host of a URL, or null when there is not one to be sure about.
 *
 * A bare host (`github.com/owner`) is accepted because the CLI reports the
 * `url` field as the model wrote it, and a missing scheme is a common way to
 * write one. Anything that does not parse into a host yields null, and the
 * caller offers no domain rule rather than a guessed one.
 */
export function hostOf(url: string): string | null {
  const text = url.trim();
  if (text.length === 0) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let host: string;
  try {
    // A trailing dot is stripped from both sides when the CLI matches, so it
    // is stripped here too rather than becoming a rule that never matches.
    host = new URL(candidate).hostname.trim().toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  // A host has to look like one. `new URL` accepts a great deal that would
  // never be a domain, and a rule built from it would match nothing while
  // looking as though it might.
  if (host === 'localhost') return host;
  if (/^[a-z0-9.-]+$/.test(host) && host.includes('.') && !host.startsWith('.')) return host;
  return null;
}

/**
 * The path relative to the working directory, or null when it is not inside.
 *
 * Written without `node:path` on purpose: this decides a rule the CLI reads,
 * and the CLI's patterns use `/` on every platform. Comparing with the host
 * platform's separator would make the same project behave differently
 * depending on which machine asked the question.
 */
export function relativeInside(target: string, workingDirectory: string | null): string | null {
  const file = normalisePath(target);
  if (file.length === 0) return null;
  const base = workingDirectory ? normalisePath(workingDirectory) : '';
  // A relative path was reported: it is already relative to the working
  // directory, which is the only place the delegation ran.
  if (!isAbsolute(file)) return stripLeadingDot(file) || null;
  if (base.length === 0 || !isAbsolute(base)) return null;
  const root = base.endsWith('/') ? base : `${base}/`;
  // Windows paths are compared case-insensitively; POSIX ones are not. The
  // drive letter is the give-away, and it is the one place a platform
  // difference is real rather than cosmetic.
  const windows = /^[A-Za-z]:\//.test(root);
  const a = windows ? file.toLowerCase() : file;
  const b = windows ? root.toLowerCase() : root;
  if (!a.startsWith(b)) return null;
  const relative = file.slice(root.length);
  return relative.length > 0 ? relative : null;
}

function normalisePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function isAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

function stripLeadingDot(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

/**
 * Escapes the gitignore metacharacters in a literal path.
 *
 * > When you approve a file path with "Yes, and don't ask again", Claude Code
 * > escapes gitignore pattern characters in that path, such as `[`, `]`, and
 * > `*`, so the generated rule matches only the literal path you approved.
 *
 * The same reasoning applies to a rule this application generates: the person
 * approved one file, and a directory called `[2024] Reports` must not turn
 * their approval into a character class.
 */
export function escapePattern(path: string): string {
  const escaped = path.replace(/[\\[\]*?]/g, (character) => `\\${character}`);
  // A leading `!` negates and a leading `#` comments, in gitignore syntax.
  return /^[!#]/.test(escaped) ? `\\${escaped}` : escaped;
}

/**
 * The program and subcommand of a command, for the "any arguments" scope.
 *
 * Two words at most, and only while they are plain words. The documented rule
 * syntax matches everything before the first `*` literally, so a prefix built
 * from an option or a path would produce a rule that means something other
 * than it looks like - and a permission rule that reads wrong is worse than no
 * second option at all.
 */
export function commandPrefix(command: string): string | null {
  const words = command.trim().split(/\s+/);
  const plain = /^[A-Za-z0-9._@+-]+$/;
  const head = words[0];
  // A head that starts with `-` is an option, not a program. `Bash(--help *)`
  // reads like a rule and authorises nothing, which is the same class of
  // mistake as putting a URL inside `WebFetch(...)`.
  if (!head || head.startsWith('-') || !plain.test(head)) return null;
  const second = words[1];
  if (second && plain.test(second) && !second.startsWith('-')) return `${head} ${second}`;
  return head;
}
