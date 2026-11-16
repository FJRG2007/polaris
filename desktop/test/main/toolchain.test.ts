import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as pins from "@toolchain/index";
import { zipSync, strToU8 } from "fflate";
import { existsSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extractZip, prepareToolchain, toolReady, type ToolchainProgress } from "@/main/toolchain";

// Never the network: every archive is a fixture built here and served by a fake fetch.
const PLATFORM = process.platform;

function fixtureZip(files: Record<string, string>): Uint8Array {
    return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

function fixtureDownload(archive: Uint8Array, overrides: Partial<pins.ToolchainDownload> = {}): pins.ToolchainDownload {
    return {
        tool: "gh",
        version: "9.9.9",
        url: "https://example.test/gh.zip",
        archive: "zip",
        sha256: createHash("sha256").update(archive).digest("hex"),
        binDirs: ["bin"],
        command: "bin/gh",
        ...overrides
    };
}

function serving(body: Uint8Array) {
    return vi.fn(async () => new Response(body as unknown as BodyInit, { status: 200, headers: { "content-length": String(body.byteLength) } }));
}

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "polaris-toolchain-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("prepareToolchain", () => {
    it("downloads, checks, unwraps the archive's top folder, and puts the tool first on PATH", async () => {
        const archive = fixtureZip({ "gh_9.9.9_fixture/bin/gh": "fixture gh", "gh_9.9.9_fixture/LICENSE": "MIT" });
        const item = fixtureDownload(archive);
        const fetch = serving(archive);
        const progress: ToolchainProgress[] = [];
        const result = await prepareToolchain([item], { root, platform: PLATFORM, fetch, run: vi.fn(), onProgress: (p) => progress.push(p) });

        expect(result.ok).toBe(true);
        const dir = pins.toolchainToolDir(root, PLATFORM, item);
        expect(await readFile(join(dir, "bin", "gh"), "utf8")).toBe("fixture gh");
        expect(toolReady(root, PLATFORM, item)).toBe(true);
        expect(progress.map((p) => p.step)).toEqual(expect.arrayContaining(["verify", "install", "ready"]));
        if (result.ok) {
            const pathKey = Object.keys(result.env).find((k) => k.toUpperCase() === "PATH")!;
            expect(result.env[pathKey]!.split(PLATFORM === "win32" ? ";" : ":")[0]).toBe(join(dir, "bin"));
        }
        // Nothing left behind but the tool itself.
        expect(readdirSync(join(root, ".downloads"))).toEqual([]);
        expect(readdirSync(join(root, "gh"))).toEqual(["9.9.9"]);
    });

    it("refuses a file that does not match its pinned checksum and installs nothing", async () => {
        const archive = fixtureZip({ "bin/gh": "tampered" });
        const item = fixtureDownload(archive, { sha256: "0".repeat(64) });
        const progress: ToolchainProgress[] = [];
        const result = await prepareToolchain([item], { root, platform: PLATFORM, fetch: serving(archive), run: vi.fn(), onProgress: (p) => progress.push(p) });

        expect(result).toEqual({ ok: false, tool: "gh", code: "checksum" });
        expect(progress.at(-1)).toEqual({ tool: "gh", step: "failed", code: "checksum" });
        expect(existsSync(pins.toolchainToolDir(root, PLATFORM, item))).toBe(false);
        expect(readdirSync(join(root, ".downloads"))).toEqual([]);
    });

    it("skips what is already in place, so Try again only fetches what failed", async () => {
        const archive = fixtureZip({ "bin/gh": "fixture" });
        const item = fixtureDownload(archive);
        await prepareToolchain([item], { root, platform: PLATFORM, fetch: serving(archive), run: vi.fn() });
        const again = serving(archive);
        const result = await prepareToolchain([item], { root, platform: PLATFORM, fetch: again, run: vi.fn() });
        expect(result.ok).toBe(true);
        expect(again).not.toHaveBeenCalled();
    });

    it("says offline when the download cannot be reached or answers an error", async () => {
        const item = fixtureDownload(fixtureZip({ "bin/gh": "x" }));
        const down = vi.fn(async () => {
            throw new TypeError("fetch failed");
        });
        expect(await prepareToolchain([item], { root, platform: PLATFORM, fetch: down, run: vi.fn() })).toEqual({ ok: false, tool: "gh", code: "offline" });
        const missing = vi.fn(async () => new Response("no", { status: 404 }));
        expect(await prepareToolchain([item], { root, platform: PLATFORM, fetch: missing, run: vi.fn() })).toEqual({ ok: false, tool: "gh", code: "offline" });
    });

    it("replaces an older pinned version once the new one is in place", async () => {
        await mkdir(join(root, "gh", "1.0.0"), { recursive: true });
        await writeFile(join(root, "gh", "1.0.0", ".polaris-ready"), "1.0.0\n");
        const archive = fixtureZip({ "bin/gh": "new" });
        const result = await prepareToolchain([fixtureDownload(archive)], { root, platform: PLATFORM, fetch: serving(archive), run: vi.fn() });
        expect(result.ok).toBe(true);
        expect(readdirSync(join(root, "gh"))).toEqual(["9.9.9"]);
    });

    it("installs an agent CLI with the managed Node's npm into its own prefix, checked by integrity", async () => {
        const nodeZip = fixtureZip({ "node-fixture/node.exe": "", "node-fixture/bin/node": "" });
        const node = fixtureDownload(nodeZip, { tool: "node", version: "1.0.0", command: PLATFORM === "win32" ? "node.exe" : "bin/node", binDirs: ["."] });
        const tgz = strToU8("fixture npm tarball");
        const agent: pins.ToolchainDownload = {
            tool: "claude",
            version: "1.2.3",
            url: "https://example.test/claude.tgz",
            archive: "npm",
            integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}`,
            binDirs: ["bin"],
            command: "bin/claude"
        };
        const fetch = vi.fn(async (url: string | URL | Request) => new Response((String(url).endsWith(".tgz") ? tgz : nodeZip) as unknown as BodyInit, { status: 200 }));
        const run = vi.fn(async () => 0);
        const result = await prepareToolchain([node, agent], { root, platform: PLATFORM, fetch: fetch as typeof globalThis.fetch, run });

        expect(result.ok).toBe(true);
        const [file, args] = run.mock.calls[0] as unknown as [string, string[]];
        expect(file).toBe(join(pins.toolchainToolDir(root, PLATFORM, node), node.command));
        expect(args.slice(1, 4)).toEqual(["install", "--global", "--prefix"]);
        expect(args[4]).toContain(join(root, "claude"));
    });

    it("reports an npm failure as an install failure", async () => {
        const nodeZip = fixtureZip({ "node.exe": "" });
        const node = fixtureDownload(nodeZip, { tool: "node", version: "1.0.0", command: "node.exe", binDirs: ["."] });
        const tgz = strToU8("t");
        const agent: pins.ToolchainDownload = { ...node, tool: "codex", archive: "npm", sha256: undefined, integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}` };
        const fetch = vi.fn(async (url: string | URL | Request) => new Response((String(url) === node.url && fetch.mock.calls.length === 1 ? nodeZip : tgz) as unknown as BodyInit));
        const result = await prepareToolchain([node, agent], { root, platform: PLATFORM, fetch: fetch as typeof globalThis.fetch, run: vi.fn(async () => 1) });
        expect(result).toEqual({ ok: false, tool: "codex", code: "install" });
    });
});

describe("extractZip", () => {
    it("refuses an entry that climbs out of the destination", async () => {
        const file = join(root, "evil.zip");
        await writeFile(file, fixtureZip({ "../outside.txt": "no" }));
        await expect(extractZip(file, join(root, "dest"))).rejects.toThrow(/unsafe entry/);
        expect(existsSync(join(root, "outside.txt"))).toBe(false);
    });
});
