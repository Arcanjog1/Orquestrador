/**
 * Runtime version compatibility policy.
 *
 * Installing whatever the source calls "latest" would let an agent CLI change
 * under the application without a single line of our code changing with it. So
 * the project records the version it has actually been tested against, and the
 * manager distinguishes four different things:
 *
 *   AVAILABLE   what a source is currently offering
 *   TESTED      what this project has verified against
 *   INSTALLED   what is on disk right now
 *   COMPATIBLE  whether an available version satisfies the policy
 *
 * A first install prefers the tested version. Later updates are allowed only
 * inside the policy, and only after the new build has proved itself in staging.
 */
import { compareVersions, gte, lte, parseVersion } from './version.js';
/**
 * The versions this project has been tested against.
 *
 * `testedVersion` is deliberately a fact about *this repository*, not a guess
 * about what is newest. It is updated when someone verifies a newer build.
 */
export const RUNTIME_COMPATIBILITY = {
    codex: {
        runtimeId: 'codex',
        // 0.153.4 is the `latest` dist-tag of @openai/codex (published 2026-09-04)
        // and the rust-v0.153.4 GitHub release; verified with the official
        // SHA-256 manifest and driven end to end by scripts/probe-codex-catalog.mjs.
        testedVersion: '0.153.4',
        // Releases before 0.145 deserialise the model catalogue with a closed
        // reasoning-effort enum; the backend now serves `max` and `ultra`, which
        // such a build refuses ("unknown variant `max`") and then cannot run.
        // 0.150 is the first line this project exercised; nothing older is used,
        // not even one found on the PATH.
        minVersion: '0.150.0',
        updatePolicy: 'compatible',
        note: 'Codex is driven through its non-interactive exec mode. A new major or minor line ' +
            'may change that surface, so updates stay inside the window until re-tested.',
    },
    'claude-code': {
        runtimeId: 'claude-code',
        testedVersion: '2.1.252',
        minVersion: '2.0.0',
        updatePolicy: 'compatible',
        note: 'Verified against 2.1.252: `-p --output-format json`, `--permission-mode`, ' +
            '`auth status --json` and CLAUDE_CONFIG_DIR isolation.',
    },
    git: {
        runtimeId: 'git',
        testedVersion: '2.47.0',
        minVersion: '2.30.0',
        updatePolicy: 'compatible',
        note: 'Only plumbing and read-only porcelain are used, which is stable across these versions.',
    },
};
export function compatibilityFor(runtimeId) {
    return RUNTIME_COMPATIBILITY[runtimeId];
}
/** Decides whether an available version may be installed. */
export function evaluateCompatibility(policy, availableVersion) {
    if (!parseVersion(availableVersion)) {
        return {
            verdict: 'unparseable',
            compatible: false,
            reason: `A versão "${availableVersion}" não pôde ser interpretada.`,
        };
    }
    if (policy.updatePolicy === 'latest') {
        return { verdict: 'compatible', compatible: true, reason: 'Política: sempre a mais recente.' };
    }
    if (policy.updatePolicy === 'pinned') {
        const same = compareVersions(availableVersion, policy.testedVersion) === 0;
        return same
            ? { verdict: 'compatible', compatible: true, reason: 'Versão testada.' }
            : {
                verdict: 'not-tested-policy-pinned',
                compatible: false,
                reason: `A versão testada é ${policy.testedVersion}; atualizações automáticas estão desativadas.`,
            };
    }
    if (policy.minVersion && !gte(availableVersion, policy.minVersion)) {
        return {
            verdict: 'below-minimum',
            compatible: false,
            reason: `A versão ${availableVersion} é anterior à mínima suportada (${policy.minVersion}).`,
        };
    }
    if (policy.maxVersion && !lte(availableVersion, policy.maxVersion)) {
        return {
            verdict: 'above-maximum',
            compatible: false,
            reason: `A versão ${availableVersion} é posterior à máxima testada (${policy.maxVersion}).`,
        };
    }
    return { verdict: 'compatible', compatible: true, reason: 'Dentro da faixa compatível.' };
}
/** A first install prefers the tested version; nothing else does by default. */
export function firstInstallRequest(policy) {
    return { kind: 'tested', version: policy.testedVersion };
}
//# sourceMappingURL=compatibility.js.map