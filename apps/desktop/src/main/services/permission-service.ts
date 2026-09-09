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

import type { Database, ResumptionDecision, ToolPermissionRequestRecord } from '../core.js';
import { buildScopes, explainRefusal, newId, redact } from '../core.js';
import type {
  PermissionDecisionView,
  PermissionGrantView,
  PermissionRequestView,
  PermissionScopeOption,
} from '../../shared/ipc-contract.js';

/**
 * What the answer to an authorisation has to do besides record itself.
 *
 * The service that owns the loop implements this. Kept as a one-method seam so
 * the permission flow does not import the orchestrator - and so the decision
 * to continue can be tested without one.
 */
export interface RunResumer {
  resumeAfterApproval(runId: string): ResumptionDecision;
}

export class PermissionError extends Error {
  readonly code = 'PERMISSION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

export class PermissionService {
  constructor(
    private readonly database: Database,
    /**
     * Who continues the run this request stopped.
     *
     * Optional so the service stands alone in a test, and set once at
     * start-up in the application. When it is absent the grant is still
     * recorded - the authorisation is never lost - and the answer says
     * plainly that nothing was resumed.
     */
    private readonly resumer: RunResumer | null = null,
  ) {}

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
  approve(requestId: string, rule: string): PermissionDecisionView {
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
    return this.decided(requestId, record.run_id);
  }

  /** Refuses a request. Nothing is granted; the refusal is kept. */
  deny(requestId: string): PermissionDecisionView {
    const record = this.database.permissions.requireRequest(requestId);
    if (record.status !== 'pending') {
      throw new PermissionError('Este pedido já foi respondido.');
    }
    this.database.permissions.deny(requestId);
    return this.decided(requestId, record.run_id);
  }

  /**
   * The answer to "did my decision do anything?", which is the question the
   * person is actually asking.
   *
   * Recording the grant and continuing the task are two different things, and
   * the incident this closes is exactly the gap between them: the row said
   * `approved` and the run never moved. So the answer carries both, and it
   * carries the reason when the run legitimately does not continue - a
   * cancelled run, a finished one, or other questions still unanswered.
   */
  private decided(requestId: string, runId: string | null): PermissionDecisionView {
    const request = this.view(this.database.permissions.requireRequest(requestId));
    const outcome = runId && this.resumer ? this.resumer.resumeAfterApproval(runId) : null;
    return {
      request,
      resumed: outcome?.resume === true,
      notResumedBecause: outcome && !outcome.resume ? explainRefusal(outcome.because) : null,
      rules: this.database.permissions.rulesFor(request.workspaceId),
    };
  }

  /** Withdraws a standing grant. The requests keep their history. */
  revoke(grantId: string): { revoked: boolean } {
    return { revoked: this.database.permissions.revoke(grantId) };
  }

  /**
   * The scopes this request can be approved at.
   *
   * Computed here rather than offered by the renderer, and built by
   * `buildScopes`, which is the one place that knows the documented rule
   * syntax. This method used to build the rules itself by putting the refused
   * call's primary field in parentheses - `WebFetch(https://...)`,
   * `Read(C:\\path\\file.ts)` - and the CLI matches neither, so an approval
   * was stored, sent, and authorised nothing. See `src/permissions/rule-syntax.ts`.
   */
  scopes(record: ToolPermissionRequestRecord): PermissionScopeOption[] {
    return buildScopes({
      toolName: record.tool_name,
      command: record.command,
      workingDirectory: record.working_directory,
    });
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
