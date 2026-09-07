/**
 * The reaper.
 *
 * Cloud compute bills by the second, and the two ways it runs away are the two
 * this closes: a workspace whose run ended without its release being reached,
 * and a workspace whose run is still "going" long after anyone stopped caring.
 *
 * It runs in the coordinator rather than in the desktop for the same reason
 * everything else does - the desktop may be closed, and that is exactly when a
 * forgotten container costs the most.
 */
export class Reaper {
    options;
    timer = null;
    constructor(options) {
        this.options = options;
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            void this.sweep().catch(() => { });
        }, this.options.intervalMs ?? 60_000);
        // Never a reason on its own for the process to stay alive.
        this.timer.unref?.();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    /**
     * One pass. Returns what it reclaimed, so a deployment can watch the number
     * rather than trust the mechanism.
     */
    async sweep() {
        const nowIso = (this.options.now?.() ?? new Date()).toISOString();
        const result = { expired: [], orphaned: [] };
        // 1. Past its ceiling. The ceiling is the point: a run that will not end
        //    on its own is stopped by the clock rather than by a bill.
        for (const workspace of this.options.database.cloudWorkspaces.listReclaimable(nowIso)) {
            await this.reclaim(workspace.id, workspace.handle, 'expirou o tempo máximo');
            result.expired.push(workspace.id);
        }
        // 2. Still holding resources for a run that has finished. This is what a
        //    crash between "the run ended" and "the workspace was released"
        //    leaves behind, and nothing else would ever clear it.
        for (const workspace of this.options.database.cloudWorkspaces.listLive()) {
            const run = this.options.database.driver.get('SELECT status FROM remote_runs WHERE cloud_workspace_id = ?', [workspace.id]);
            if (!run)
                continue;
            if (!['DONE', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN'].includes(run.status))
                continue;
            await this.reclaim(workspace.id, workspace.handle, `a execução terminou em ${run.status}`);
            result.orphaned.push(workspace.id);
        }
        return result;
    }
    async reclaim(id, handle, why) {
        // By handle, with no live object: the process that made it is gone, which
        // is the whole situation the reaper exists for.
        if (handle)
            await this.options.provisioner.reclaim(handle).catch(() => { });
        this.options.database.cloudWorkspaces.setStatus(id, 'released', why);
    }
}
//# sourceMappingURL=reaper.js.map