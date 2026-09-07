/**
 * Runtime management types.
 *
 * The product promise is that the user never installs anything by hand: no
 * Node, no npm, no PATH surgery, no terminal. That means the application owns
 * the agent runtimes itself, and every adapter asks this layer for an absolute
 * executable path rather than hoping the global PATH has one.
 */
export const CONTRACT_LABELS = {
    DOCUMENTED: 'DOCUMENTED',
    PACKAGE_INTERNAL: 'PACKAGE INTERNAL',
    NOT_PUBLIC_CONTRACT: 'IMPLEMENTATION DETAIL / NOT PUBLIC CONTRACT',
};
/**
 * Raised when something the user might act on goes wrong.
 *
 * `userMessage` is what the interface shows; `detail` is for the developer
 * view. The interface must never surface "codex not found in PATH".
 */
export class RuntimeError extends Error {
    runtimeId;
    userMessage;
    remedy;
    detail;
    constructor(runtimeId, userMessage, remedy, detail) {
        super(`${runtimeId}: ${userMessage}${detail ? ` (${detail})` : ''}`);
        this.runtimeId = runtimeId;
        this.userMessage = userMessage;
        this.remedy = remedy;
        this.detail = detail;
        this.name = 'RuntimeError';
    }
}
/**
 * Raised when the only executable available is outside the compatibility
 * window - an old build on the PATH, or a managed install the policy has
 * since moved past. The application installs the tested version instead of
 * running it.
 */
export class RuntimeIncompatibleError extends RuntimeError {
    constructor(runtimeId, displayName, version, reason) {
        super(runtimeId, `${displayName} ${version} não é compatível com esta versão do aplicativo. ${reason}`, 'Atualizar automaticamente', `version ${version} is outside the compatibility window`);
        this.name = 'RuntimeIncompatibleError';
    }
}
/** Raised when an adapter asks for an executable that is not installed yet. */
export class RuntimeNotReadyError extends RuntimeError {
    constructor(runtimeId, displayName) {
        super(runtimeId, `${displayName} ainda não está configurado.`, 'Configurar automaticamente', 'no managed install and no compatible system installation was found');
        this.name = 'RuntimeNotReadyError';
    }
}
/**
 * Raised when the user cancelled an installation.
 *
 * Distinct from a failure on purpose: the interface says "Cancelado", not
 * "Não foi possível configurar", and offers the action again rather than
 * apologising for something that went wrong.
 */
export class RuntimeInstallCancelledError extends RuntimeError {
    constructor(runtimeId) {
        super(runtimeId, 'Instalação cancelada.', 'Configurar automaticamente', 'cancelled by the user');
        this.name = 'RuntimeInstallCancelledError';
    }
}
//# sourceMappingURL=types.js.map