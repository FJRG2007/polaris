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
        prerelease: z.boolean(),
        assets: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative() })).default([])
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
export function releaseSource(
    repository: string
): { readonly api: string; readonly page: (tag: string) => string; readonly download: (tag: string) => string; } | null {
    const match = /^(?:git\+)?https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repository);
    if (!match) return null;
    const [, owner, repo] = match;
    return {
        api: `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
        page: (tag) => `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`,
        /** Where a release's files are, as the folder Squirrel reads `RELEASES`
         *  and the package from. */
        download: (tag) => `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}`
    };
}

/** A file attached to a release, as the release list names and sizes it. */
export interface Asset {
    readonly name: string;
    readonly size: number;
}

export interface Release {
    readonly version: string;
    readonly tag: string;
    readonly assets: readonly Asset[];
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
        if (!newest || compare(version, newest.version) > 0) newest = { release: { version: text, tag: release.tag_name, assets: release.assets }, version };
    }
    return newest?.release ?? null;
}

/** The checksums file the release job attaches beside the installers. */
export const CHECKSUMS = "SHA256SUMS";

/** The update feed the release job writes for a macOS architecture, read by
 *  Squirrel.Mac as a `json` server. Named the same in build/release-files.cjs. */
export function macFeedName(arch: string): string {
    return `RELEASES-darwin-${arch}.json`;
}

/** `sha256sum` output as file name to lowercase digest. Lines that are not one
 *  are skipped; a name listed twice keeps neither, since it is not known which
 *  one is right. */
export function parseChecksums(text: string): Map<string, string> {
    const sums = new Map<string, string>();
    const repeated = new Set<string>();
    for (const line of text.split("\n")) {
        const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
        if (!match) continue;
        const [, digest, name] = match;
        if (!digest || !name) continue;
        if (sums.has(name)) repeated.add(name);
        sums.set(name, digest.toLowerCase());
    }
    for (const name of repeated) sums.delete(name);
    return sums;
}

const ARCH_NAMES: Readonly<Record<string, readonly string[]>> = {
    x64: ["x64", "x86_64", "amd64"],
    arm64: ["arm64", "aarch64"]
};

/** The release's AppImage for this architecture, or null when it has none or
 *  more than one could be meant. */
export function appImageAsset(assets: readonly Asset[], arch: string): Asset | null {
    const names = ARCH_NAMES[arch];
    if (!names) return null;
    const matching = assets.filter(
        (asset) =>
            asset.name.endsWith(".AppImage") &&
            asset.size > 0 &&
            names.some((name) => asset.name.slice(0, -".AppImage".length).split(/[-.]/).includes(name))
    );
    return matching.length === 1 ? (matching[0] ?? null) : null;
}
