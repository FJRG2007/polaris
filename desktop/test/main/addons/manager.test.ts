import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createAddonManager } from "@/main/addons/manager";
import type { AddonChild } from "@/main/addons/supervisor";
import type { UsbDevice } from "@polaris/core/device-addons";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { listLinuxUsb, readUsbId } from "@/main/addons/presence";
import { catalogOf, entryFor, fakeFetch, fixturePackage, PACKAGE_URL, sign, TEST_KEYS } from "./fixtures";

const CATALOG = "https://github.com/FJRG2007/polaris/releases/download/device-addons/catalog.json";
const DEVICE: UsbDevice = { vendorId: 0x06f8, productId: 0xe053 };
const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "addons-manager-"));
    dirs.push(dir);
    return dir;
}
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
    const dir = await tempDir();
    const bytes = fixturePackage();
    const catalogBytes = new TextEncoder().encode(JSON.stringify(catalogOf([entryFor(bytes)])));
    const fetched: string[] = [];
    const fetcher = fakeFetch({ [CATALOG]: catalogBytes, [`${CATALOG}.sig`]: sign(catalogBytes), [PACKAGE_URL]: bytes }, fetched);
    let devices: UsbDevice[] | null = [];
    let deviceListBroken = false;
    const forks: string[] = [];
    const offers: string[] = [];
    const manager = createAddonManager({
        dir,
        platform: "linux-x64",
        appVersion: "0.1.73",
        fetcher,
        keys: TEST_KEYS,
        fork: (wanted): AddonChild => {
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

describe("add-on manager", () => {
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

    it("sleeps an installed add-on while its device is unplugged and wakes it on the plug", async () => {
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
        expect(JSON.parse(await readFile(join(dir, "installed.json"), "utf8")).addons["fixture-mixer"].version).toBe("1.0.0");
    });

    it("runs an installed add-on where devices cannot be listed, and stops it when disabled", async () => {
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
