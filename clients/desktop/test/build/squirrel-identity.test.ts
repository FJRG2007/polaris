/**
 * What every Windows install already out there matches a release against.
 *
 * An installed copy's updater cannot be changed after it shipped: 0.1.52 lists
 * the repository's releases, takes the highest `desktop-v` tag that is neither
 * a draft nor a pre-release, and hands Squirrel.Windows that release's download
 * folder, where it reads `RELEASES` and the full package it names. Squirrel
 * keys the install by the package id. Renaming any of these - the id, the
 * executable, the setup's name, the tag, the files the release attaches -
 * leaves every install in the world on its version, with nothing it can do
 * about it (docs/bugs/BUG-0042-desktop-windows-update-not-applied.md).
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { releaseSource, TAG_PREFIX } from "@/main/releases";

const ROOT = join(__dirname, "../..");
const forge = createRequire(import.meta.url)(join(ROOT, "forge.config.js")) as {
    packagerConfig: { executableName?: string; };
    makers: { name: string; config?: { name?: string; setupExe?: string; noMsi?: boolean; remoteReleases?: string; }; }[];
};
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string; repository: string; };
const workflow = readFileSync(join(ROOT, "../../.github/workflows/desktop.yml"), "utf8");
const squirrel = forge.makers.find((maker) => maker.name === "@electron-forge/maker-squirrel")?.config;

describe("the Squirrel.Windows identity installed copies update by", () => {
    it("keeps the package id, the executable and the setup's name", () => {
        expect(squirrel?.name).toBe("polaris-desktop");
        expect(squirrel?.setupExe).toBe("Polaris-Setup.exe");
        expect(forge.packagerConfig.executableName).toBe("polaris");
        expect(pkg.name).toBe("polaris-desktop");
    });

    it("builds full packages only, so RELEASES never names a delta the release lacks", () => {
        expect(squirrel?.remoteReleases).toBeUndefined();
    });

    it("keeps the tag and the folder Squirrel is pointed at", () => {
        expect(TAG_PREFIX).toBe("desktop-v");
        const source = releaseSource(pkg.repository);
        expect(source?.api).toBe("https://api.github.com/repos/FJRG2007/polaris/releases?per_page=100");
        expect(source?.download("desktop-v0.1.200")).toBe("https://github.com/FJRG2007/polaris/releases/download/desktop-v0.1.200");
    });

    it("publishes on a desktop-v tag, as a release that is not a pre-release, with RELEASES and the package attached", () => {
        expect(workflow).toMatch(/tags:\s*\n\s*- "?desktop-v\*"?/);
        expect(workflow).not.toMatch(/^\s*prerelease:\s*"?true/m);
        expect(workflow).not.toMatch(/^\s*draft:\s*"?true/m);
        expect(workflow).toContain("installers/**/*.nupkg");
        expect(workflow).toContain("installers/**/RELEASES");
        expect(workflow).toContain("installers/**/*.exe");
    });
});
