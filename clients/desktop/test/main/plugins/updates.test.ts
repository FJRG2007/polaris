import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createPluginManager } from "@/main/plugins/manager";
import type { PluginChild } from "@/main/plugins/supervisor";
import { installPlugin, packageDir, readInstalled, rollbackPlugin } from "@/main/plugins/packages";
import { comparePluginVersions, type PluginEntry, type UsbDevice } from "@polaris/core/device-plugins";
import { catalogOf, entryFor, fakeFetch, fixturePackage, PACKAGE_URL, sign, TEST_KEYS } from "./fixtures";
import { addedPermissions, CHECK_EVERY_MS, decideUpdate, newsWords, nextCheckDelay, RETRY_FIRST_MS, type UpdateFacts, type UpdateNews } from "@/main/plugins/updates";

const CATALOG = "https://github.com/FJRG2007/polaris/releases/download/device-plugins/catalog.json";
const DEVICE: UsbDevice = { vendorId: 0x06f8, productId: 0xe053 };
const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "plugins-updates-"));
    dirs.push(dir);
    return dir;
}
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function facts(overrides: Partial<UpdateFacts> = {}, entry: Partial<PluginEntry> = {}): UpdateFacts {
    return {
        installed: { version: "1.0.0", granted: ["usb", "polaris-actions"] },
        entry: entryFor(fixturePackage(), { version: "1.1.0", ...entry }),
        platform: "linux-x64",
        appVersion: "0.1.90",
        autoUpdate: undefined,
        busy: false,
        ...overrides
    };
}

