/**
 * The durable run store.
 *
 * Everything the coordinator knows lives here, not in a process's memory,
 * because the promise this product makes is that a run survives the computer
 * being switched off - and that includes the coordinator's own restart.
 *
 * Three mechanisms carry that promise:
 *
 *  - **the event log**: every event a connected desktop would have seen is
 *    written with a per-run sequence number before it is delivered, so a
 *    desktop that was closed asks for everything after the last sequence it
 *    applied. Catching up is exact rather than a replay;
 *  - **idempotency keys**: a client that timed out and retried gets the run it
 *    already has, not a second one;
 *  - **leases**: exactly one worker drives a run at a time, and a lease that
 *    stops being renewed is how a run whose owner died is picked up rather
 *    than stranded.
 */
import { createHash, randomUUID } from 'node:crypto';
/** Terminal states. A run in one of these is never resumed. */
export const TERMINAL = new Set(['DONE', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN']);
/** Tokens are stored hashed: a stolen database yields nothing usable. */
export function hashToken(token) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}
export class RunStore {
    database;
    constructor(database) {
        this.database = database;
    }
    get db() {
        return this.database.driver;
    }
    // -- principals and sessions ---------------------------------------------
    createPrincipal(input) {
        const id = `pr_${randomUUID()}`;
        this.db.run('INSERT INTO principals (id, display_name, tenant_id, status, created_at) VALUES (?,?,?,?,?)', [id, input.displayName, input.tenantId ?? id, 'active', new Date().toISOString()]);
        return this.db.get('SELECT * FROM principals WHERE id = ?', [id]);
    }
    /**
     * Issues a desktop session token.
     *
     * The token is returned once and never stored: only its hash is kept, so it
     * cannot be read back out of the database by anyone, ourselves included.
     */
    issueSession(input) {
        const id = `ds_${randomUUID()}`;
        const token = `orq_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
        const expiresAt = input.ttlMs ? new Date(Date.now() + input.ttlMs).toISOString() : null;
        this.db.run(`INSERT INTO desktop_sessions (id, principal_id, token_hash, label, created_at, last_seen_at, expires_at, revoked_at)
       VALUES (?,?,?,?,?,NULL,?,NULL)`, [id, input.principalId, hashToken(token), input.label ?? null, new Date().toISOString(), expiresAt]);
        return { id, token, expiresAt };
    }
    /**
     * The principal a token acts as, or null.
     *
     * This is the *only* way a request gets an identity. Nothing a client sends
     * in a body - an accountId, a tenant, a principal id - is ever treated as
     * authorisation; it is at most a hint that must match what the token says.
     */
    authenticate(token) {
        if (!token)
            return null;
        const session = this.db.get('SELECT id, principal_id, expires_at, revoked_at FROM desktop_sessions WHERE token_hash = ?', [hashToken(token)]);
        if (!session || session.revoked_at)
            return null;
        if (session.expires_at && session.expires_at <= new Date().toISOString())
            return null;
        const principal = this.db.get("SELECT * FROM principals WHERE id = ? AND status = 'active'", [session.principal_id]);
        if (!principal)
            return null;
        this.db.run('UPDATE desktop_sessions SET last_seen_at = ? WHERE id = ?', [
            new Date().toISOString(),
            session.id,
        ]);
        return principal;
    }
    revokeSession(id) {
        this.db.run('UPDATE desktop_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
            new Date().toISOString(),
            id,
        ]);
    }
    // -- runs -----------------------------------------------------------------
    /**
     * Creates a run, or returns the one this idempotency key already made.
     *
     * `created` says which happened, so a caller can tell "your run is starting"
     * from "your run was already started" without guessing from timestamps.
     */
    createRun(input) {
        return this.database.transaction(() => {
            if (input.idempotencyKey) {
                const existing = this.db.get('SELECT result_id FROM idempotency_keys WHERE principal_id = ? AND scope = ? AND key = ?', [input.principal.id, 'run.create', input.idempotencyKey]);
                if (existing) {
                    const run = this.findRun(existing.result_id, input.principal);
                    if (run)
                        return { run, created: false };
                }
            }
            const id = `rr_${randomUUID()}`;
            const timestamp = new Date().toISOString();
            this.db.run(`INSERT INTO remote_runs
           (id, principal_id, tenant_id, client_run_id, client_session_id, repository, branch,
            objective, status, failure_reason, cloud_workspace_id, team, created_at, updated_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,'QUEUED',NULL,NULL,?,?,?,NULL)`, [
                id,
                input.principal.id,
                input.principal.tenant_id,
                input.clientRunId ?? null,
                input.clientSessionId ?? null,
                input.repository,
                input.branch,
                input.objective,
                JSON.stringify(input.team ?? {}),
                timestamp,
                timestamp,
            ]);
            if (input.idempotencyKey) {
                this.db.run('INSERT INTO idempotency_keys (key, principal_id, scope, result_id, created_at) VALUES (?,?,?,?,?)', [input.idempotencyKey, input.principal.id, 'run.create', id, timestamp]);
            }
            const run = this.db.get('SELECT * FROM remote_runs WHERE id = ?', [id]);
            this.append(id, 'run.created', {
                repository: input.repository,
                branch: input.branch,
                objective: input.objective,
            });
            return { run, created: true };
        });
    }
    /**
     * One run, **only** if this principal owns it.
     *
     * The ownership check is in the lookup rather than beside it on purpose: a
     * caller cannot forget to make it, because there is no way to ask for a run
     * without saying who is asking.
     */
    findRun(id, principal) {
        return (this.db.get('SELECT * FROM remote_runs WHERE id = ? AND principal_id = ?', [
            id,
            principal.id,
        ]) ?? null);
    }
    listRuns(principal, limit = 50) {
        return this.db.all('SELECT * FROM remote_runs WHERE principal_id = ? ORDER BY created_at DESC LIMIT ?', [principal.id, limit]);
    }
    /** Used by the coordinator itself, which acts for every principal. */
    requireRunUnscoped(id) {
        const run = this.db.get('SELECT * FROM remote_runs WHERE id = ?', [id]);
        if (!run)
            throw new Error(`no remote run ${id}`);
        return run;
    }
    setStatus(id, status, failureReason) {
        const timestamp = new Date().toISOString();
        this.db.run(`UPDATE remote_runs
          SET status = ?, failure_reason = ?, updated_at = ?,
              finished_at = CASE WHEN ? IN ('DONE','FAILED','CANCELLED','NEEDS_HUMAN') THEN ? ELSE finished_at END
        WHERE id = ?`, [status, failureReason ?? null, timestamp, status, timestamp, id]);
        this.append(id, 'run.status', { status, failureReason: failureReason ?? null });
    }
    setCloudWorkspace(id, cloudWorkspaceId) {
        this.db.run('UPDATE remote_runs SET cloud_workspace_id = ?, updated_at = ? WHERE id = ?', [
            cloudWorkspaceId,
            new Date().toISOString(),
            id,
        ]);
    }
    // -- the event log --------------------------------------------------------
    /**
     * Appends one event and returns its sequence number.
     *
     * The sequence is allocated from the log itself rather than a counter in
     * memory, so two coordinator processes cannot mint the same number and a
     * restart does not begin again at one.
     */
    append(runId, kind, payload) {
        return this.database.transaction(() => {
            const row = this.db.get('SELECT MAX(seq) AS next FROM remote_run_events WHERE run_id = ?', [runId]);
            const seq = (row?.next ?? 0) + 1;
            this.db.run('INSERT INTO remote_run_events (run_id, seq, kind, payload, created_at) VALUES (?,?,?,?,?)', [runId, seq, kind, JSON.stringify(payload ?? null), new Date().toISOString()]);
            return seq;
        });
    }
    /** Everything after `afterSeq`. Zero means from the beginning. */
    events(runId, afterSeq = 0, limit = 500) {
        return this.db
            .all('SELECT seq, kind, payload, created_at FROM remote_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', [runId, afterSeq, limit])
            .map((row) => ({
            seq: row.seq,
            kind: row.kind,
            payload: safeParse(row.payload),
            createdAt: row.created_at,
        }));
    }
    // -- leases ---------------------------------------------------------------
    /**
     * Takes the right to drive a run, if nobody live holds it.
     *
     * Two coordinator processes running the same loop would double every agent
     * invocation - and every commit. The lease is what makes that impossible
     * while still letting a run whose owner died be picked up.
     */
    acquireLease(runId, owner, ttlMs) {
        return this.database.transaction(() => {
            const nowIso = new Date().toISOString();
            const held = this.db.get('SELECT owner, expires_at FROM run_leases WHERE run_id = ?', [runId]);
            if (held && held.expires_at > nowIso && held.owner !== owner)
                return false;
            const expiresAt = new Date(Date.now() + ttlMs).toISOString();
            if (held) {
                this.db.run('UPDATE run_leases SET owner = ?, acquired_at = ?, expires_at = ? WHERE run_id = ?', [
                    owner,
                    nowIso,
                    expiresAt,
                    runId,
                ]);
            }
            else {
                this.db.run('INSERT INTO run_leases (run_id, owner, acquired_at, expires_at) VALUES (?,?,?,?)', [runId, owner, nowIso, expiresAt]);
            }
            return true;
        });
    }
    renewLease(runId, owner, ttlMs) {
        const result = this.db.run('UPDATE run_leases SET expires_at = ? WHERE run_id = ? AND owner = ?', [new Date(Date.now() + ttlMs).toISOString(), runId, owner]);
        return result.changes > 0;
    }
    releaseLease(runId, owner) {
        this.db.run('DELETE FROM run_leases WHERE run_id = ? AND owner = ?', [runId, owner]);
    }
    /**
     * Runs that are not finished and whose lease, if any, has lapsed.
     *
     * This is what a coordinator asks at start-up: work that was in flight when
     * something died, and that nobody is driving now.
     */
    listAbandoned() {
        return this.db.all(`SELECT r.* FROM remote_runs r
         LEFT JOIN run_leases l ON l.run_id = r.id
        WHERE r.status NOT IN ('DONE','FAILED','CANCELLED','NEEDS_HUMAN')
          AND (l.run_id IS NULL OR l.expires_at <= ?)
        ORDER BY r.created_at ASC`, [new Date().toISOString()]);
    }
}
function safeParse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
//# sourceMappingURL=store.js.map