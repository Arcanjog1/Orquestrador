/**
 * The workspace provisioner port.
 *
 * A remote run needs one thing that a local run gets for free: somewhere
 * isolated, with the repository in it, that can start processes. This is the
 * seam where that comes from, and it is a port on purpose - the coordinator,
 * the loop and the interface must not know whether the isolation underneath is
 * a container on a host we run, or a machine from a service we pay for.
 *
 * Everything above this line can therefore be written, tested and shipped
 * before the account that pays for the second one exists. That is the point.
 *
 * Two rules the port encodes rather than leaves to each implementation:
 *
 *  1. **A workspace is never handed a durable credential.** Repository access
 *     arrives as a short-lived token, fetched at clone time through
 *     `RepositoryAccess`, and it is never written into the remote URL - so it
 *     cannot end up in `.git/config`, in a log, or in anything a model reads.
 *  2. **A workspace belongs to exactly one session.** Two conversations in the
 *     same project get two workspaces; one can never overwrite the other's
 *     uncommitted work.
 */
/** A provisioner refused, and why - so the interface can say something useful. */
export class ProvisioningError extends Error {
    reason;
    detail;
    userMessage;
    constructor(reason, userMessage, detail = null) {
        super(detail ? `${userMessage} (${detail})` : userMessage);
        this.reason = reason;
        this.detail = detail;
        this.name = 'ProvisioningError';
        this.userMessage = detail ? `${userMessage} Detalhe: ${detail}.` : userMessage;
    }
}
/** Ceilings that keep a forgotten run from becoming a bill. */
export const DEFAULT_LIMITS = {
    cpus: 2,
    memoryMb: 4096,
    diskMb: 20480,
    maxLifetimeMs: 4 * 60 * 60_000,
    idleTimeoutMs: 30 * 60_000,
    allowedHosts: [
        'github.com',
        'api.github.com',
        'codeload.github.com',
        'api.openai.com',
        'chatgpt.com',
        'api.anthropic.com',
        'registry.npmjs.org',
    ],
};
//# sourceMappingURL=provisioner.js.map