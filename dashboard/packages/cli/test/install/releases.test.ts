/**
 * Where `plr update` and the install scripts get the CLI: the newest `cli-v*`
 * release of the repository, never the dashboard's or the extension's, and only
 * a bundle that matches the digest GitHub published for it.
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "../../src/api.js";
import { testContext } from "../helpers/context.js";
import { fetchRelease, sha256 } from "../../src/commands/install.js";
import { installCommand, newestRelease, type CliRelease } from "../../src/releases.js";

const BUNDLE = new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('plr');\n");
const DIGEST = sha256(BUNDLE);
const ASSET = "https://github.com/example/polaris/releases/download/cli-v0.6.0/polaris.mjs";

function release(tag: string, extra: Record<string, unknown> = {}, digest: string | null = DIGEST) {
    return {
        tag_name: tag,
        draft: false,
        prerelease: false,
        assets: [
            { name: "install.sh", browser_download_url: `${ASSET}.sh`, digest: null },
            {
                name: "polaris.mjs",
                browser_download_url: ASSET.replace("0.6.0", tag.replace(/^\D+/, "")),
                digest: digest ? `sha256:${digest}` : null
            }
        ],
        ...extra
    };
}

function listing(releases: unknown[], seen: string[] = []): Fetch {
    return async (input) => {
        seen.push(String(input));
        return Response.json(releases);
    };
}

describe("the newest CLI release", () => {
    it("is the first cli-v release, past the dashboard's and the extension's", async () => {
        const seen: string[] = [];
        const found = await newestRelease(
            listing(
                [
                    release("dashboard-v0.5.0"),
                    release("extension-v0.2.0"),
                    release("cli-v0.7.0", { draft: true }),
                    release("cli-v0.6.1", { prerelease: true }),
                    release("cli-v0.6.0"),
                    release("cli-v0.5.0")
                ],
                seen
            ),
            "example/polaris"
        );
        expect(found).toEqual({ version: "0.6.0", url: ASSET, sha256: DIGEST });
        expect(seen).toEqual([
            "https://api.github.com/repos/example/polaris/releases?per_page=100"
        ]);
    });

    it("skips a release with no digest to check the bundle against", async () => {
        const found = await newestRelease(
            listing([release("cli-v0.6.0", {}, null), release("cli-v0.5.0")])
        );
        expect(found.version).toBe("0.5.0");
    });

    it("says so when there is none, and refuses a repository that is not one", async () => {
        await expect(newestRelease(listing([release("extension-v0.1.0")]))).rejects.toThrow(
            /no CLI release yet/
        );
        await expect(newestRelease(listing([]), "not a repo")).rejects.toThrow(
            /not a GitHub repository/
        );
    });

    it("is installed with the repository's own script, per system", () => {
        expect(installCommand("win32", "example/polaris")).toBe(
            "irm https://raw.githubusercontent.com/example/polaris/main/dashboard/packages/cli/scripts/install.ps1 | iex"
        );
        expect(installCommand("darwin", "example/polaris")).toBe(
            "curl -fsSL https://raw.githubusercontent.com/example/polaris/main/dashboard/packages/cli/scripts/install.sh | sh"
        );
    });
});

describe("a release's bundle", () => {
    const wanted: CliRelease = { version: "0.6.0", url: ASSET, sha256: DIGEST };
    const serving =
        (body: Uint8Array): Fetch =>
        async () =>
            new Response(body);

    it("is taken when it matches the published digest", async () => {
        const { context } = await testContext({ fetch: serving(BUNDLE) });
        expect(await fetchRelease(context, wanted)).toEqual(BUNDLE);
    });

    it("is refused when it does not, or when it is not a CLI", async () => {
        const swapped = new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('other');\n");
        const { context } = await testContext({ fetch: serving(swapped) });
        await expect(fetchRelease(context, wanted)).rejects.toThrow(/checksum/);
        const page = new TextEncoder().encode("<html>not found</html>");
        const other = await testContext({ fetch: serving(page) });
        await expect(
            fetchRelease(other.context, { ...wanted, sha256: sha256(page) })
        ).rejects.toThrow(/not a CLI/);
    });
});
