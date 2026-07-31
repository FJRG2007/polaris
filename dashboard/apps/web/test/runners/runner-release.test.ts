/**
 * The release parser decides which binary gets downloaded onto somebody's server
 * and what it is checked against, so the cases pinned here are the ones where
 * being lenient would mean running an unverified executable: notes with no
 * checksum, a checksum for a different platform, and a version that is not one.
 */

import { describe, expect, it } from "vitest";
import { parseRunnerRelease, runnerPlatform } from "@/lib/runners/runner-release";

const SHA_LINUX = "04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d";
const SHA_ARM = "58b758e420b87093fbd4bfddd368074960053e2f1388f01848c82624b90f27d1";

const payload = {
    tag_name: "v2.336.0",
    body: [
        "## What's Changed",
        `- actions-runner-linux-x64-2.336.0.tar.gz <!-- BEGIN SHA linux-x64 -->${SHA_LINUX}<!-- END SHA linux-x64 -->`,
        `- actions-runner-linux-arm64-2.336.0.tar.gz <!-- BEGIN SHA linux-arm64 -->${SHA_ARM}<!-- END SHA linux-arm64 -->`
    ].join("\n"),
    assets: [
        {
            name: "actions-runner-linux-x64-2.336.0.tar.gz",
            browser_download_url:
                "https://github.com/actions/runner/releases/download/v2.336.0/actions-runner-linux-x64-2.336.0.tar.gz"
        },
        {
            name: "actions-runner-linux-arm64-2.336.0.tar.gz",
            browser_download_url:
                "https://github.com/actions/runner/releases/download/v2.336.0/actions-runner-linux-arm64-2.336.0.tar.gz"
        }
    ]
};

describe("parseRunnerRelease", () => {
    it("reads the asset and its published checksum", () => {
        expect(parseRunnerRelease(payload, "linux-x64")).toMatchObject({
            version: "2.336.0",
            assetName: "actions-runner-linux-x64-2.336.0.tar.gz",
            sha256: SHA_LINUX,
            image: "ghcr.io/actions/actions-runner:2.336.0"
        });
    });

    it("takes the checksum belonging to the platform asked for", () => {
        expect(parseRunnerRelease(payload, "linux-arm64").sha256).toBe(SHA_ARM);
    });

    it("refuses a release whose notes carry no checksum", () => {
        expect(() => parseRunnerRelease({ ...payload, body: "## What's Changed" }, "linux-x64")).toThrow(/checksum/i);
    });

    it("refuses a checksum that is not one", () => {
        const body = "<!-- BEGIN SHA linux-x64 -->not-a-hash<!-- END SHA linux-x64 -->";
        expect(() => parseRunnerRelease({ ...payload, body }, "linux-x64")).toThrow(/checksum/i);
    });

    it("refuses a platform the release has no asset for", () => {
        expect(() => parseRunnerRelease(payload, "osx-arm64")).toThrow(/no osx-arm64 runner/i);
    });

    it("refuses a version that is not a version", () => {
        expect(() => parseRunnerRelease({ ...payload, tag_name: "latest" }, "linux-x64")).toThrow(/version/i);
    });

    it("lowercases the checksum, since the machine compares it as text", () => {
        const body = `<!-- BEGIN SHA linux-x64 -->${SHA_LINUX.toUpperCase()}<!-- END SHA linux-x64 -->`;
        expect(parseRunnerRelease({ ...payload, body }, "linux-x64").sha256).toBe(SHA_LINUX);
    });
});

describe("runnerPlatform", () => {
    it.each([
        ["linux", "x86_64", "linux-x64"],
        ["linux", "amd64", "linux-x64"],
        ["linux", "aarch64", "linux-arm64"],
        ["linux", "armv7l", "linux-arm"],
        ["darwin", "arm64", "osx-arm64"],
        ["darwin", "x86_64", "osx-x64"]
    ])("maps %s/%s", (platform, arch, expected) => {
        expect(runnerPlatform(platform, arch)).toBe(expected);
    });

    it.each([
        ["windows", "x86_64"],
        ["linux", "riscv64"],
        ["darwin", "armv7l"],
        ["", ""]
    ])("refuses %s/%s rather than guessing", (platform, arch) => {
        expect(runnerPlatform(platform, arch)).toBeNull();
    });
});
