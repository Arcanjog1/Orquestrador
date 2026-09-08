/**
 * Authorising one operation, and nothing wider.
 *
 * ## What went wrong
 *
 * A run ended in `NEEDS_HUMAN` saying the person should authorise the
 * operation, and offered nothing to authorise. The cause is documented:
 *
 * > In addition to file edits, `acceptEdits` mode auto-approves common
 * > filesystem Bash commands: `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, and
 * > `sed` […] and **all other Bash commands except the built-in read-only set
 * > still prompt**.
 * > — <https://code.claude.com/docs/en/permission-modes>
 *
 * In `--print` nobody can answer a prompt, so the call is refused and the CLI
 * reports it in `permission_denials`. The application read that correctly and
 * then had nowhere to go with it.
 *
 * ## What this does
 *
 * Turns each refusal into a question with an answer, using the one mechanism
 * the CLI documents for a non-interactive run: **`--allowedTools`**, whose
 * rule syntax is published. A person approves a scope, the scope is stored for
 * that workspace, and the next delegation carries it.
 *
 * ## The rules that do not bend
 *
 * - **A grant is only ever created by a person answering.** Nothing here
 *   infers one from a failure, and nothing widens one.
 * - **A grant belongs to one workspace.** Approving a command in one project
 *   authorises nothing in another.
 * - **`bypassPermissions`, `--dangerously-skip-permissions`, elevation and
 *   sandbox-disabling are never used**, and no code path here can reach them.
 * - **A refusal is respected and kept.** Denying is a decision with a record,
 *   not a dismissal.
 */

import type { Database, ToolPermissionRequestRecord } from '../core.js';
import { newId, redact } from '../core.js';
import type {
  PermissionGrantView,
  PermissionRequestView,
  PermissionScopeOption,
} from '../../shared/ipc-contract.js';

export class PermissionError extends Error {
  readonly code = 'PERMISSION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

/**
 * Tools that must never be granted from this flow.
 *
 * A bare `Bash` grant would authorise every command in the workspace for
 * ever, which is precisely the "liberar o computador inteiro" the person said
 * they did not want. The scope offered for a shell is always the exact
 * command; when the CLI did not report one, no scope is offered at all and the
 * dialog says why.
 */
const NEVER_BARE = new Set(['Bash', 'PowerShell', 'Shell', 'Terminal']);

export class PermissionService {
  constructor(private readonly database: Database) {}

  /** Everything waiting on a person, newest first. */
  pending(): PermissionRequestView[] {
    return this.database.permissions.pending().map((row) => this.view(row));
  }

  /** Every request of one run, decided ones included, in order. */
  forRun(runId: string): PermissionRequestView[] {
    return this.database.permissions.forRun(runId).map((row) => this.view(row));
  }

