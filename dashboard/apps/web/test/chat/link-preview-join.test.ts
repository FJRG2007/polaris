/**
 * Two asks for the same link at once share one look: the warm-up a send starts
 * and the reader's screen asking a second later must not fetch the page twice.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { joinLook } = await import("@/lib/chat/link-preview");

function gate() {
    let open!: () => void;
    const done = new Promise<void>((resolve) => (open = resolve));
    return { done, open };
}

describe("joinLook", () => {
    it("runs one look for two plain asks of the same address", async () => {
        const g = gate();
        const run = vi.fn(() => g.done);
        const first = joinLook("https://example.test/a", false, run);
        const second = joinLook("https://example.test/a", false, run);
        expect(run).toHaveBeenCalledTimes(1);
        g.open();
        await Promise.all([first, second]);
    });

    it("lets a plain ask wait on a forced look, never the other way round", async () => {
        const g = gate();
        const forced = vi.fn(() => g.done);
        const plain = vi.fn(async () => {});
        const a = joinLook("https://example.test/b", true, forced);
        const b = joinLook("https://example.test/b", false, plain);
        expect(plain).not.toHaveBeenCalled();
        g.open();
        await Promise.all([a, b]);

        const h = gate();
        const plainFirst = vi.fn(() => h.done);
        const forcedAfter = vi.fn(async () => {});
        const c = joinLook("https://example.test/c", false, plainFirst);
        const d = joinLook("https://example.test/c", true, forcedAfter);
        expect(forcedAfter).toHaveBeenCalledTimes(1);
        h.open();
        await Promise.all([c, d]);
    });

    it("looks again once the first look has finished or failed", async () => {
        const failing = vi.fn(async () => { throw new Error("site down"); });
        await expect(joinLook("https://example.test/d", false, failing)).rejects.toThrow("site down");
        const retry = vi.fn(async () => {});
        await joinLook("https://example.test/d", false, retry);
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it("keeps different addresses apart", async () => {
        const g = gate();
        const run = vi.fn(() => g.done);
        const a = joinLook("https://example.test/e", false, run);
        const b = joinLook("https://example.test/f", false, run);
        expect(run).toHaveBeenCalledTimes(2);
        g.open();
        await Promise.all([a, b]);
    });
});
