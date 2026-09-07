/**
 * Version parsing and comparison.
 *
 * Written by hand rather than pulled from a dependency: the rules needed here
 * are small, and one of them is specific to this project - the platform builds
 * published for Codex carry a suffix (`0.153.0-win32-x64`) that strict semver
 * would read as a prerelease and therefore sort *before* `0.153.0`.
 */
const PLATFORM_SUFFIX = /-(?:win32|windows|darwin|macos|linux)-(?:x64|arm64|x86_64|aarch64|amd64)$/i;
export function parseVersion(raw) {
    const trimmed = raw.trim().replace(/^v/i, '');
    let platformSuffix = null;
    let core = trimmed;
    const suffixMatch = PLATFORM_SUFFIX.exec(trimmed);
    if (suffixMatch) {
        platformSuffix = suffixMatch[0].slice(1);
        core = trimmed.slice(0, suffixMatch.index);
    }
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?(?:\+[0-9A-Za-z.\-]+)?$/.exec(core);
    if (!match)
        return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ?? null,
        platformSuffix,
        raw,
    };
}
/** -1, 0 or 1. Unparseable versions sort last but compare stably. */
export function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left && !right)
        return a === b ? 0 : a < b ? -1 : 1;
    if (!left)
        return 1;
    if (!right)
        return -1;
    for (const key of ['major', 'minor', 'patch']) {
        if (left[key] !== right[key])
            return left[key] < right[key] ? -1 : 1;
    }
    // A release outranks a prerelease of the same core version.
    if (left.prerelease === null && right.prerelease !== null)
        return 1;
    if (left.prerelease !== null && right.prerelease === null)
        return -1;
    if (left.prerelease === null && right.prerelease === null)
        return 0;
    return comparePrerelease(left.prerelease, right.prerelease);
}
function comparePrerelease(a, b) {
    const leftParts = a.split('.');
    const rightParts = b.split('.');
    const length = Math.max(leftParts.length, rightParts.length);
    for (let i = 0; i < length; i += 1) {
        const left = leftParts[i];
        const right = rightParts[i];
        if (left === undefined)
            return -1;
        if (right === undefined)
            return 1;
        const leftNumeric = /^\d+$/.test(left);
        const rightNumeric = /^\d+$/.test(right);
        if (leftNumeric && rightNumeric) {
            const difference = Number(left) - Number(right);
            if (difference !== 0)
                return difference < 0 ? -1 : 1;
        }
        else if (leftNumeric !== rightNumeric) {
            // Numeric identifiers always have lower precedence than alphanumeric ones.
            return leftNumeric ? -1 : 1;
        }
        else if (left !== right) {
            return left < right ? -1 : 1;
        }
    }
    return 0;
}
/** True when `version` is the same release as `other`, ignoring platform tags. */
export function sameRelease(version, other) {
    return compareVersions(version, other) === 0;
}
export function gte(version, floor) {
    return compareVersions(version, floor) >= 0;
}
export function lte(version, ceiling) {
    return compareVersions(version, ceiling) <= 0;
}
//# sourceMappingURL=version.js.map