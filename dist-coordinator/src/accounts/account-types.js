/**
 * Provider accounts.
 *
 * The user types a friendly name - "Claude Trabalho" - and nothing else. The
 * application owns the configuration directory behind it and never shows the
 * string CLAUDE_CONFIG_DIR anywhere in the interface.
 */
export class AccountError extends Error {
    accountId;
    userMessage;
    remedy;
    detail;
    constructor(accountId, userMessage, remedy, detail) {
        super(`${accountId}: ${userMessage}${detail ? ` (${detail})` : ''}`);
        this.accountId = accountId;
        this.userMessage = userMessage;
        this.remedy = remedy;
        this.detail = detail;
        this.name = 'AccountError';
    }
}
//# sourceMappingURL=account-types.js.map