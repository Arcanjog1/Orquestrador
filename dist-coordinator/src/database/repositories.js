/**
 * Repositories for the entities the desktop application works with.
 *
 * Same rule as the rest of `src/database`: SQL stops here. Services, the IPC
 * layer and the renderer see records and nothing else. Ids are generated here
 * too, in a shape the IPC validator accepts, so no caller has to invent one.
 */
import { randomUUID } from 'node:crypto';
/** Ids are `<prefix>-<hex>`: readable in logs, and safe as a folder name. */
export function newId(prefix) {
    return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
function now() {
    return new Date().toISOString();
}
class Repository {
    getDriver;
    constructor(getDriver) {
        this.getDriver = getDriver;
    }
    get db() {
        return this.getDriver();
    }
}
export class ProviderRepository extends Repository {
    /** Inserts the providers the product ships with, once. */
    ensureSeeded() {
        const seeds = [
            ['anthropic', 'Anthropic'],
            ['openai', 'OpenAI'],
            ['google', 'Google'],
        ];
        for (const [id, displayName] of seeds) {
            this.db.run('INSERT INTO providers (id, display_name, enabled, created_at) VALUES (?,?,1,?) ON CONFLICT(id) DO NOTHING', [id, displayName, now()]);
        }
    }
    list() {
        return this.db.all('SELECT * FROM providers ORDER BY display_name');
    }
}
export class AccountRepository extends Repository {
    create(input) {
        this.db.run('INSERT INTO accounts (id, provider_id, display_name, profile_directory, auth_state, created_at) VALUES (?,?,?,?,?,?)', [input.id, input.providerId, input.displayName, input.profileDirectory, 'disconnected', now()]);
        return this.require(input.id);
    }
    list() {
        return this.db.all('SELECT * FROM accounts ORDER BY created_at');
    }
    find(id) {
        return this.db.get('SELECT * FROM accounts WHERE id = ?', [id]);
    }
    require(id) {
        const row = this.find(id);
        if (!row)
            throw new RecordNotFoundError('account', id);
        return row;
    }
    updateAuth(id, state, authMethod) {
        const timestamp = now();
        this.db.run('UPDATE accounts SET auth_state = ?, auth_method = ?, last_checked_at = ?, last_connected_at = CASE WHEN ? = \'connected\' THEN ? ELSE last_connected_at END WHERE id = ?', [state, authMethod, timestamp, state, timestamp, id]);
    }
    remove(id) {
        return this.db.run('DELETE FROM accounts WHERE id = ?', [id]).changes > 0;
    }
}
export class AgentRepository extends Repository {
    create(input) {
        this.db.run('INSERT INTO agents (id, display_name, provider_id, account_id, adapter_id, role, created_at) VALUES (?,?,?,?,?,?,?)', [
            input.id,
            input.displayName,
            input.providerId,
            input.accountId,
            input.adapterId,
            input.role,
            now(),
        ]);
        return this.require(input.id);
    }
    /** Creates the agent if an equivalent one is not already there. */
    ensure(input) {
        const existing = this.find(input.id);
        if (existing)
            return existing;
        return this.create(input);
    }
    list() {
        return this.db.all('SELECT * FROM agents WHERE enabled = 1 ORDER BY role, display_name');
    }
    find(id) {
        return this.db.get('SELECT * FROM agents WHERE id = ?', [id]);
    }
    require(id) {
        const row = this.find(id);
        if (!row)
            throw new RecordNotFoundError('agent', id);
        return row;
    }
    setAccount(id, accountId) {
        this.db.run('UPDATE agents SET account_id = ? WHERE id = ?', [accountId, id]);
    }
}
export class WorkspaceRepository extends Repository {
    create(input) {
        const timestamp = now();
        this.db.run(`INSERT INTO workspaces
         (id, display_name, local_path, repository_url, default_branch, created_at, updated_at,
          environment, repository_full_name, repository_private, branch, cloud_endpoint)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
            input.id,
            input.name,
            input.localPath,
            input.repositoryUrl ?? null,
            input.defaultBranch ?? null,
            timestamp,
            timestamp,
            input.environment ?? 'local',
            input.repositoryFullName ?? null,
            input.repositoryPrivate === null || input.repositoryPrivate === undefined
                ? null
                : input.repositoryPrivate
                    ? 1
                    : 0,
            input.branch ?? null,
            input.cloudEndpoint ?? null,
        ]);
        return this.require(input.id);
    }
    list() {
        return this.db
            .all('SELECT * FROM workspaces ORDER BY COALESCE(updated_at, created_at) DESC')
            .map((row) => this.withAgents(row));
    }
    find(id) {
        const row = this.db.get('SELECT * FROM workspaces WHERE id = ?', [id]);
        return row ? this.withAgents(row) : undefined;
    }
    require(id) {
        const row = this.find(id);
        if (!row)
            throw new RecordNotFoundError('workspace', id);
        return row;
    }
    findByPath(localPath) {
        const row = this.db.get('SELECT * FROM workspaces WHERE local_path = ?', [
            localPath,
        ]);
        return row ? this.withAgents(row) : undefined;
    }
    /**
     * Binds one agent per role. A workspace has exactly one orchestrator and one
     * worker, so the previous binding for the role is replaced rather than added
     * to.
     */
    setAgents(workspaceId, orchestratorAgentId, workerAgentId) {
        return this.setTeam(workspaceId, { agentId: orchestratorAgentId }, { agentId: workerAgentId });
    }
    /**
     * The full binding: who supervises, who executes, and with which model and
     * reasoning level each. `setAgents` is this with the defaults.
     */
    setTeam(workspaceId, orchestrator, worker) {
        this.db.transaction(() => {
            this.db.run('DELETE FROM workspace_agents WHERE workspace_id = ?', [workspaceId]);
            for (const [role, member] of [
                ['ORCHESTRATOR', orchestrator],
                ['CODING_WORKER', worker],
            ]) {
                this.db.run('INSERT INTO workspace_agents (workspace_id, agent_id, role, model, reasoning, selection) VALUES (?,?,?,?,?,?)', [
                    workspaceId,
                    member.agentId,
                    role,
                    blankToNull(member.model),
                    blankToNull(member.reasoning),
                    blankToNull(member.selection),
                ]);
            }
            this.touch(workspaceId);
        });
        return this.require(workspaceId);
    }
    touch(workspaceId) {
        this.db.run('UPDATE workspaces SET updated_at = ? WHERE id = ?', [now(), workspaceId]);
    }
    rename(workspaceId, name) {
        this.db.run('UPDATE workspaces SET display_name = ?, updated_at = ? WHERE id = ?', [
            name,
            now(),
            workspaceId,
        ]);
        return this.require(workspaceId);
    }
    /**
     * Forgets the workspace: its row, and by cascade its team bindings,
     * verifications, conversations and runs. The folder on disk is not this
     * class's to touch, and it never is.
     */
    remove(workspaceId) {
        const result = this.db.run('DELETE FROM workspaces WHERE id = ?', [workspaceId]);
        return Number(result.changes) > 0;
    }
    withAgents(row) {
        const bindings = this.db.all('SELECT agent_id, role, model, reasoning, selection FROM workspace_agents WHERE workspace_id = ?', [
            row.id,
        ]);
        const orchestrator = bindings.find((b) => b.role === 'ORCHESTRATOR');
        const worker = bindings.find((b) => b.role === 'CODING_WORKER');
        return {
            ...row,
            orchestrator_agent_id: orchestrator?.agent_id ?? null,
            worker_agent_id: worker?.agent_id ?? null,
            orchestrator_model: orchestrator?.model ?? null,
            orchestrator_reasoning: orchestrator?.reasoning ?? null,
            orchestrator_selection: orchestrator?.selection ?? null,
            worker_model: worker?.model ?? null,
            worker_reasoning: worker?.reasoning ?? null,
            worker_selection: worker?.selection ?? null,
        };
    }
}
function blankToNull(value) {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
}
/**
 * Projects: the organisation of conversations, distinct from workspaces
 * (the folders agents work in). One project may point at one workspace, or
 * at none; a conversation belongs to at most one project.
 */
export class ProjectRepository extends Repository {
    create(input) {
        const timestamp = now();
        this.db.run('INSERT INTO projects (id, name, workspace_id, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)', [
            input.id,
            input.name,
            input.workspaceId ?? null,
            input.metadata === undefined ? null : JSON.stringify(input.metadata),
            timestamp,
            timestamp,
        ]);
        return this.require(input.id);
    }
    list() {
        return this.db.all('SELECT * FROM projects ORDER BY updated_at DESC, name');
    }
    find(id) {
        return this.db.get('SELECT * FROM projects WHERE id = ?', [id]);
    }
    require(id) {
        const row = this.find(id);
        if (!row)
            throw new Error(`Project ${id} does not exist.`);
        return row;
    }
    rename(id, name) {
        this.db.run('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', [name, now(), id]);
        return this.require(id);
    }
    setWorkspace(id, workspaceId) {
        this.db.run('UPDATE projects SET workspace_id = ?, updated_at = ? WHERE id = ?', [workspaceId, now(), id]);
        return this.require(id);
    }
    touch(id) {
        this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [now(), id]);
    }
    countSessions(id, includeArchived = false) {
        const row = this.db.get(`SELECT COUNT(*) AS n FROM chat_sessions WHERE project_id = ?${includeArchived ? '' : ' AND archived_at IS NULL'}`, [id]);
        return Number(row?.n ?? 0);
    }
    /**
     * Forgets the project. Its conversations are kept and become "Sem projeto"
     * (the foreign key sets their project to NULL); no workspace, repository
     * or file is touched. Returns how many conversations were moved.
     */
    remove(id) {
        const sessionsMoved = this.countSessions(id, true);
        const result = this.db.run('DELETE FROM projects WHERE id = ?', [id]);
        return { removed: Number(result.changes) > 0, sessionsMoved };
    }
}
export class ChatRepository extends Repository {
    createSession(input) {
        const timestamp = now();
        this.db.run('INSERT INTO chat_sessions (id, workspace_id, title, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?)', [input.id, input.workspaceId, input.title, input.projectId ?? null, timestamp, timestamp]);
        return this.requireSession(input.id);
    }
    listSessions(workspaceId, options = {}) {
        return this.query(['workspace_id = ?'], [workspaceId], options);
    }
    /** Every conversation, of every workspace: what the project tree shows. */
    listAllSessions(options = {}) {
        return this.query([], [], options);
    }
    /** Files a conversation under a project, or under none. */
    setSessionProject(id, projectId) {
        this.db.run('UPDATE chat_sessions SET project_id = ? WHERE id = ?', [projectId, id]);
        return this.requireSession(id);
    }
    query(where, params, options) {
        const clauses = [...where];
        const values = [...params];
        if (!options.includeArchived)
            clauses.push('archived_at IS NULL');
        if (options.projectId === null)
            clauses.push('project_id IS NULL');
        else if (options.projectId !== undefined) {
            clauses.push('project_id = ?');
            values.push(options.projectId);
        }
        const rows = this.db.all(`SELECT * FROM chat_sessions${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`, values);
        // Matched here rather than with LIKE: SQLite folds case for ASCII only, and
        // titles are written in Portuguese. The list is small.
        const query = options.query?.trim().toLocaleLowerCase() ?? '';
        if (query.length === 0)
            return rows;
        return rows.filter((row) => row.title.toLocaleLowerCase().includes(query));
    }
    renameSession(id, title) {
        this.db.run('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?', [title, now(), id]);
        return this.requireSession(id);
    }
    /** Archiving hides; it never deletes. `false` brings the conversation back. */
    setSessionArchived(id, archived) {
        this.db.run('UPDATE chat_sessions SET archived_at = ? WHERE id = ?', [archived ? now() : null, id]);
        return this.requireSession(id);
    }
    /**
     * Removes the conversation and its messages. Runs are kept: their
     * `session_id` becomes NULL through the foreign key, so the execution history
     * and its evidence stay whole after the conversation is gone.
     */
    deleteSession(id) {
        const result = this.db.run('DELETE FROM chat_sessions WHERE id = ?', [id]);
        return Number(result.changes) > 0;
    }
    countMessages(sessionId) {
        const row = this.db.get('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', [
            sessionId,
        ]);
        return Number(row?.n ?? 0);
    }
    findSession(id) {
        return this.db.get('SELECT * FROM chat_sessions WHERE id = ?', [id]);
    }
    requireSession(id) {
        const row = this.findSession(id);
        if (!row)
            throw new RecordNotFoundError('chat session', id);
        return row;
    }
    addMessage(input) {
        const id = newId('msg');
        const timestamp = now();
        this.db.transaction(() => {
            this.db.run('INSERT INTO messages (id, session_id, run_id, kind, author, agent_id, body, payload, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
                id,
                input.sessionId,
                input.runId ?? null,
                input.kind ?? 'text',
                input.author,
                input.agentId ?? null,
                input.body,
                input.payload === undefined ? null : JSON.stringify(input.payload),
                timestamp,
            ]);
            this.db.run('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', [timestamp, input.sessionId]);
        });
        return this.db.get('SELECT * FROM messages WHERE id = ?', [id]);
    }
    /** Links a message to the run it started, once the run exists. */
    setMessageRun(messageId, runId) {
        this.db.run('UPDATE messages SET run_id = ? WHERE id = ?', [runId, messageId]);
    }
    listMessages(sessionId, limit = 500) {
        return this.db.all('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid LIMIT ?', [sessionId, limit]);
    }
}
export class RunRepository extends Repository {
    create(input) {
        this.db.run('INSERT INTO runs (id, session_id, workspace_id, objective, status, orchestrator_agent_id, iteration, max_iterations, artifacts_path, started_at) VALUES (?,?,?,?,?,?,0,?,?,?)', [
            input.id,
            input.sessionId,
            input.workspaceId,
            input.objective,
            'PENDING',
            input.orchestratorAgentId,
            input.maxIterations,
            input.artifactsPath ?? null,
            now(),
        ]);
        return this.require(input.id);
    }
    find(id) {
        return this.db.get('SELECT * FROM runs WHERE id = ?', [id]);
    }
    require(id) {
        const row = this.find(id);
        if (!row)
            throw new RecordNotFoundError('run', id);
        return row;
    }
    listForSession(sessionId) {
        return this.db.all('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at', [
            sessionId,
        ]);
    }
    /** Runs the database still shows as going. After a restart, none really is. */
    listUnfinished() {
        return this.db.all("SELECT * FROM runs WHERE status IN ('PENDING','RUNNING') ORDER BY started_at");
    }
    /** Every run of a workspace, newest first, whether or not its conversation still exists. */
    listForWorkspace(workspaceId, limit = 200) {
        return this.db.all('SELECT * FROM runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?', [workspaceId, limit]);
    }
    setStatus(id, status, terminationReason) {
        const finished = status === 'RUNNING' || status === 'PENDING' ? null : now();
        this.db.run('UPDATE runs SET status = ?, termination_reason = COALESCE(?, termination_reason), finished_at = ? WHERE id = ?', [status, terminationReason ?? null, finished, id]);
    }
    setBaseline(id, branch, commit, dirty) {
        this.db.run('UPDATE runs SET baseline_branch = ?, baseline_commit = ?, baseline_dirty = ? WHERE id = ?', [branch, commit, dirty ? 1 : 0, id]);
    }
    setIteration(id, iteration) {
        this.db.run('UPDATE runs SET iteration = ? WHERE id = ?', [iteration, id]);
    }
    /** Binds a local run to the remote one that is actually executing it. */
    bindRemote(id, input) {
        this.db.run('UPDATE runs SET remote_run_id = ?, cloud_workspace_id = ? WHERE id = ?', [
            input.remoteRunId,
            input.cloudWorkspaceId ?? null,
            id,
        ]);
    }
    /**
     * How far this desktop has caught up with a remote run's event log.
     *
     * Stored rather than remembered, so an application that was closed for a
     * week resumes from the same place as one closed for a second - and neither
     * replays a step it already applied.
     */
    remoteCursor(id) {
        return this.db.get('SELECT remote_cursor FROM runs WHERE id = ?', [id])
            ?.remote_cursor ?? 0;
    }
    /** Advances the cursor. Never moves backwards: a stale sync cannot rewind it. */
    setRemoteCursor(id, cursor) {
        this.db.run('UPDATE runs SET remote_cursor = MAX(COALESCE(remote_cursor, 0), ?) WHERE id = ?', [
            cursor,
            id,
        ]);
    }
    /** Local runs bound to a remote one that has not finished here yet. */
    listUnfinishedRemote() {
        return this.db.all(`SELECT * FROM runs
        WHERE remote_run_id IS NOT NULL AND status NOT IN ('DONE','FAILED','CANCELLED')
        ORDER BY started_at ASC`);
    }
    addStep(input) {
        const result = this.db.run('INSERT INTO run_steps (run_id, iteration, phase, status, summary, detail, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?)', [
            input.runId,
            input.iteration,
            input.phase,
            input.status,
            input.summary ?? null,
            input.detail ?? null,
            now(),
            now(),
        ]);
        return Number(result.lastInsertRowid);
    }
    steps(runId) {
        return this.db.all('SELECT * FROM run_steps WHERE run_id = ? ORDER BY id', [runId]);
    }
    recordInvocation(input) {
        const id = newId('inv');
        const routing = input.routing ?? null;
        this.db.run('INSERT INTO agent_invocations (id, run_id, iteration, agent_id, account_id, role, task, outcome, exit_code, duration_ms, started_at, finished_at, requested_capability, requested_reasoning, resolved_model, resolved_reasoning, selection_mode, selection_reason, fallback_used) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
            id,
            input.runId,
            input.iteration,
            input.agentId,
            input.accountId,
            input.role,
            input.task,
            input.outcome,
            input.exitCode,
            input.durationMs,
            input.startedAt,
            now(),
            routing?.requestedCapability ?? null,
            routing?.requestedReasoning ?? null,
            routing?.resolvedModel ?? null,
            routing?.resolvedReasoning ?? null,
            routing?.selectionMode ?? null,
            routing ? routing.selectionReason.slice(0, 1000) : null,
            routing ? (routing.fallbackUsed ? 1 : 0) : null,
        ]);
        return id;
    }
    invocations(runId) {
        return this.db.all('SELECT * FROM agent_invocations WHERE run_id = ? ORDER BY started_at', [runId]);
    }
    recordVerification(input) {
        this.db.run('INSERT INTO verification_results (run_id, iteration, definition_id, command, exit_code, passed, refused, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
            input.runId,
            input.iteration,
            input.definitionId,
            input.command,
            input.exitCode,
            input.passed ? 1 : 0,
            input.refused ?? null,
            input.durationMs,
            now(),
        ]);
    }
    verifications(runId) {
        return this.db.all('SELECT * FROM verification_results WHERE run_id = ? ORDER BY id', [runId]);
    }
}
/**
 * The commands a workspace owner has approved.
 *
 * An orchestrator agent asks for a verification **by id**; it never supplies a
 * command line. This repository is the only place a command string can enter
 * the system, and it only ever gets there because a human put it there.
 */
export class VerificationDefinitionRepository extends Repository {
    upsert(input) {
        this.db.run('INSERT INTO verification_definitions (id, workspace_id, label, command, enabled, created_at) VALUES (?,?,?,?,1,?) ON CONFLICT(workspace_id, id) DO UPDATE SET label = excluded.label, command = excluded.command', [input.id, input.workspaceId, input.label, input.command, now()]);
    }
    /**
     * The definitions an orchestrator may ask for: enabled ones only.
     *
     * A disabled definition is deliberately invisible here, so `resolve` reports
     * it as unknown and the loop refuses it rather than running it. The interface
     * uses `listAll` instead, which is the only place a disabled row is seen.
     */
    list(workspaceId) {
        return this.db.all('SELECT * FROM verification_definitions WHERE workspace_id = ? AND enabled = 1 ORDER BY id', [workspaceId]);
    }
    /** Every definition of one workspace, enabled or not, for the interface. */
    listAll(workspaceId) {
        return this.db.all('SELECT * FROM verification_definitions WHERE workspace_id = ? ORDER BY id', [workspaceId]);
    }
    /**
     * One definition, looked up by workspace *and* id.
     *
     * The workspace is part of the key, so a caller holding an id from another
     * project gets nothing back rather than someone else's row.
     */
    find(workspaceId, id) {
        return this.db.get('SELECT * FROM verification_definitions WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    }
    /**
     * Adds a definition, refusing to overwrite one that already exists.
     *
     * `upsert` is the loader used by scripts and tests, where replacing is the
     * point. A person adding a verification in the interface means to add one, so
     * a clash is an error they can see rather than a silent replacement of the
     * command a run may already depend on.
     */
    create(input) {
        this.db.run('INSERT INTO verification_definitions (id, workspace_id, label, command, enabled, created_at) VALUES (?,?,?,?,?,?)', [
            input.id,
            input.workspaceId,
            input.label,
            input.command,
            input.enabled === false ? 0 : 1,
            now(),
        ]);
        return this.require(input.workspaceId, input.id);
    }
    /** Changes label, command and/or enabled on an existing definition. */
    update(workspaceId, id, changes) {
        const existing = this.require(workspaceId, id);
        const label = changes.label ?? existing.label;
        const command = changes.command ?? existing.command;
        const enabled = changes.enabled === undefined ? existing.enabled : changes.enabled ? 1 : 0;
        this.db.run('UPDATE verification_definitions SET label = ?, command = ?, enabled = ? WHERE workspace_id = ? AND id = ?', [label, command, enabled, workspaceId, id]);
        return this.require(workspaceId, id);
    }
    /** Removes one definition. Past results keep their own copy of the command. */
    remove(workspaceId, id) {
        this.require(workspaceId, id);
        this.db.run('DELETE FROM verification_definitions WHERE workspace_id = ? AND id = ?', [
            workspaceId,
            id,
        ]);
        return true;
    }
    require(workspaceId, id) {
        const found = this.find(workspaceId, id);
        if (!found)
            throw new RecordNotFoundError('verification_definition', id);
        return found;
    }
    /** Resolves requested ids to commands, reporting the ones that do not exist. */
    resolve(workspaceId, ids) {
        const known = new Map(this.list(workspaceId).map((row) => [row.id, row.command]));
        const commands = [];
        const unknown = [];
        for (const id of ids) {
            const command = known.get(id);
            if (command === undefined)
                unknown.push(id);
            else
                commands.push(command);
        }
        return { commands, unknown };
    }
}
export class RecordNotFoundError extends Error {
    entity;
    entityId;
    code = 'NOT_FOUND';
    constructor(entity, entityId) {
        super(`No ${entity} with id ${entityId}`);
        this.entity = entity;
        this.entityId = entityId;
        this.name = 'RecordNotFoundError';
    }
}
export class CloudWorkspaceRepository extends Repository {
    create(input) {
        const timestamp = now();
        this.db.run(`INSERT INTO cloud_workspaces
         (id, workspace_id, session_id, provisioner, handle, repository, branch, working_dir,
          status, status_detail, created_at, updated_at, expires_at, released_at)
       VALUES (?,?,?,?,NULL,?,?,?,'provisioning',NULL,?,?,?,NULL)`, [
            input.id,
            input.workspaceId,
            input.sessionId ?? null,
            input.provisioner,
            input.repository,
            input.branch,
            input.workingDir,
            timestamp,
            timestamp,
            input.ttlMs ? new Date(Date.now() + input.ttlMs).toISOString() : null,
        ]);
        return this.require(input.id);
    }
    find(id) {
        return this.db.get('SELECT * FROM cloud_workspaces WHERE id = ?', [id]);
    }
    require(id) {
        const row = this.find(id);
        if (!row)
            throw new RecordNotFoundError('cloud workspace', id);
        return row;
    }
    /** The workspaces of one project, newest first. */
    list(workspaceId) {
        return this.db.all('SELECT * FROM cloud_workspaces WHERE workspace_id = ? ORDER BY updated_at DESC', [workspaceId]);
    }
    /**
     * The live workspace of one session, if it still has one.
     *
     * Sessions get their own: two conversations in the same project must not
     * write over each other's uncommitted work.
     */
    findLiveForSession(sessionId) {
        return this.db.get(`SELECT * FROM cloud_workspaces
        WHERE session_id = ? AND status IN ('provisioning','ready')
        ORDER BY updated_at DESC LIMIT 1`, [sessionId]);
    }
    setHandle(id, handle) {
        this.db.run('UPDATE cloud_workspaces SET handle = ?, updated_at = ? WHERE id = ?', [
            handle,
            now(),
            id,
        ]);
    }
    setStatus(id, status, detail) {
        this.db.run(`UPDATE cloud_workspaces
          SET status = ?, status_detail = ?, updated_at = ?,
              released_at = CASE WHEN ? = 'released' THEN ? ELSE released_at END
        WHERE id = ?`, [status, detail ?? null, now(), status, now(), id]);
    }
    /**
     * Workspaces the reaper may reclaim: past their expiry, or left behind by a
     * process that ended. Cleanup is the coordinator's job precisely because the
     * desktop may be closed when the time comes.
     */
    listReclaimable(nowIso = now()) {
        return this.db.all(`SELECT * FROM cloud_workspaces
        WHERE status IN ('provisioning','ready')
          AND expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC`, [nowIso]);
    }
    /** Everything still holding resources, whatever its session. */
    listLive() {
        return this.db.all("SELECT * FROM cloud_workspaces WHERE status IN ('provisioning','ready') ORDER BY created_at ASC");
    }
}
//# sourceMappingURL=repositories.js.map