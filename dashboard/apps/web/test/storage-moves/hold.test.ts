/**
 * A world trim or a copy stops a server and reads or rewrites its volume; while
 * that runs, a storage move must not start on the same service, because it would
 * copy the volume and empty the original underneath the job.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/apps/install-copy-hold", () => ({ heldForCopy: () => false }));

const { holdStorage, releaseStorage, storageHeld } = await import("@/lib/storage-moves/hold");

describe("the storage hold", () => {
    it("holds a service until it is released", () => {
        holdStorage(["app-1"]);
        expect(storageHeld("app-1")).toBe(true);
        expect(storageHeld("app-2")).toBe(false);
        releaseStorage(["app-1"]);
        expect(storageHeld("app-1")).toBe(false);
    });

    it("keeps a service held until every hold on it is released", () => {
        holdStorage(["app-1"]);
        holdStorage(["app-1"]);
        releaseStorage(["app-1"]);
        expect(storageHeld("app-1")).toBe(true);
        releaseStorage(["app-1"]);
        expect(storageHeld("app-1")).toBe(false);
    });

    it("de-duplicates ids within one call", () => {
        holdStorage(["app-1", "app-1"]);
        releaseStorage(["app-1"]);
        expect(storageHeld("app-1")).toBe(false);
    });

    it("releasing an id that was never held is a no-op, not a crash", () => {
        expect(() => releaseStorage(["never-held"])).not.toThrow();
        expect(storageHeld("never-held")).toBe(false);
    });
});
