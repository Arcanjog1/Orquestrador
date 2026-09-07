/**
 * Claude accounts, driven entirely from the interface.
 *
 * The user types a name. Everything else — the profile directory, the value of
 * CLAUDE_CONFIG_DIR, the auth subprocess, the sign-in URL — is the
 * application's business and never appears in the interface.
 *
 * `openUrl` is injected rather than imported so this service stays free of
 * Electron: the shell passes `shell.openExternal`, a test passes a spy.
 */
import { newId } from '../core.js';
const STAGE_LABELS = {
    starting: 'Preparando a conexão...',
    'awaiting-browser': 'Abrindo o navegador para você entrar...',
    'waiting-for-completion': 'Aguardando você concluir no navegador...',
    connected: 'Conta conectada.',
    failed: 'Não foi possível conectar.',
    cancelled: 'Conexão cancelada.',
};
export class AccountService {
    database;
    managers;
    events;
    openUrl;
    connecting = new Map();
    constructor(database, managers, events, openUrl) {
        this.database = database;
        this.managers = managers;
        this.events = events;
        this.openUrl = openUrl;
    }
    /** The manager that owns an account, chosen by its provider. */
    managerFor(provider) {
        const manager = this.managers[provider];
        if (!manager)
            throw new Error(`No account manager for provider ${provider}`);
        return manager;
    }
    managerForAccount(accountId) {
        return this.managerFor(this.database.accounts.require(accountId).provider_id);
    }
    list() {
        return this.database.accounts.list().map((row) => ({
            id: row.id,
            name: row.display_name,
            provider: row.provider_id,
            state: row.auth_state,
            detail: detailFor(row.auth_state),
        }));
    }
    /** Creates the account and the directory it owns, in that order. */
    create(name, provider = 'anthropic') {
        const id = newId('acc');
        const manager = this.managerFor(provider);
        const account = {
            id,
            providerId: provider,
            displayName: name,
            createdAt: new Date().toISOString(),
        };
        manager.createAccount(account);
        const record = this.database.accounts.create({
            id,
            providerId: provider,
            displayName: name,
            profileDirectory: manager.profileDirectory(id),
        });
        return {
            id: record.id,
            name: record.display_name,
            provider: record.provider_id,
            state: 'disconnected',
            detail: detailFor('disconnected'),
        };
    }
    /**
     * Runs the sign-in. Resolves when the CLI reports a usable credential, or
     * when it gives up; either way the account row is updated so a restart shows
     * the truth rather than an optimistic "connected".
     */
    async connect(accountId) {
        const record = this.database.accounts.require(accountId);
        if (this.connecting.has(accountId)) {
            return this.viewOf(accountId, record.auth_state, 'Conexão já em andamento.');
        }
        const controller = new AbortController();
        this.connecting.set(accountId, controller);
        const account = {
            id: record.id,
            providerId: record.provider_id,
            displayName: record.display_name,
            createdAt: record.created_at,
        };
        try {
            const status = await this.managerForAccount(accountId).connect(account, {
                signal: controller.signal,
                openUrl: this.openUrl,
                onProgress: (progress) => {
                    this.events.emit('account:progress', {
                        accountId,
                        stage: progress.phase,
                        label: STAGE_LABELS[progress.phase] ?? progress.message,
                        ...(progress.url ? { url: progress.url } : {}),
                        ...(progress.code ? { code: progress.code } : {}),
                    });
                },
            });
            this.database.accounts.updateAuth(accountId, status.state, status.authMethod ?? null);
            return this.viewOf(accountId, status.state, status.problem);
        }
        catch (error) {
            const message = userMessageFor(error);
            this.events.emit('account:progress', {
                accountId,
                stage: 'failed',
                label: message,
            });
            this.database.accounts.updateAuth(accountId, 'disconnected', null);
            return this.viewOf(accountId, 'disconnected', message);
        }
        finally {
            this.connecting.delete(accountId);
        }
    }
    cancelConnect(accountId) {
        const controller = this.connecting.get(accountId);
        if (!controller)
            return false;
        controller.abort();
        return true;
    }
    /** Asks the CLI, rather than trusting the stored row. */
    async status(accountId) {
        const record = this.database.accounts.require(accountId);
        const status = await this.managerForAccount(accountId).getStatus({
            id: record.id,
            providerId: record.provider_id,
            displayName: record.display_name,
            createdAt: record.created_at,
        });
        this.database.accounts.updateAuth(accountId, status.state, status.authMethod ?? null);
        return this.viewOf(accountId, status.state, status.problem);
    }
    remove(accountId) {
        const manager = this.managerForAccount(accountId);
        manager.removeAccount(accountId);
        return this.database.accounts.remove(accountId);
    }
    viewOf(accountId, state, detail) {
        const record = this.database.accounts.require(accountId);
        return {
            id: record.id,
            name: record.display_name,
            provider: record.provider_id,
            state,
            detail: detail ?? detailFor(state),
        };
    }
}
function detailFor(state) {
    switch (state) {
        case 'connected':
            return 'Conta conectada.';
        case 'ambient-credential':
            return 'Entrou com uma credencial que não é desta conta. Conecte novamente para isolá-la.';
        case 'runtime-missing':
            return 'O runtime desta conta ainda não está configurado.';
        default:
            return 'Não conectada.';
    }
}
function userMessageFor(error) {
    if (error && typeof error === 'object' && 'userMessage' in error) {
        const message = error.userMessage;
        if (typeof message === 'string' && message.length > 0)
            return message;
    }
    return 'Não foi possível conectar a conta.';
}
//# sourceMappingURL=account-service.js.map