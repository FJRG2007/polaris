/**
 * A service whose files are being copied cannot be started by anything - the
 * hold is asked by the deploy service, so every start path meets it - and the
 * hold lets go however the copy ends.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));

const { heldForCopy, holdWhileCopying, refuseWhileCopying } = await import("@/lib/apps/install-copy-hold");

describe("the copy hold", () => {
    it("refuses a start while the copy runs, and not after", async () => {
        let during: unknown = null;
        await holdWhileCopying(["source", "copy"], async () => {
            during = await refuseWhileCopying("source").catch((error: Error) => error.message);
            expect(heldForCopy("copy")).toBe(true);
            expect(heldForCopy("other")).toBe(false);
        });
        expect(during).toBe("errors.copying");
        await expect(refuseWhileCopying("source")).resolves.toBeUndefined();
        expect(heldForCopy("copy")).toBe(false);
    });

    it("lets go when the copy fails", async () => {
        await expect(
            holdWhileCopying(["source"], async () => {
                throw new Error("cp failed");
            })
        ).rejects.toThrow("cp failed");
        expect(heldForCopy("source")).toBe(false);
    });

    it("keeps a service held until every copy holding it is done", async () => {
        let release: () => void = () => undefined;
        const first = holdWhileCopying(["source"], () => new Promise<void>((resolve) => (release = resolve)));
        await holdWhileCopying(["source"], async () => undefined);
        expect(heldForCopy("source")).toBe(true);
        release();
        await first;
        expect(heldForCopy("source")).toBe(false);
    });
});
