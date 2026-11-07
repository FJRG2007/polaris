/**
 * The TV build an instance hands out: found on the release the downloads page
 * already reads, fetched only from GitHub's hosts, and kept only when it hashes to
 * the published checksum.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir = "";
let apk = Buffer.from("sample apk bytes");
let listed = "";
let release: unknown = null;
const fetched: string[] = [];
const redirects = new Map<string, string>();
let diskFull = false;

vi.mock("node:fs", async (original) => {
    const actual = await original<typeof import("node:fs")>();
    return {
        ...actual,
        createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) =>
            diskFull
                ? new Writable({
                      write: (_chunk, _encoding, done) =>
                          done(Object.assign(new Error("no space"), { code: "ENOSPC" }))
                  })
                : actual.createWriteStream(...args)
    };
});

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_DATA_DIR: dataDir, POLARIS_REPO: "sample/polaris" })
}));
vi.mock("@/lib/app-releases", () => ({
    tvDownload: async () => release,
    tvInstallable: (found: { files: { name: string }[] } | null) =>
        Boolean(found?.files.some((file) => file.name === "polaris-tv.apk"))
}));
vi.mock("@/lib/safe-fetch", () => ({
    configuredRequest: async (address: string) => {
        fetched.push(address);
        const next = redirects.get(address);
        if (next) return new Response(null, { status: 302, headers: { location: next } });
        if (address.endsWith("SHA256SUMS")) return new Response(listed);
        if (address.endsWith("polaris-tv.apk")) return new Response(apk);
        return new Response(null, { status: 404 });
    }
}));

const tv = await import("@/lib/tv/release");
const { compareTvVersions } = await import("@/lib/tv/version-order");

const APK_URL = "https://github.com/sample/polaris/releases/download/tv-v3.5/polaris-tv.apk";
const SUMS_URL = "https://github.com/sample/polaris/releases/download/tv-v3.5/SHA256SUMS";

function sha(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "tv-release-"));
    apk = Buffer.from("sample apk bytes");
    listed = `${sha(apk)}  polaris-tv.apk\n`;
    release = {
        url: "https://github.com/sample/polaris/releases/tag/tv-v3.5",
        version: "3.5",
        files: [
            { name: "polaris-tv.apk", url: APK_URL },
            { name: "SHA256SUMS", url: SUMS_URL }
        ]
    };
    fetched.length = 0;
    redirects.clear();
    diskFull = false;
    tv.resetTvReleaseCache();
});

afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

describe("the release metadata", () => {
    it("reads the checksum for the APK out of a sha256sum listing", () => {
        const hash = "a".repeat(64);
        expect(
            tv.checksumFor(
                `${"b".repeat(64)}  other.apk\n${hash} *polaris-tv.apk\r\n`,
                "polaris-tv.apk"
            )
        ).toBe(hash);
        expect(tv.checksumFor("not a listing", "polaris-tv.apk")).toBeNull();
    });

    it("names the version and checksum without downloading the APK", async () => {
        expect(await tv.tvReleaseInfo()).toEqual({
            versionName: "3.5",
            sha256: sha(apk),
            apkUrl: APK_URL
        });
        expect(fetched).toEqual([SUMS_URL]);
    });

    it("is null when no TV build is released", async () => {
        release = null;
        expect(await tv.tvReleaseInfo()).toBeNull();
        expect(await tv.preparedTvApk()).toBeNull();
    });

    it("caches the answer", async () => {
        await tv.tvReleaseInfo();
        await tv.tvReleaseInfo();
        expect(fetched).toEqual([SUMS_URL]);
    });

    it("refuses a release whose listing names no APK", async () => {
        listed = `${"c".repeat(64)}  something-else.apk\n`;
        await expect(tv.tvReleaseInfo()).rejects.toMatchObject({ reason: "mismatch" });
    });
});

describe("the APK served from the instance", () => {
    it("is downloaded once, verified and kept", async () => {
        const first = await tv.preparedTvApk();
        expect(first).toMatchObject({ versionName: "3.5", size: apk.length, sha256: sha(apk) });
        expect(await readFile(first!.path)).toEqual(apk);
        await tv.preparedTvApk();
        expect(fetched.filter((url) => url === APK_URL)).toHaveLength(1);
    });

    it("follows GitHub's redirect to its object storage", async () => {
        const storage = "https://release-assets.githubusercontent.com/sample/polaris-tv.apk";
        redirects.set(APK_URL, storage);
        expect(await tv.preparedTvApk()).toMatchObject({ size: apk.length });
        expect(fetched).toContain(storage);
    });

    it("refuses a redirect off GitHub's hosts", async () => {
        redirects.set(APK_URL, "https://elsewhere.example/polaris-tv.apk");
        await expect(tv.preparedTvApk()).rejects.toMatchObject({ reason: "unreachable" });
        expect(fetched).not.toContain("https://elsewhere.example/polaris-tv.apk");
    });

    it("refuses an APK that does not match its checksum, and keeps nothing", async () => {
        listed = `${sha(Buffer.from("the real build"))}  polaris-tv.apk\n`;
        await expect(tv.preparedTvApk()).rejects.toMatchObject({ reason: "mismatch" });
        expect(await readdir(join(dataDir, "tv-updates"))).toEqual([]);
        // The refusal is remembered, so the next poll does not download it again.
        await expect(tv.preparedTvApk()).rejects.toMatchObject({ reason: "mismatch" });
        expect(fetched.filter((url) => url === APK_URL)).toHaveLength(1);
    });

    it("re-checks a file left on disk before trusting it", async () => {
        const kept = await tv.preparedTvApk();
        tv.resetTvReleaseCache();
        const again = await tv.preparedTvApk();
        expect(again?.path).toBe(kept?.path);
        expect(fetched.filter((url) => url === APK_URL)).toHaveLength(1);
    });

    it("keeps only the newest build", async () => {
        await tv.preparedTvApk();
        tv.resetTvReleaseCache();
        apk = Buffer.from("a newer build");
        listed = `${sha(apk)}  polaris-tv.apk\n`;
        release = { ...(release as object), version: "3.6" };
        await tv.preparedTvApk();
        const names = await readdir(join(dataDir, "tv-updates"));
        expect(names).toHaveLength(1);
        expect(names[0]).toContain("3.6");
    });
});

describe("the APK cache on disk", () => {
    it("refuses a download the disk cannot hold instead of crashing or hanging", async () => {
        diskFull = true;
        await expect(tv.preparedTvApk()).rejects.toMatchObject({ reason: "unreachable" });
        expect(await readdir(join(dataDir, "tv-updates"))).toEqual([]);
    });

    it("leaves another download's partial file alone, and clears an abandoned one", async () => {
        const dir = join(dataDir, "tv-updates");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".running.part"), "partial");
        await writeFile(join(dir, ".crashed.part"), "partial");
        const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await utimes(join(dir, ".crashed.part"), old, old);
        await tv.preparedTvApk();
        const names = await readdir(dir);
        expect(names).toContain(".running.part");
        expect(names).not.toContain(".crashed.part");
    });
});

describe("ordering versions", () => {
    it("compares dotted numbers as numbers", () => {
        expect(compareTvVersions("3.10", "3.9")).toBe(1);
        expect(compareTvVersions("3.4", "3.4")).toBe(0);
        expect(compareTvVersions("3.4", "3.4.0")).toBe(0);
        expect(compareTvVersions("3.3", "3.4")).toBe(-1);
    });
});
