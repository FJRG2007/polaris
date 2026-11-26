import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { entryFor, fakeFetch, fixturePackage, PACKAGE_URL, zip } from "./fixtures";
import {
    installPlugin,
    readPluginSettings,
    readInstalled,
    safeArchivePath,
    setPluginEnabled,
    uninstallPlugin,
    writePluginSettings,
    type InstallOptions
} from "@/main/plugins/packages";

// A folder Windows will not let go of: `rm` refuses any path holding `locked`.
const lock = vi.hoisted(() => ({ name: null as string | null }));
vi.mock("node:fs/promises", async (original) => {
    const real = await original<typeof import("node:fs/promises")>();
    return {
        ...real,
        rm: (path: string, options?: Parameters<typeof real.rm>[1]) =>
            lock.name && String(path).includes(lock.name) ? Promise.reject(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })) : real.rm(path, options)
    };
});

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "plugins-packages-"));
    dirs.push(dir);
    return dir;
}
afterEach(async () => {
    lock.name = null;
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function install(bytes: Uint8Array, overrides: Partial<InstallOptions> = {}, served = bytes) {
    const dir = overrides.dir ?? (await tempDir());
    const result = await installPlugin({
        dir,
        entry: entryFor(bytes),
        platform: "linux-x64",
        appVersion: "0.1.73",
        accepted: ["usb", "polaris-actions"],
        fetcher: fakeFetch({ [PACKAGE_URL]: served }),
        ...overrides
    });
    return { dir, result };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

describe("installing a plugin", () => {
    it("unpacks a package whose hash and manifest agree with the catalog", async () => {
        const progress: number[] = [];
        const { dir, result } = await install(fixturePackage(), { onProgress: (received) => progress.push(received) });
        expect(result.ok).toBe(true);
        expect(await exists(join(dir, "packages", "fixture-mixer", "1.0.0", "main.js"))).toBe(true);
        expect((await readInstalled(dir)).plugins["fixture-mixer"]).toMatchObject({ version: "1.0.0", enabled: true, granted: ["usb", "polaris-actions"] });
        expect(progress.at(-1)).toBe(fixturePackage().byteLength);
    });

    it("refuses a package whose bytes are not the ones the catalog signed", async () => {
        const { dir, result } = await install(fixturePackage(), {}, fixturePackage({ summary: "a fixture plugin." }));
        expect(result).toEqual({ ok: false, reason: "hash" });
        expect(await exists(join(dir, "packages"))).toBe(false);
    });

    it("refuses a download longer or shorter than the catalog says", async () => {
        const bytes = fixturePackage();
        expect((await install(bytes, {}, fixturePackage({ summary: "A longer fixture plugin." }))).result).toEqual({ ok: false, reason: "size" });
        expect((await install(bytes, {}, bytes.slice(0, 10))).result).toEqual({ ok: false, reason: "size" });
    });

    it("refuses without every permission accepted", async () => {
        const { result } = await install(fixturePackage(), { accepted: ["usb"] });
        expect(result).toEqual({ ok: false, reason: "permissions" });
    });

    it("refuses a package that asks for more than the catalog says", async () => {
        const { result } = await install(fixturePackage({ permissions: ["usb", "polaris-actions", "network"] }));
        expect(result).toEqual({ ok: false, reason: "manifest" });
    });

    it("refuses an archive with a path out of its folder", async () => {
        const bytes = zip({ "manifest.json": "{}", "../escape.js": "" });
        const { dir, result } = await install(bytes);
        expect(result).toEqual({ ok: false, reason: "archive" });
        expect(await exists(join(dir, "..", "escape.js"))).toBe(false);
    });

    it("tells unsafe archive paths apart", () => {
        expect(safeArchivePath("lib/native/stream100.node")).toBe(true);
        for (const path of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "./x", ""]) expect(safeArchivePath(path)).toBe(false);
    });

    it("refuses a platform the package was not built for", async () => {
        const { result } = await install(fixturePackage(), { platform: "darwin-arm64" });
        expect(result).toEqual({ ok: false, reason: "platform" });
    });
});

describe("updating, disabling and uninstalling", () => {
    it("replaces the earlier version and keeps it disabled when it was", async () => {
        const { dir } = await install(fixturePackage());
        await setPluginEnabled(dir, "fixture-mixer", false);
        const next = fixturePackage({ version: "1.1.0" });
        const result = await installPlugin({
            dir,
            entry: entryFor(next, { version: "1.1.0" }),
            platform: "linux-x64",
            appVersion: "0.1.73",
            accepted: ["usb", "polaris-actions"],
            fetcher: fakeFetch({ [PACKAGE_URL]: next })
        });
        expect(result.ok).toBe(true);
        // The replaced version stays on disk to roll back to (updates.test.ts).
        expect(await readdir(join(dir, "packages", "fixture-mixer"))).toEqual(["1.0.0", "1.1.0"]);
        expect((await readInstalled(dir)).plugins["fixture-mixer"]?.enabled).toBe(false);
    });

    it("is installed even when the version it replaces cannot be removed, and sweeps it later", async () => {
        const { dir } = await install(fixturePackage());
        // Left behind by an app up to 0.1.96, which threw here and failed the install.
        await mkdir(join(dir, "packages", "fixture-mixer", "0.9.0"), { recursive: true });
        await writeFile(join(dir, "packages", "fixture-mixer", "0.9.0", "main.node"), "loaded");
        lock.name = "0.9.0";
        const update = (version: string) => {
            const next = fixturePackage({ version });
            return installPlugin({
                dir,
                entry: entryFor(next, { version }),
                platform: "linux-x64",
                appVersion: "0.1.73",
                accepted: ["usb", "polaris-actions"],
                fetcher: fakeFetch({ [PACKAGE_URL]: next })
            });
        };
        expect((await update("1.1.0")).ok).toBe(true);
        expect((await readInstalled(dir)).plugins["fixture-mixer"]?.version).toBe("1.1.0");
        expect(await readdir(join(dir, "packages", "fixture-mixer"))).toEqual(["0.9.0", "1.0.0", "1.1.0"]);
        lock.name = null;
        expect((await update("1.2.0")).ok).toBe(true);
        // One earlier version kept, never more.
        expect(await readdir(join(dir, "packages", "fixture-mixer"))).toEqual(["1.1.0", "1.2.0"]);
    });

    it("leaves nothing behind once uninstalled", async () => {
        const { dir, result } = await install(fixturePackage());
        if (!result.ok) throw new Error("install failed");
        await writePluginSettings(dir, "fixture-mixer", { lights: false });
        expect(await readPluginSettings(dir, result.manifest)).toEqual({ lights: false });
        await uninstallPlugin(dir, "fixture-mixer");
        expect(await exists(join(dir, "packages", "fixture-mixer"))).toBe(false);
        expect(await exists(join(dir, "settings", "fixture-mixer.json"))).toBe(false);
        expect((await readInstalled(dir)).plugins).toEqual({});
        expect(await readPluginSettings(dir, result.manifest)).toEqual({ lights: true });
    });
});
