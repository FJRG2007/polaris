/**
 * The CLI's official releases: the newest `cli-v*` release of the project's
 * GitHub repository, which is where the install scripts and `plr update` get
 * the bundle.
 *
 * Found by walking the release list rather than asking for `releases/latest`:
 * the repository also releases the dashboard and the browser extension, and
 * "latest" is whichever of them came last. The bundle is checked against the
 * SHA-256 digest GitHub publishes for every uploaded asset, so a truncated or
 * swapped download is never installed.
 */

import { z } from "zod";
import { CliError } from "./errors.js";
import { userAgent } from "./version.js";
import { unreachableReason, type Fetch } from "./api.js";

/** The repository the CLI is released from, unless the installer recorded another. */
export const DEFAULT_REPO = "FJRG2007/polaris";

/** What tells a CLI release apart from the repository's other releases. */
export const CLI_TAG_PREFIX = "cli-v";

/** The bundle's name on every release. */
export const BUNDLE_ASSET = "polaris.mjs";

/** The line that installs the CLI from the official releases, for this system. */
export function installCommand(platform: NodeJS.Platform, repo: string = DEFAULT_REPO): string {
    const scripts = `https://raw.githubusercontent.com/${repo}/main/dashboard/packages/cli/scripts`;
    return platform === "win32"
        ? `irm ${scripts}/install.ps1 | iex`
        : `curl -fsSL ${scripts}/install.sh | sh`;
}

const REPO_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const releasesSchema = z.array(
    z.object({
        tag_name: z.string(),
        draft: z.boolean().optional(),
        prerelease: z.boolean().optional(),
        assets: z
            .array(
                z.object({
                    name: z.string(),
                    browser_download_url: z.string().url(),
                    digest: z.string().nullish()
                })
            )
            .default([])
    })
);

export interface CliRelease {
    readonly version: string;
    readonly url: string;
    /** Hex SHA-256 of the bundle, as GitHub computed it. */
    readonly sha256: string;
}

/**
 * The newest published CLI release that carries a bundle with a digest.
 * Releases come newest first; drafts and prereleases are skipped.
 */
export async function newestRelease(
    fetcher: Fetch,
    repo: string = DEFAULT_REPO,
    api = "https://api.github.com"
): Promise<CliRelease> {
    if (!REPO_SHAPE.test(repo)) throw new CliError(`"${repo}" is not a GitHub repository.`);
    let response: Response;
    try {
        response = await fetcher(`${api}/repos/${repo}/releases?per_page=100`, {
            headers: { accept: "application/vnd.github+json", "user-agent": userAgent() },
            signal: AbortSignal.timeout(20_000)
        });
    } catch (caught) {
        throw new CliError(
            `Could not reach GitHub to look for a new CLI: ${unreachableReason(caught)}.`
        );
    }
    if (!response.ok) {
        throw new CliError(
            `GitHub did not list the CLI's releases (HTTP ${response.status}). Try again in a few minutes.`
        );
    }
    const parsed = releasesSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success)
        throw new CliError("GitHub answered in a shape this CLI does not understand.");
    for (const release of parsed.data) {
        if (release.draft || release.prerelease || !release.tag_name.startsWith(CLI_TAG_PREFIX))
            continue;
        const asset = release.assets.find((entry) => entry.name === BUNDLE_ASSET);
        const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? "");
        if (!asset || !digest) continue;
        return {
            version: release.tag_name.slice(CLI_TAG_PREFIX.length),
            url: asset.browser_download_url,
            sha256: digest[1]!.toLowerCase()
        };
    }
    throw new CliError(`${repo} has no CLI release yet.`);
}
