/**
 * Signing an account out of a browser retires its chat MLS device first, while
 * the session still stands: the server forgets it so every group drops its
 * leaf. A slow or failed request never holds the sign-out up.
 */

import "fake-indexeddb/auto";
import type { MlsBody } from "@/lib/chat/e2ee/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { retireBrowserDevice } = await import("@/lib/chat/e2ee/mls-browser");

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const kept = new Map<string, string>();

beforeEach(() => {
    kept.clear();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key)
    });
});

describe("retireBrowserDevice", () => {
    it("asks the server to retire this browser's device for the account", async () => {
        localStorage.setItem(`polaris-mls/device/${ACCOUNT}`, "browser-device-1");
        const sent: MlsBody[] = [];
        await retireBrowserDevice(ACCOUNT, 1_000, async (body) => (sent.push(body), { ok: true }));
        expect(sent).toEqual([{ op: "retire-device", device: "browser-device-1" }]);
    });

    it("sends nothing when the browser never opened a device for the account", async () => {
        const transport = vi.fn(async () => ({ ok: true }));
        await retireBrowserDevice(ACCOUNT, 1_000, transport);
        expect(transport).not.toHaveBeenCalled();
    });

    it("lets a refused or unanswered request go", async () => {
        localStorage.setItem(`polaris-mls/device/${ACCOUNT}`, "browser-device-1");
        await expect(retireBrowserDevice(ACCOUNT, 1_000, async () => Promise.reject(new Error("offline")))).resolves.toBeUndefined();
        const started = Date.now();
        await retireBrowserDevice(ACCOUNT, 20, () => new Promise(() => undefined));
        expect(Date.now() - started).toBeLessThan(1_000);
    });
});
