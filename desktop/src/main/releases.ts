/**
 * Which published release of this app is newer than the one running. Pure, for
 * the tests.
 *
 * The app is released from the Polaris repository under `desktop-v<version>`
 * tags (`.github/workflows/desktop.yml`), beside the dashboard's own releases
 * and never marked as the repository's latest one. So the answer is read from
 * the list of releases: the highest published `desktop-v` version.
 */

import { z } from "zod";

export const TAG_PREFIX = "desktop-v";

const releasesSchema = z.array(
    z.object({
        tag_name: z.string(),
        draft: z.boolean(),
        prerelease: z.boolean()
    })
);

type Version = readonly [number, number, number];

/** `1.2.3` as numbers; null for anything else, a pre-release included. */
export function parseVersion(text: string): Version | null {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Where the app's releases are listed and shown, from package.json's
 *  `repository`. Null when that is not a GitHub repository. */
export function releaseSource(repository: string): { readonly api: string; readonly page: (tag: string) => string; } | null {
    const match = /^(?:git\+)?https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repository);
    if (!match) return null;
    const [, owner, repo] = match;
    return {
        api: `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
        page: (tag) => `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`
    };
}

export interface Release {
    readonly version: string;
    readonly tag: string;
}

/** The newest published release in the list that is newer than `current`, or
 *  null when there is none or the list is not one. */
export function newerRelease(body: unknown, current: string): Release | null {
    const running = parseVersion(current);
    const releases = releasesSchema.safeParse(body);
    if (!running || !releases.success) return null;
    let newest: { release: Release; version: Version; } | null = null;
    for (const release of releases.data) {
        if (release.draft || release.prerelease || !release.tag_name.startsWith(TAG_PREFIX)) continue;
        const text = release.tag_name.slice(TAG_PREFIX.length);
        const version = parseVersion(text);
        if (!version || compare(version, running) <= 0) continue;
        if (!newest || compare(version, newest.version) > 0) newest = { release: { version: text, tag: release.tag_name }, version };
    }
    return newest?.release ?? null;
}
