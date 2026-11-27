import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginManager } from "@/main/plugins/manager";
import type { PluginChild } from "@/main/plugins/supervisor";
import type { UsbDevice } from "@polaris/core/device-plugins";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { listLinuxUsb, readUsbId } from "@/main/plugins/presence";
import { catalogOf, entryFor, fakeFetch, fixturePackage, PACKAGE_URL, sign, TEST_KEYS } from "./fixtures";

// installed.json refused after `refuse.after` renames over it, as Windows answers a rename over an open file.
const refuse = vi.hoisted(() => ({ after: Number.POSITIVE_INFINITY, seen: 0 }));
vi.mock("node:fs/promises", async (original) => {
    const real = await original<typeof import("node:fs/promises")>();
    return {
        ...real,
        rename: (from: string, to: string) => {
            if (String(to).endsWith("installed.json") && ++refuse.seen > refuse.after) {
                return Promise.reject(Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }));
            }
            return real.rename(from, to);
        }
    };
});

const CATALOG = "https://github.com/FJRG2007/polaris/releases/download/device-plugins/catalog.json";
const DEVICE: UsbDevice = { vendorId: 0x06f8, productId: 0xe053 };
const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "plugins-manager-"));
    dirs.push(dir);
    return dir;
}
afterEach(async () => {
    refuse.after = Number.POSITIVE_INFINITY;
    refuse.seen = 0;
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(now?: () => number) {
    const dir = await tempDir();
    const bytes = fixturePackage();
    const catalogBytes = new TextEncoder().encode(JSON.stringify(catalogOf([entryFor(bytes)])));
    const fetched: string[] = [];
    // Kept by reference, so a test can publish a newer catalog or take it away.
    const table: Record<string, Uint8Array | string> = { [CATALOG]: catalogBytes, [`${CATALOG}.sig`]: sign(catalogBytes), [PACKAGE_URL]: bytes };
    const fetcher = fakeFetch(table, fetched);
    let devices: UsbDevice[] | null = [];
    let deviceListBroken = false;
    const forks: string[] = [];
    const offers: string[] = [];
    const manager = createPluginManager({
        dir,
        platform: "linux-x64",
        appVersion: "0.1.73",
        fetcher,
        keys: TEST_KEYS,
        ...(now ? { now } : {}),
        fork: (wanted): PluginChild => {
            forks.push(wanted.entryPath);
            return { postMessage: () => undefined, kill: () => undefined, onMessage: () => undefined, onExit: () => undefined };
        },
        call: async () => null,
        devices: () => {
            if (deviceListBroken) throw new Error("device list unavailable");
            return devices;
        },
        offer: (entry, name) => offers.push(`${entry.id}:${name}`)
    });
    return {
        manager,
        dir,
        bytes,
        table,
        fetched,
        forks,
        offers,
        plug: (next: UsbDevice[] | null) => {
            devices = next;
        },
        breakDeviceList: () => {
            deviceListBroken = true;
        }
    };
}

describe("plugin manager", () => {
    it("checking for updates says whether the list was reached, and shows a newer version at once", async () => {
        const { manager, bytes, table } = await setup();
        expect(await manager.refresh()).toBe("updated");
        expect(await manager.install("fixture-mixer", ["usb", "polaris-actions"])).toMatchObject({ ok: true });
        expect(await manager.setAutoUpdate(null, false)).toBe(true);
        expect(await manager.refresh()).toBe("unchanged");
        expect((await manager.snapshot()).installed[0]?.update).toBeNull();
        // Settle the look that read started behind it.
        await manager.refresh();

        const newer = new TextEncoder().encode(JSON.stringify(catalogOf([entryFor(bytes, { version: "1.0.1" })], "2026-11-21T00:00:00.000Z")));
        table[CATALOG] = newer;
        table[`${CATALOG}.sig`] = sign(newer);
        expect((await manager.snapshot()).installed[0]?.update).toBeNull();
        expect(await manager.refresh()).toBe("updated");
        expect((await manager.snapshot()).installed[0]?.update).toBe("1.0.1");

        delete table[CATALOG];
        expect(await manager.refresh()).toBe("failed");
    });

    it("opening the store draws the held list at once and brings a newer one behind it, without a restart", async () => {
        let clock = 1_000_000;
        const { manager, bytes, table, fetched } = await setup(() => clock);
        expect(await manager.refresh()).toBe("updated");
        expect(await manager.install("fixture-mixer", ["usb", "polaris-actions"])).toMatchObject({ ok: true });
        expect(await manager.setAutoUpdate(null, false)).toBe(true);

        // Published a minute later: well inside the hours the old schedule kept the list for.
        const newer = new TextEncoder().encode(JSON.stringify(catalogOf([entryFor(bytes, { version: "1.0.1" })], "2026-11-21T00:00:00.000Z")));
        table[CATALOG] = newer;
        table[`${CATALOG}.sig`] = sign(newer);
        clock += 60_000;
        expect((await manager.snapshot()).installed[0]?.update).toBeNull();
        await vi.waitFor(async () => expect((await manager.snapshot()).installed[0]?.update).toBe("1.0.1"));

        // A burst of reads (an install's progress, one screen) asks GitHub once.
        const looks = () => fetched.filter((url) => url === CATALOG).length;
        const before = looks();
        await manager.snapshot();
        await manager.snapshot();
        expect(looks()).toBe(before);
        clock += 30_000;
        await manager.snapshot();
        await vi.waitFor(() => expect(looks()).toBe(before + 1));
    });

    it("with nothing installed starts nothing and fetches nothing", async () => {
        const { manager, fetched, forks } = await setup();
        await manager.start();
        expect(fetched).toEqual([]);
        expect(forks).toEqual([]);
    });

    it("offers support once for a claimed device that is plugged in", async () => {
        const { manager, offers, fetched } = await setup();
        await manager.devicesChanged([DEVICE]);
        await manager.devicesChanged([DEVICE]);
        expect(offers).toEqual(["fixture-mixer:Fixture device"]);
        expect(fetched.filter((url) => url === PACKAGE_URL)).toEqual([]);
    });

    it("sleeps an installed plugin while its device is unplugged and wakes it on the plug", async () => {
        const { manager, forks, plug } = await setup();
        await manager.snapshot();
        await manager.refresh();
        expect(await manager.install("fixture-mixer", ["usb", "polaris-actions"])).toEqual({ ok: true, started: true });
        expect(forks).toEqual([]);
        expect((await manager.snapshot()).installed[0]?.run).toEqual({ state: "sleeping" });
        plug([DEVICE]);
        await manager.devicesChanged([DEVICE]);
        expect(forks).toHaveLength(1);
        expect((await manager.snapshot()).installed[0]?.run).toMatchObject({ state: "starting" });
        plug([]);
        await manager.devicesChanged([]);
        expect((await manager.snapshot()).installed[0]?.run).toEqual({ state: "sleeping" });
    });

    it("reports an install that went in as installed when starting it fails", async () => {
        const { manager, dir, breakDeviceList } = await setup();
        await manager.refresh();
        breakDeviceList();
        expect(await manager.install("fixture-mixer", ["usb", "polaris-actions"])).toEqual({ ok: true, started: false });
        expect(JSON.parse(await readFile(join(dir, "installed.json"), "utf8")).plugins["fixture-mixer"].version).toBe("1.0.0");
    });

    it("reports an install that went in as installed when writing it down afterwards keeps failing", async () => {
        const { manager, dir } = await setup();
        await manager.refresh();
        refuse.seen = 0;
        refuse.after = 1;
        expect(await manager.install("fixture-mixer", ["usb", "polaris-actions"])).toEqual({ ok: true, started: true });
        expect(JSON.parse(await readFile(join(dir, "installed.json"), "utf8")).plugins["fixture-mixer"].version).toBe("1.0.0");
    });

    it("runs an installed plugin where devices cannot be listed, and stops it when disabled", async () => {
        const { manager, forks, plug } = await setup();
        plug(null);
        await manager.refresh();
        await manager.install("fixture-mixer", ["usb", "polaris-actions"]);
        expect(forks).toHaveLength(1);
        await manager.setEnabled("fixture-mixer", false);
        expect((await manager.snapshot()).installed[0]?.run).toEqual({ state: "disabled" });
        expect(await manager.setSetting("fixture-mixer", "lights", false)).toEqual({ lights: false });
        expect(await manager.setSetting("fixture-mixer", "lights", "off")).toBeNull();
        await manager.uninstall("fixture-mixer");
        expect((await manager.snapshot()).installed).toEqual([]);
    });
});

describe("USB presence on Linux", () => {
    it("reads sysfs ids and skips interfaces", async () => {
        const root = await tempDir();
        await mkdir(join(root, "1-2"));
        await writeFile(join(root, "1-2", "idVendor"), "06f8\n");
        await writeFile(join(root, "1-2", "idProduct"), "e053\n");
        // An interface folder ("1-2:1.0" on Linux) holds no ids.
        await mkdir(join(root, "usb1-interface"));
        expect(listLinuxUsb(root)).toEqual([DEVICE]);
        expect(readUsbId("zzzz")).toBeNull();
        expect(listLinuxUsb(join(root, "missing"))).toEqual([]);
    });
});