  grants(workspaceId: string): PermissionGrantView[] {
    return this.database.permissions.grantsFor(workspaceId).map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      rule: row.rule,
      requestId: row.request_id,
      createdAt: row.created_at,
    }));
  }

  /**
   * Approves a request, at exactly one of the scopes it offered.
   *
   * `rule` is checked against the options the request itself published, so an
   * approval can never be for something the dialog did not show. A renderer
   * that sent a wider rule than it displayed would be refused here, which is
   * the point of validating it in the main process.
   */
  approve(requestId: string, rule: string): PermissionRequestView {
    const record = this.database.permissions.requireRequest(requestId);
    if (record.status !== 'pending') {
      throw new PermissionError('Este pedido já foi respondido.');
    }
    const offered = this.scopes(record);
    const chosen = offered.find((option) => option.rule === rule);
    if (!chosen) {
      throw new PermissionError(
        'Essa autorização não é uma das opções deste pedido. Nada foi concedido.',
      );
    }
    this.database.permissions.approve({
      requestId,
      rule: chosen.rule,
      grantId: newId('grant'),
    });
    return this.view(this.database.permissions.requireRequest(requestId));
  }

  /** Refuses a request. Nothing is granted; the refusal is kept. */
  deny(requestId: string): PermissionRequestView {
    const record = this.database.permissions.requireRequest(requestId);
    if (record.status !== 'pending') {
      throw new PermissionError('Este pedido já foi respondido.');
    }
    return this.view(this.database.permissions.deny(requestId));
  }

  /** Withdraws a standing grant. The requests keep their history. */
  revoke(grantId: string): { revoked: boolean } {
    return { revoked: this.database.permissions.revoke(grantId) };
  }

  /**
   * The scopes this request can be approved at.
   *
   * Deliberately narrow, and computed here rather than offered by the
   * renderer:
   *
   * - **a shell command** can be approved only as that exact command, or as
   *   that command with any arguments (`Bash(git log *)` style). Never as the
   *   bare tool.
   * - **a file tool** can be approved for the path it named, or for the tool
   *   in this workspace - both are bounded by the working directory the CLI
   *   already enforces.
   * - **a call the CLI described only by name** offers the bare tool *unless*
   *   it is a shell, in which case there is nothing safe to offer and the
   *   dialog says so.
   */
  scopes(record: ToolPermissionRequestRecord): PermissionScopeOption[] {
    const tool = record.tool_name;
    const command = record.command?.trim();
    const options: PermissionScopeOption[] = [];

    if (command && command.length > 0) {
      if (NEVER_BARE.has(tool)) {
        options.push({
          rule: `${tool}(${command})`,
          label: 'Somente este comando',
          detail: `Autoriza exatamente \`${command}\`, e nada mais, neste projeto.`,
        });
        const prefix = commandPrefix(command);
        if (prefix && prefix !== command) {
          options.push({
            rule: `${tool}(${prefix} *)`,
            label: `Qualquer \`${prefix}\``,
            detail:
              `Autoriza \`${prefix}\` com quaisquer argumentos neste projeto. ` +
              'Mais amplo do que o necessário para esta tarefa.',
          });
        }
      } else {
        options.push({
          rule: `${tool}(${command})`,
          label: 'Somente este caminho',
          detail: `Autoriza ${tool} em \`${command}\`, neste projeto.`,
        });
        options.push({
          rule: tool,
          label: `${tool} neste projeto`,
          detail:
            `Autoriza ${tool} dentro da pasta do projeto. O Claude Code já limita ` +
            'estas ferramentas ao diretório de trabalho.',
        });
      }
      return options;
    }

    // No command reported. A shell has nothing safe to offer.
    if (NEVER_BARE.has(tool)) return [];
    return [
      {
        rule: tool,
        label: `${tool} neste projeto`,
        detail: `Autoriza ${tool} dentro da pasta do projeto.`,
      },
    ];
  }

  private view(record: ToolPermissionRequestRecord): PermissionRequestView {
    const agent = record.agent_id ? this.database.agents.find(record.agent_id) : undefined;
    const account = record.account_id ? this.database.accounts.find(record.account_id) : undefined;
    const workspace = this.database.workspaces.find(record.workspace_id);
    return {
      id: record.id,
      runId: record.run_id,
      sessionId: record.session_id,
      workspaceId: record.workspace_id,
      workspaceName: typeof workspace?.display_name === 'string' ? workspace.display_name : null,
      iteration: record.iteration,
      agentId: record.agent_id,
      agentName: typeof agent?.display_name === 'string' ? agent.display_name : null,
      accountId: record.account_id,
      accountName: typeof account?.display_name === 'string' ? account.display_name : null,
      toolName: record.tool_name,
      toolUseId: record.tool_use_id,
      // Redacted on the way in and again on the way out: this crosses to the
      // renderer, and a command line can carry a token somebody pasted.
      command: record.command === null ? null : redact(record.command),
      arguments: record.arguments === null ? null : redact(record.arguments),
      workingDirectory: record.working_directory,
      reason: record.reason,
      status: statusOf(record.status),
      approvedRule: record.approved_rule,
      scopes: this.scopes(record),
      decidedAt: record.decided_at,
      createdAt: record.created_at,
    };
  }
}

function statusOf(value: string): PermissionRequestView['status'] {
  return value === 'approved' || value === 'denied' || value === 'superseded' ? value : 'pending';
}

/**
 * The program and subcommand of a command, for the "any arguments" scope.
 *
 * Two words at most, and only while they are plain words. The documented rule
 * syntax matches everything before the first `*` literally, so a prefix built
 * from an option or a path would produce a rule that means something other
 * than it looks like — and a permission rule that reads wrong is worse than no
 * second option at all.
 */
function commandPrefix(command: string): string | null {
  const words = command.trim().split(/\s+/);
  const plain = /^[A-Za-z0-9._@+-]+$/;
  const head = words[0];
  if (!head || !plain.test(head)) return null;
  const second = words[1];
  if (second && plain.test(second) && !second.startsWith('-')) return `${head} ${second}`;
  return head;
}
