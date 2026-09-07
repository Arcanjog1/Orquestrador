/**
 * The verifications a project owner has approved.
 *
 * This service exists so a person can configure, in the interface, the same
 * `verification_definitions` the orchestration loop already resolves. It adds
 * no execution path of its own: it writes rows, and the loop keeps reading them
 * exactly as it did when the only way to add one was a script.
 *
 *   interface → verification_definitions → verifications.resolve(id)
 *             → Verifier → verification_results → buildFeedback → DONE gate
 *
 * Two rules make that safe to expose:
 *
 *  1. **A definition is configuration, written by a person, before the run.**
 *     An agent never reaches this service. The orchestrator names a
 *     verification by id; the id is looked up here and the *stored* command
 *     runs. Text from Codex or Claude is never executed, and an id that is not
 *     registered (or is disabled) is reported as unknown, never guessed at.
 *  2. **The command is screened by the same rule the Verifier uses.**
 *     `screenCommand` refuses shell operators and destructive git before a
 *     command is ever saved, so a definition that could not run safely cannot
 *     be stored in the first place. The Verifier screens it again at run time -
 *     saving is a convenience for the person, never the security boundary.
 */
import { screenCommand } from '../core.js';
export class VerificationError extends Error {
    code = 'VERIFICATION_ERROR';
    constructor(message) {
        super(message);
        this.name = 'VerificationError';
    }
}
export class VerificationService {
    database;
    constructor(database) {
        this.database = database;
    }
    /** Every definition of one workspace, disabled ones included. */
    list(workspaceId) {
        this.database.workspaces.require(workspaceId);
        return this.database.verifications.listAll(workspaceId).map(toView);
    }
    create(input) {
        this.database.workspaces.require(input.workspaceId);
        const command = this.screen(input.command);
        const label = requireLabel(input.label);
        if (this.database.verifications.find(input.workspaceId, input.id)) {
            throw new VerificationError(`Já existe uma verificação com o id "${input.id}" neste projeto.`);
        }
        return toView(this.database.verifications.create({
            id: input.id,
            workspaceId: input.workspaceId,
            label,
            command,
        }));
    }
    /**
     * Changes one definition. Every field is optional, so the interface can send
     * a rename, a new command or just the enabled switch without resending the
     * rest and risking a stale overwrite.
     */
    update(input) {
        this.database.workspaces.require(input.workspaceId);
        // Scoped by workspace: an id belonging to another project is not found
        // here, so one project can never edit another's verification.
        this.database.verifications.require(input.workspaceId, input.id);
        const changes = {};
        if (input.label !== undefined)
            changes.label = requireLabel(input.label);
        if (input.command !== undefined)
            changes.command = this.screen(input.command);
        if (input.enabled !== undefined)
            changes.enabled = input.enabled;
        if (Object.keys(changes).length === 0) {
            throw new VerificationError('Nada para alterar nesta verificação.');
        }
        return toView(this.database.verifications.update(input.workspaceId, input.id, changes));
    }
    remove(input) {
        this.database.workspaces.require(input.workspaceId);
        return this.database.verifications.remove(input.workspaceId, input.id);
    }
    /**
     * The Verifier's own screen, applied while saving.
     *
     * Refusing here means the person is told what is wrong while they are typing
     * it, instead of a run failing later on a command that was never runnable.
     */
    screen(command) {
        const trimmed = command.trim();
        if (trimmed.length === 0)
            throw new VerificationError('Escreva o comando da verificação.');
        const screen = screenCommand(trimmed);
        if (!screen.safe) {
            throw new VerificationError(screen.reason ?? 'Este comando não é permitido.');
        }
        return trimmed;
    }
}
function requireLabel(label) {
    const trimmed = label.trim();
    if (trimmed.length === 0)
        throw new VerificationError('Escreva um nome para a verificação.');
    return trimmed;
}
function toView(record) {
    return {
        id: record.id,
        workspaceId: record.workspace_id,
        label: record.label,
        command: record.command,
        enabled: record.enabled === 1,
        createdAt: record.created_at,
    };
}
//# sourceMappingURL=verification-service.js.map