/**
 * Which build of the GitHub Actions runner to put on a machine, and how to know
 * it arrived intact.
 *
 * The runner is a binary Polaris downloads onto somebody's server and then runs;
 * "curl it and hope" is not an acceptable way to install one. GitHub publishes the
 * SHA-256 of every asset inside the release notes, between markers, and that is the
 * only checksum for these tarballs that GitHub itself vouches for - there is no
 * separate checksums file. It is parsed here and verified on the machine before
 * anything is extracted, so a tampered mirror or a truncated download fails loudly
 * instead of becoming a running process.
 *
 * The container image is the same release, published by the same repository, so a
 * pool that runs jobs in containers and one that runs them on the machine are on
 * the same runner version and speak the same protocol to GitHub.
 */

import { githubApiToken } from "@/lib/github-service";

const API = "https://api.github.com";

/** The image actions/runner publishes for each release. Tagged with the bare
 *  version, so it always matches the tarball resolved alongside it. */
const RUNNER_IMAGE = "ghcr.io/actions/actions-runner";

/**
 * How long a resolved release is reused. The reconciler asks on every pass, and
 * runner releases are weeks apart; without this an idle install would spend a
 * GitHub API call a minute learning the same version.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Runner builds, named the way GitHub names the assets. */
export type RunnerPlatform =
    | "linux-x64"
    | "linux-arm64"
    | "linux-arm"
    | "osx-x64"
    | "osx-arm64";

export interface RunnerRelease {
    /** Bare version, e.g. "2.336.0". Also the container image tag. */
    readonly version: string;
    readonly platform: RunnerPlatform;
    readonly assetName: string;
    readonly downloadUrl: string;
    /** Lowercase hex, as published in the release notes. */
    readonly sha256: string;
    /** The equivalent container image, for pools that isolate jobs. */
    readonly image: string;
}

interface CachedRelease {
    readonly release: RunnerRelease;
    readonly at: number;
}

const cache = new Map<RunnerPlatform, CachedRelease>();

/**
 * Work out the runner build for a machine. `uname` answers are what arrive here,
 * and an unrecognised pair is refused rather than mapped to a plausible-looking
 * guess: installing an x64 runner on something else fails in a way that reads as a
 * Polaris bug rather than as an unsupported machine.
 */
export function runnerPlatform(platform: string, arch: string): RunnerPlatform | null {
    const cpu = arch.trim().toLowerCase();
    if (platform === "linux") {
        if (cpu === "x86_64" || cpu === "amd64") return "linux-x64";
        if (cpu === "aarch64" || cpu === "arm64") return "linux-arm64";
        if (cpu.startsWith("armv7") || cpu === "armhf") return "linux-arm";
        return null;
    }
    if (platform === "darwin") {
        if (cpu === "x86_64") return "osx-x64";
        if (cpu === "arm64") return "osx-arm64";
    }
    return null;
}

interface ReleasePayload {
    tag_name?: string;
    body?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
}

/**
 * The latest runner release for a platform, with its published checksum.
 *
 * Authenticated when a GitHub connection exists purely for the rate limit: this is
 * a public repository, and an install with no connection yet still needs to be able
 * to resolve it.
 */
export async function resolveRunnerRelease(platform: RunnerPlatform): Promise<RunnerRelease> {
    const cached = cache.get(platform);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.release;

    const token = await githubApiToken().catch(() => null);
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "polaris"
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API}/repos/actions/runner/releases/latest`, { headers, cache: "no-store" });
    if (!res.ok) throw new Error(`Could not read the runner release from GitHub (${res.status})`);
    const body = (await res.json()) as ReleasePayload;

    const release = parseRunnerRelease(body, platform);
    cache.set(platform, { release, at: Date.now() });
    return release;
}

/**
 * Pull the asset and its checksum out of a release payload. Split out from the
 * fetch so the parsing - which is the part that decides what gets executed on
 * somebody's server - is testable without a network.
 */
export function parseRunnerRelease(payload: ReleasePayload, platform: RunnerPlatform): RunnerRelease {
    const version = (payload.tag_name ?? "").trim().replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("GitHub returned no usable runner version");

    const assetName = `actions-runner-${platform}-${version}.tar.gz`;
    const asset = (payload.assets ?? []).find((entry) => entry.name === assetName);
    if (!asset?.browser_download_url) throw new Error(`GitHub publishes no ${platform} runner for ${version}`);

    // The checksums live between HTML comment markers in the release notes. A
    // release whose notes are missing them is not installed: an unverifiable
    // download is worse than no runner.
    const marker = new RegExp(`<!--\\s*BEGIN SHA ${platform}\\s*-->\\s*([0-9a-fA-F]{64})\\s*<!--\\s*END SHA ${platform}\\s*-->`);
    const sha256 = marker.exec(payload.body ?? "")?.[1];
    if (!sha256) throw new Error(`GitHub published no checksum for the ${platform} runner ${version}`);

    return {
        version,
        platform,
        assetName,
        downloadUrl: asset.browser_download_url,
        sha256: sha256.toLowerCase(),
        image: `${RUNNER_IMAGE}:${version}`
    };
}
