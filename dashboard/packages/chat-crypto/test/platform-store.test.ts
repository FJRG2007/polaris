/**
 * The device lock under an app's platform key store: the envelope on disk is
 * only ever the platform-sealed one, an existing plain record moves under the
 * wrap on its first read, and every way the platform store can fail - refused,
 * reset, another store, a copied profile - reads as "no device copy" rather
 * than an error or a key opened some other way.
 */

import "fake-indexeddb/auto";
import * as device from "../src/device-lock";
import { describe, expect, it } from "vitest";
import * as platform from "../src/platform-store";

const AK = new Uint8Array(32).map((_, index) => index + 1);

/** A stand-in for DPAPI / Keystore / Keychain: AES-GCM under a key the page never sees. */
async function fakeWrap(name = "test-store"): Promise<platform.PlatformKeyWrap & { reset(): Promise<void>; calls: string[] }> {
    let key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const calls: string[] = [];
    return {
        name,
        calls,
        async reset() {
            key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        },
        async seal(plain) {
            calls.push("seal");
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
            return new Uint8Array([...iv, ...sealed]);
        },
        async open(sealed) {
            calls.push("open");
            try {
                const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12) }, key, sealed.slice(12));
                return new Uint8Array(plain);
            } catch {
                return null;
            }
        }
    };
}

let next = 0;
function account(): string {
    next += 1;
    return `0190a1b2-0000-7000-8000-${String(next).padStart(12, "0")}`;
}

describe("platform-sealed device lock", () => {
    const inner = device.indexedDbDeviceLockStore();

    it("round-trips, and what the browser keeps is never the plain envelope", async () => {
        const wrap = await fakeWrap();
        const store = platform.platformSealedStore(inner, wrap);
        const userId = account();
        await device.createDeviceLock(store, userId, AK, 1);
        expect(await device.openDeviceLock(store, userId)).toEqual({ accountKey: AK, akVersion: 1 });
        // The raw record in IndexedDB does not open as a device lock: a copied
        // profile without the platform store gets nothing.
        await expect(device.openDeviceLock(inner, userId)).rejects.toThrow();
        const raw = (await inner.read(userId)) as (device.DeviceLockRecord & { platform?: string }) | null;
        expect(raw?.platform).toBe("test-store");
    });

    it("moves a record kept before the app offered a wrap under it on first read", async () => {
        const wrap = await fakeWrap();
        const userId = account();
        await device.createDeviceLock(inner, userId, AK, 2);
        const store = platform.platformSealedStore(inner, wrap);
        expect(await device.openDeviceLock(store, userId)).toEqual({ accountKey: AK, akVersion: 2 });
        expect(wrap.calls).toContain("seal");
        await expect(device.openDeviceLock(inner, userId)).rejects.toThrow();
        expect(await device.openDeviceLock(store, userId)).toEqual({ accountKey: AK, akVersion: 2 });
    });

    it("keeps a legacy record readable when the platform refuses to seal it", async () => {
        const userId = account();
        await device.createDeviceLock(inner, userId, AK, 1);
        const refusing: platform.PlatformKeyWrap = { name: "locked", seal: async () => null, open: async () => null };
        const store = platform.platformSealedStore(inner, refusing);
        expect(await device.openDeviceLock(store, userId)).toEqual({ accountKey: AK, akVersion: 1 });
        expect(await device.openDeviceLock(inner, userId)).toEqual({ accountKey: AK, akVersion: 1 });
    });

    it("refuses to write a plain envelope when the platform will not seal", async () => {
        const refusing: platform.PlatformKeyWrap = { name: "locked", seal: async () => null, open: async () => null };
        const store = platform.platformSealedStore(inner, refusing);
        const userId = account();
        await expect(device.createDeviceLock(store, userId, AK, 1)).rejects.toThrow();
        expect(await inner.read(userId)).toBeNull();
    });

    it("reads a reset platform store, another store or a throwing one as no device copy", async () => {
        const wrap = await fakeWrap();
        const store = platform.platformSealedStore(inner, wrap);
        const userId = account();
        await device.createDeviceLock(store, userId, AK, 1);

        const other = platform.platformSealedStore(inner, await fakeWrap("another-store"));
        expect(await device.openDeviceLock(other, userId)).toBeNull();

        const throwing: platform.PlatformKeyWrap = {
            name: "test-store",
            seal: async () => null,
            open: async () => {
                throw new Error("keychain locked");
            }
        };
        expect(await device.openDeviceLock(platform.platformSealedStore(inner, throwing), userId)).toBeNull();

        await wrap.reset();
        expect(await device.openDeviceLock(store, userId)).toBeNull();
    });

    it("never hands the platform more than one envelope's worth", async () => {
        const wrap = await fakeWrap();
        const store = platform.platformSealedStore(inner, wrap);
        const key = (await crypto.subtle.generateKey({ name: "HKDF" } as unknown as AesKeyGenParams, false, [
            "deriveKey"
        ]).catch(() => null)) as CryptoKey | null;
        const record = {
            key: key as CryptoKey,
            envelope: new Uint8Array(platform.PLATFORM_WRAP_MAX_BYTES + 1),
            akVersion: 1
        };
        await expect(store.write(account(), record)).rejects.toThrow(RangeError);
        expect(wrap.calls).not.toContain("seal");
    });

    it("forgets only the signed-out account", async () => {
        const store = platform.platformSealedStore(inner, await fakeWrap());
        const a = account();
        const b = account();
        await device.createDeviceLock(store, a, AK, 1);
        await device.createDeviceLock(store, b, AK, 1);
        await device.forgetDeviceLock(store, a);
        expect(await device.openDeviceLock(store, a)).toBeNull();
        expect(await device.openDeviceLock(store, b)).toEqual({ accountKey: AK, akVersion: 1 });
    });

    it("sign-out of all forgets every account's device lock and nothing else", async () => {
        const a = account();
        const b = account();
        await device.createDeviceLock(inner, a, AK, 1);
        await device.createDeviceLock(inner, b, AK, 1);
        const other = indexedDB.open("polaris-unrelated", 1);
        await new Promise((resolve) => (other.onsuccess = resolve));
        other.result.close();
        await device.forgetEveryDeviceLock();
        expect(await device.openDeviceLock(inner, a)).toBeNull();
        expect(await device.openDeviceLock(inner, b)).toBeNull();
        const names = (await indexedDB.databases()).map((info) => info.name);
        expect(names).toContain("polaris-unrelated");
        await expect(device.forgetEveryDeviceLock({} as IDBFactory)).resolves.toBeUndefined();
    });
});
