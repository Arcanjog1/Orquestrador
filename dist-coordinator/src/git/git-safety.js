/**
 * Guard rails for anything the orchestrator is asked to execute (spec 33, 34).
 *
 * Two separate concerns live here:
 *
 *  - `screenCommand` vets the `verificationCommands` an orchestrator agent
 *    hands back. Commands that could destroy the user's work are refused and
 *    reported, never run.
 *  - `assertReadOnlyGitArgs` is the allowlist the evidence collector goes
 *    through, so evidence gathering physically cannot mutate the repository.
 */
/** Git subcommands the evidence collector is permitted to run. */
export const READ_ONLY_GIT_SUBCOMMANDS = [
    'status',
    'diff',
    'rev-parse',
    'branch',
    'log',
    'show',
    'ls-files',
    'rev-list',
    'config',
    'symbolic-ref',
];
export class UnsafeGitCommandError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnsafeGitCommandError';
    }
}
/**
 * Throws unless `args` is a read-only git invocation.
 *
 * `branch` is only read-only without a mutating flag, so it is checked
 * specifically rather than trusted by name alone.
 */
export function assertReadOnlyGitArgs(args) {
    const subcommand = args.find((a) => !a.startsWith('-'));
    if (!subcommand)
        throw new UnsafeGitCommandError('Refusing to run git with no subcommand.');
    if (!READ_ONLY_GIT_SUBCOMMANDS.includes(subcommand)) {
        throw new UnsafeGitCommandError(`Refusing to run "git ${subcommand}": evidence collection is limited to read-only commands.`);
    }
    if (subcommand === 'branch') {
        const mutating = args.some((a) => ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force'].includes(a));
        if (mutating)
            throw new UnsafeGitCommandError('Refusing to run a mutating "git branch" command.');
    }
    if (subcommand === 'config') {
        const writing = !args.includes('--get') && !args.includes('--list') && !args.includes('-l');
        if (writing)
            throw new UnsafeGitCommandError('Refusing to run a writing "git config" command.');
    }
}
/** Shell metacharacters the runner deliberately does not support. */
const SHELL_OPERATORS = ['&&', '||', '|', ';', '>', '<', '`', '$('];
/**
 * Vets a verification command line.
 *
 * Two classes of refusal:
 *
 *  1. Shell operators. Verification commands are tokenised and spawned
 *     directly - no shell is involved - so a pipeline would silently not mean
 *     what it says. Refusing is honest; the user can put it in a script.
 *  2. Destructive git and version-control operations (spec 33, 34). The MVP
 *     never commits, pushes, merges or discards work on its own.
 */
export function screenCommand(commandLine) {
    const trimmed = commandLine.trim();
    if (!trimmed)
        return { safe: false, reason: 'Empty command.' };
    for (const op of SHELL_OPERATORS) {
        if (trimmed.includes(op)) {
            return {
                safe: false,
                reason: `Contains the shell operator "${op}". Verification commands are run without a shell, ` +
                    'so put multi-step logic in a script (e.g. an npm script) and call that instead.',
            };
        }
    }
    let tokens;
    try {
        tokens = parseCommandLine(trimmed);
    }
    catch (err) {
        return { safe: false, reason: err.message };
    }
    if (tokens.length === 0)
        return { safe: false, reason: 'Empty command.' };
    const destructive = screenGitTokens(tokens);
    if (destructive)
        return { safe: false, reason: destructive };
    return { safe: true };
}
/** True when a token names the git executable, however it is spelled. */
function isGitToken(token) {
    const base = (token.split(/[\\/]/).pop() ?? token).toLowerCase();
    return base === 'git' || base === 'git.exe';
}
/**
 * Returns a refusal reason when the tokens describe a destructive operation.
 *
 * Every token is scanned for the git executable rather than only the first,
 * so an unquoted Windows path (`C:\Program Files\Git\bin\git.exe reset
 * --hard`, which tokenises into several pieces) or a prefix such as
 * `env FOO=1 git ...` cannot slip past the screen.
 */
function screenGitTokens(tokens) {
    const gitIndex = tokens.findIndex(isGitToken);
    if (gitIndex < 0)
        return null;
    const rest = tokens.slice(gitIndex + 1);
    const flags = rest.filter((t) => t.startsWith('-'));
    const positional = rest.filter((t) => !t.startsWith('-'));
    const subcommand = positional[0]?.toLowerCase();
    if (!subcommand)
        return null;
    const has = (...names) => names.some((n) => flags.includes(n));
    switch (subcommand) {
        case 'reset':
            if (has('--hard', '--merge')) {
                return 'git reset --hard would discard uncommitted work. Run it yourself if you really want it.';
            }
            return null;
        case 'clean':
            if (has('-n', '--dry-run'))
                return null;
            return 'git clean deletes untracked files. Run it yourself if you really want it.';
        case 'checkout':
        case 'switch':
            if (rest.includes('--') || has('-f', '--force', '--discard-changes')) {
                return `git ${subcommand} with -- or --force would overwrite working tree changes.`;
            }
            return null;
        case 'restore':
            if (flags.length === 1 && has('--staged'))
                return null;
            return 'git restore would overwrite working tree changes.';
        case 'branch':
            if (has('-D', '-d', '--delete'))
                return 'git branch --delete removes a branch.';
            return null;
        case 'push':
            return 'The MVP never pushes automatically (spec 34). Push yourself when you are ready.';
        case 'commit':
            return 'The MVP never commits automatically (spec 34). Review the diff and commit yourself.';
        case 'merge':
        case 'rebase':
            return `The MVP never runs git ${subcommand} automatically (spec 34).`;
        case 'stash':
            return 'git stash moves your working tree away. Run it yourself if you really want it.';
        case 'filter-branch':
            return 'git filter-branch rewrites history.';
        case 'update-ref':
            if (has('-d'))
                return 'git update-ref -d deletes a ref.';
            return null;
        case 'worktree':
            if (positional[1]?.toLowerCase() === 'remove')
                return 'git worktree remove deletes a worktree.';
            return null;
        default:
            return null;
    }
}
export class CommandParseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CommandParseError';
    }
}
/**
 * Splits a command line into argv, honouring single and double quotes.
 *
 * This is deliberately not a shell: no expansion, no operators, no escapes
 * beyond a backslash inside double quotes. `screenCommand` has already rejected
 * anything that would need more.
 */
export function parseCommandLine(line) {
    const tokens = [];
    let current = '';
    let quote = null;
    let started = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote === '"' && ch === '\\' && i + 1 < line.length) {
            const next = line[i + 1];
            if (next === '"' || next === '\\') {
                current += next;
                i += 1;
                continue;
            }
            current += ch;
            continue;
        }
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (started || current.length > 0) {
                tokens.push(current);
                current = '';
                started = false;
            }
            continue;
        }
        current += ch;
        started = true;
    }
    if (quote)
        throw new CommandParseError(`Unbalanced ${quote} quote in command: ${line}`);
    if (started || current.length > 0)
        tokens.push(current);
    return tokens;
}
//# sourceMappingURL=git-safety.js.map