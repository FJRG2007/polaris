/**
 * Comparing a server's version with the one a feature needs.
 *
 * Pure and dependency-free, so a screen can ask the same question the server
 * does without carrying anything else along.
 */

/** Whether a version is at least another. A snapshot is taken as recent; one
 *  that cannot be read at all as unknown, which is not at least anything. */
export function versionAtLeast(version: string | null, wanted: readonly number[]): boolean {
    if (version === null) return false;
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
    if (!match) return true;
    const have = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    for (let index = 0; index < wanted.length; index += 1) {
        const left = have[index] ?? 0;
        const right = wanted[index] ?? 0;
        if (left !== right) return left > right;
    }
    return true;
}
