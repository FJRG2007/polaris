/**
 * The update check: which published desktop release is newer than the running
 * app, read from the repository's release list.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { appImageAsset, CHECKSUMS, macFeedName, newerRelease, parseChecksums, parseVersion, releaseSource, TAG_PREFIX } from "@/main/releases";

const release = (tag: string, extra: { draft?: boolean; prerelease?: boolean; } = {}) => ({
    tag_name: tag,
    draft: extra.draft ?? false,
    prerelease: extra.prerelease ?? false,
    html_url: `https://github.com/example/repo/releases/tag/${tag}`
});

describe("parseVersion", () => {
    it("reads a plain version and nothing else", () => {
        expect(parseVersion("0.1.0")).toEqual([0, 1, 0]);
        expect(parseVersion("12.0.3")).toEqual([12, 0, 3]);
        expect(parseVersion("1.2.0-beta.1")).toBeNull();
        expect(parseVersion("v1.2.0")).toBeNull();
        expect(parseVersion("1.2")).toBeNull();
    });
});

describe("newerRelease", () => {
    it("picks the highest published desktop version above the running one", () => {
        const list = [
            release("v3.0.0"),
            release("desktop-v0.2.0"),
            release("desktop-v0.10.0"),
            release("desktop-v0.9.1"),
            release("desktop-v1.0.0", { draft: true }),
            release("desktop-v0.11.0", { prerelease: true }),
            release("desktop-v0.12.0-rc.1")
        ];
        expect(newerRelease(list, "0.1.0")).toMatchObject({ version: "0.10.0", tag: "desktop-v0.10.0" });
    });

    it("answers null when the running version is the newest, or is not a version", () => {
        expect(newerRelease([release("desktop-v0.1.0"), release("desktop-v0.0.9")], "0.1.0")).toBeNull();
        expect(newerRelease([release("desktop-v0.2.0")], "dev")).toBeNull();
    });

    it("answers null for anything that is not a release list", () => {
        expect(newerRelease({ message: "API rate limit exceeded" }, "0.1.0")).toBeNull();
        expect(newerRelease([{ tag_name: 7 }], "0.1.0")).toBeNull();
        expect(newerRelease(null, "0.1.0")).toBeNull();
    });
});

describe("releaseSource", () => {
    it("reads the repository from package.json and matches the workflow's tag prefix", () => {
        const manifest = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { repository: string; };
        const source = releaseSource(manifest.repository);
        expect(source?.api).toMatch(/^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases\?per_page=100$/);
        expect(source?.page(`${TAG_PREFIX}1.2.3`)).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/tag\/desktop-v1\.2\.3$/);
        // Squirrel reads RELEASES and the package from beside each other.
        expect(source?.download(`${TAG_PREFIX}1.2.3`)).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/desktop-v1\.2\.3$/);

        const workflow = readFileSync(join(__dirname, "../../../.github/workflows/desktop.yml"), "utf8");
        expect(workflow).toContain(`- "${TAG_PREFIX}*"`);
    });

    it("takes the usual spellings of a GitHub repository, and refuses anything else", () => {
        expect(releaseSource("git+https://github.com/owner/repo.git")?.api).toBe(
            "https://api.github.com/repos/owner/repo/releases?per_page=100"
        );
        expect(releaseSource("https://gitlab.com/owner/repo")).toBeNull();
        expect(releaseSource("https://github.com/owner")).toBeNull();
    });
});

describe("release files", () => {
    const sha = (character: string) => character.repeat(64);

    it("carries the release's files with the version it picks", () => {
        const list = [{ ...release("desktop-v0.2.0"), assets: [{ name: "Polaris-0.2.0-x64.AppImage", size: 10, url: "ignored" }] }];
        expect(newerRelease(list, "0.1.0")?.assets).toEqual([{ name: "Polaris-0.2.0-x64.AppImage", size: 10 }]);
        expect(newerRelease([release("desktop-v0.2.0")], "0.1.0")?.assets).toEqual([]);
    });

    it("reads sha256sum output, text or binary mode, and drops what is not a line of it", () => {
        const sums = parseChecksums(
            [`${sha("A")}  Polaris-0.2.0-x64.AppImage`, `${sha("b")} *polaris-0.2.0-full.nupkg\r`, "not a line", `${sha("c")}`, ""].join("\n")
        );
        expect(sums.get("Polaris-0.2.0-x64.AppImage")).toBe(sha("a"));
        expect(sums.get("polaris-0.2.0-full.nupkg")).toBe(sha("b"));
        expect(sums.size).toBe(2);
    });

    it("trusts no digest for a name listed twice", () => {
        const sums = parseChecksums(`${sha("a")}  Polaris.AppImage\n${sha("b")}  Polaris.AppImage\n`);
        expect(sums.has("Polaris.AppImage")).toBe(false);
    });

    it("picks the one AppImage for this architecture", () => {
        const assets = [
            { name: "Polaris-0.2.0-x64.AppImage", size: 10 },
            { name: "Polaris-0.2.0-arm64.AppImage", size: 10 },
            { name: "polaris-desktop_0.2.0_amd64.deb", size: 10 },
            { name: CHECKSUMS, size: 10 }
        ];
        expect(appImageAsset(assets, "x64")?.name).toBe("Polaris-0.2.0-x64.AppImage");
        expect(appImageAsset(assets, "arm64")?.name).toBe("Polaris-0.2.0-arm64.AppImage");
        expect(appImageAsset(assets, "ia32")).toBeNull();
        expect(appImageAsset([{ name: "Polaris-0.2.0-x64.AppImage", size: 0 }], "x64")).toBeNull();
        expect(appImageAsset([{ name: "Polaris-x64.AppImage", size: 1 }, { name: "Polaris-x86_64.AppImage", size: 1 }], "x64")).toBeNull();
    });

    it("names the macOS feed and the checksums the way the release job writes them", () => {
        const { macFeedName: written } = createRequire(import.meta.url)("../../build/mac-feed.cjs") as { macFeedName: (arch: string) => string; };
        expect(macFeedName("arm64")).toBe(written("arm64"));
        const workflow = readFileSync(join(__dirname, "../../../.github/workflows/desktop.yml"), "utf8");
        expect(workflow).toContain(CHECKSUMS);
        expect(workflow).toContain("build/mac-feed.cjs");
    });
});