describe("version compare", () => {
    it("orders by number, not by text", () => {
        expect(comparePluginVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
        expect(comparePluginVersions("1.2.3", "1.2.3")).toBe(0);
        expect(comparePluginVersions("0.9.0", "1.0.0")).toBeLessThan(0);
        expect(comparePluginVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
        expect(comparePluginVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    });
});

describe("when to look again", () => {
    it("waits six hours after a good look and backs off from five minutes after failed ones", () => {
        expect(CHECK_EVERY_MS).toBe(60 * 60_000);
        expect(nextCheckDelay(0)).toBe(CHECK_EVERY_MS);
        expect(nextCheckDelay(1)).toBe(RETRY_FIRST_MS);
        expect(nextCheckDelay(2)).toBe(RETRY_FIRST_MS * 2);
        expect(nextCheckDelay(3)).toBe(RETRY_FIRST_MS * 4);
        expect(nextCheckDelay(50)).toBe(CHECK_EVERY_MS);
    });
});

describe("update decision", () => {
    it("puts a newer version in by itself when nothing says otherwise", () => {
        expect(decideUpdate(facts())).toEqual({ kind: "apply", version: "1.1.0" });
    });

    it("does nothing for the same or an earlier version", () => {
        expect(decideUpdate(facts({}, { version: "1.0.0" }))).toEqual({ kind: "none" });
        expect(decideUpdate(facts({}, { version: "0.9.0" }))).toEqual({ kind: "none" });
        expect(decideUpdate(facts({ entry: null }))).toEqual({ kind: "none" });
    });

    it("does nothing for a version this app cannot run", () => {
        expect(decideUpdate(facts({}, { minAppVersion: "9.0.0" }))).toEqual({ kind: "none" });
        expect(decideUpdate(facts({ platform: "darwin-arm64" }))).toEqual({ kind: "none" });
    });

    it("holds a version that asks for a new permission, even with automatic updates on", () => {
        const asking = facts({ autoUpdate: true, installed: { version: "1.0.0", granted: ["usb", "polaris-actions"], autoUpdate: true } }, { permissions: ["usb", "polaris-actions", "network"] });
        expect(decideUpdate(asking)).toEqual({ kind: "consent", version: "1.1.0", added: ["network"] });
    });

    it("puts in a version that asks for fewer permissions", () => {
        expect(decideUpdate(facts({}, { permissions: ["usb"] }))).toEqual({ kind: "apply", version: "1.1.0" });
        expect(addedPermissions(["usb"], ["usb", "network"])).toEqual([]);
    });

    it("leaves it to the person when automatic updates are off, the plugin's own choice first", () => {
        expect(decideUpdate(facts({ autoUpdate: false }))).toEqual({ kind: "offer", version: "1.1.0", why: "manual" });
        expect(decideUpdate(facts({ installed: { version: "1.0.0", granted: ["usb", "polaris-actions"], autoUpdate: false } }))).toMatchObject({ kind: "offer" });
        expect(decideUpdate(facts({ autoUpdate: false, installed: { version: "1.0.0", granted: ["usb", "polaris-actions"], autoUpdate: true } }))).toMatchObject({ kind: "apply" });
    });

    it("never puts back by itself a version that failed here and was rolled back from", () => {
        expect(decideUpdate(facts({ installed: { version: "1.0.0", granted: ["usb", "polaris-actions"], failed: "1.1.0" } }))).toEqual({ kind: "offer", version: "1.1.0", why: "failed" });
        expect(decideUpdate(facts({ installed: { version: "1.0.0", granted: ["usb", "polaris-actions"], failed: "1.1.0" } }, { version: "1.2.0" }))).toMatchObject({ kind: "apply" });
    });

    it("waits while the plugin says its device is busy", () => {
        expect(decideUpdate(facts({ busy: true }))).toEqual({ kind: "wait", version: "1.1.0" });
    });

    it("words each notice with the version and what changed", () => {
        expect(newsWords({ kind: "updated", name: "Mixer", version: "1.1.0", changelog: "- Faster faders\n- Other" })).toEqual({ title: "Mixer updated to 1.1.0", body: "Faster faders" });
        expect(newsWords({ kind: "consent", name: "Mixer", version: "1.1.0", added: ["network"] }).body).toContain("reach the network");
        expect(newsWords({ kind: "rolled-back", name: "Mixer", from: "1.1.0", to: "1.0.0" }).body).toContain("1.0.0");
    });
});

describe("rollback", () => {
    it("keeps the replaced version on disk and goes back to it, remembering the failed one", async () => {
        const dir = await tempDir();
        const first = fixturePackage();
        const second = fixturePackage({ version: "1.1.0" });
        const table: Record<string, Uint8Array> = { [PACKAGE_URL]: first };
        const fetcher = fakeFetch(table);
        const base = { dir, platform: "linux-x64" as const, appVersion: "0.1.90", accepted: ["usb", "polaris-actions"] as const, fetcher };
        expect((await installPlugin({ ...base, entry: entryFor(first) })).ok).toBe(true);
        table[PACKAGE_URL] = second;
        expect((await installPlugin({ ...base, entry: entryFor(second, { version: "1.1.0" }) })).ok).toBe(true);
        expect((await readInstalled(dir)).plugins["fixture-mixer"]?.previous).toEqual({ version: "1.0.0", granted: ["usb", "polaris-actions"] });
        expect(existsSync(packageDir(dir, "fixture-mixer", "1.0.0"))).toBe(true);

        expect(await rollbackPlugin(dir, "fixture-mixer")).toEqual({ from: "1.1.0", to: "1.0.0" });
        const after = (await readInstalled(dir)).plugins["fixture-mixer"];
        expect(after).toMatchObject({ version: "1.0.0", failed: "1.1.0" });
        expect(after?.previous).toBeUndefined();
        expect(existsSync(packageDir(dir, "fixture-mixer", "1.1.0"))).toBe(false);
        // Nothing left to go back to.
        expect(await rollbackPlugin(dir, "fixture-mixer")).toBeNull();
    });

    it("keeps one earlier version only", async () => {
        const dir = await tempDir();
        const table: Record<string, Uint8Array> = {};
        const base = { dir, platform: "linux-x64" as const, appVersion: "0.1.90", accepted: ["usb", "polaris-actions"] as const, fetcher: fakeFetch(table) };
        for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
            const bytes = fixturePackage({ version });
            table[PACKAGE_URL] = bytes;
            expect((await installPlugin({ ...base, entry: entryFor(bytes, { version }) })).ok).toBe(true);
        }
        expect(existsSync(packageDir(dir, "fixture-mixer", "1.0.0"))).toBe(false);
        expect(existsSync(packageDir(dir, "fixture-mixer", "1.1.0"))).toBe(true);
        expect(existsSync(packageDir(dir, "fixture-mixer", "1.2.0"))).toBe(true);
    });

    it("reads an installed.json written before updates were kept", async () => {
        const dir = await tempDir();
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(dir, "installed.json"), JSON.stringify({ schema: 1, plugins: { "fixture-mixer": { version: "1.0.0", enabled: true, granted: ["usb"], installedAt: "2026-11-20T00:00:00.000Z" } } }));
        expect((await readInstalled(dir)).plugins["fixture-mixer"]?.version).toBe("1.0.0");
    });
});

/** A manager over a catalog that can be replaced, and plugin processes the test speaks for. */
async function setup() {
    const dir = await tempDir();
    const table: Record<string, Uint8Array | string> = {};
    let issued = 0;
    const publish = (entry: PluginEntry, bytes: Uint8Array) => {
        issued += 1;
        const catalogBytes = new TextEncoder().encode(JSON.stringify(catalogOf([entry], `2026-11-2${issued}T00:00:00.000Z`)));
        table[CATALOG] = catalogBytes;
        table[`${CATALOG}.sig`] = sign(catalogBytes);
        table[PACKAGE_URL] = bytes;
    };
    const news: UpdateNews[] = [];
    const children: { path: string; speak: (message: unknown) => void; exit: () => void; }[] = [];
    let failing: string | null = null;
    const manager = createPluginManager({
        dir,
        platform: "linux-x64",
        appVersion: "0.1.90",
        fetcher: fakeFetch(table),
        keys: TEST_KEYS,
        fork: (wanted): PluginChild => {
            if (failing && wanted.manifest.version === failing) throw new Error("does not start");
            let listener: (message: unknown) => void = () => undefined;
            let exited: () => void = () => undefined;
            children.push({ path: wanted.entryPath, speak: (message) => listener(message), exit: () => exited() });
            return {
                postMessage: () => undefined,
                kill: () => undefined,
                onMessage: (heard) => {
                    listener = heard;
                },
                onExit: (heard) => {
                    exited = heard as () => void;
                }
            };
        },
        call: async () => null,
        devices: () => [DEVICE],
        notify: (_id, item) => news.push(item),
        later: () => () => undefined,
        restartTimer: (run) => {
            queueMicrotask(run);
            return 0;
        }
    });
    const first = fixturePackage();
    publish(entryFor(first), first);
    await manager.refresh();
    expect(await manager.install("fixture-mixer", ["usb", "polaris-actions"])).toEqual({ ok: true, started: true });
    return {
        dir,
        manager,
        news,
        children,
        failVersion: (version: string) => {
            failing = version;
        },
        release(version: string, entry: Partial<PluginEntry> = {}) {
            const bytes = fixturePackage({ version, ...(entry.permissions ? { permissions: entry.permissions } : {}) });
            publish(entryFor(bytes, { version, changelog: "- Brighter lights", ...entry }), bytes);
        }
    };
}

const installedVersion = async (dir: string) => (await readInstalled(dir)).plugins["fixture-mixer"]?.version;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("updates in the manager", () => {
    it("puts a newer version in by itself and says so once", async () => {
        const { dir, manager, news, release } = await setup();
        release("1.1.0");
        await manager.checkUpdates();
        expect(await installedVersion(dir)).toBe("1.1.0");
        await manager.checkUpdates();
        await manager.checkUpdates();
        expect(news).toEqual([{ kind: "updated", name: "Fixture Mixer", version: "1.1.0", changelog: "- Brighter lights" }]);
    });

    it("does not announce a version the person put in themselves", async () => {
        const { manager, news, release } = await setup();
        await manager.setAutoUpdate(null, false);
        news.splice(0);
        release("1.1.0");
        await manager.refresh();
        // The refresh announced it as available; installing it is not announced again.
        expect(news.map((item) => item.kind)).toEqual(["available"]);
        expect(await manager.install("fixture-mixer", ["usb", "polaris-actions"])).toEqual({ ok: true, started: true });
        await manager.checkUpdates();
        expect(news.map((item) => item.kind)).toEqual(["available"]);
    });

    it("holds a version that asks for a new permission until the person accepts it", async () => {
        const { dir, manager, news, release } = await setup();
        release("1.1.0", { permissions: ["usb", "polaris-actions", "network"] });
        await manager.checkUpdates();
        await manager.checkUpdates();
        expect(await installedVersion(dir)).toBe("1.0.0");
        expect(news).toEqual([{ kind: "consent", name: "Fixture Mixer", version: "1.1.0", added: ["network"] }]);
        const snapshot = await manager.snapshot();
        expect(snapshot.installed[0]).toMatchObject({ update: "1.1.0", consent: ["network"] });
        // Accepting only the old ones is refused; accepting all of them puts it in.
        expect(await manager.install("fixture-mixer", ["usb", "polaris-actions"])).toEqual({ ok: false, reason: "permissions" });
        expect(await manager.install("fixture-mixer", ["usb", "polaris-actions", "network"])).toEqual({ ok: true, started: true });
        expect((await readInstalled(dir)).plugins["fixture-mixer"]).toMatchObject({ version: "1.1.0", granted: ["usb", "polaris-actions", "network"] });
    });

    it("only offers it when automatic updates are off, for all or for the one", async () => {
        const { dir, manager, news, release } = await setup();
        expect((await manager.snapshot()).autoUpdate).toBe(true);
        await manager.setAutoUpdate("fixture-mixer", false);
        release("1.1.0");
        await manager.checkUpdates();
        expect(await installedVersion(dir)).toBe("1.0.0");
        expect(news.map((item) => item.kind)).toEqual(["available"]);
        expect((await manager.snapshot()).installed[0]).toMatchObject({ autoUpdate: false, update: "1.1.0" });
        // Back to following the setting for all, which is on.
        await manager.setAutoUpdate("fixture-mixer", null);
        expect(await installedVersion(dir)).toBe("1.1.0");
        expect(JSON.parse(await readFile(join(dir, "installed.json"), "utf8")).autoUpdate).toBeUndefined();
    });

    it("waits while the plugin is busy and updates once it is free", async () => {
        const { dir, manager, children, release } = await setup();
        const child = children[0]!;
        child.speak({ type: "ready" });
        child.speak({ type: "status", state: "busy" });
        release("1.1.0");
        await manager.checkUpdates();
        expect(await installedVersion(dir)).toBe("1.0.0");
        child.speak({ type: "status", state: "connected" });
        // The update the free status sets off runs on its own: wait for it, not a fixed 20 ms.
        for (let i = 0; i < 50 && (await installedVersion(dir)) !== "1.1.0"; i++) await settle();
        await manager.snapshot();
        expect(await installedVersion(dir)).toBe("1.1.0");
    });

    it("goes back to the earlier version when the new one keeps failing, and does not try it again", async () => {
        const { dir, manager, news, release, failVersion } = await setup();
        failVersion("1.1.0");
        release("1.1.0");
        await manager.checkUpdates();
        for (let i = 0; i < 20 && (await installedVersion(dir)) !== "1.0.0"; i++) await settle();
        expect(await installedVersion(dir)).toBe("1.0.0");
        expect(news.map((item) => item.kind)).toEqual(["updated", "rolled-back"]);
        expect((await manager.snapshot()).installed[0]).toMatchObject({ version: "1.0.0", failed: "1.1.0", update: "1.1.0" });
        await manager.checkUpdates();
        expect(await installedVersion(dir)).toBe("1.0.0");
    });

    it("fetches nothing on a scheduled look while nothing is installed", async () => {
        const dir = await tempDir();
        const fetched: string[] = [];
        const manager = createPluginManager({
            dir,
            platform: "linux-x64",
            appVersion: "0.1.90",
            fetcher: fakeFetch({}, fetched),
            keys: TEST_KEYS,
            fork: () => {
                throw new Error("no");
            },
            call: async () => null,
            devices: () => null
        });
        await manager.checkUpdates();
        expect(fetched).toEqual([]);
    });
});
