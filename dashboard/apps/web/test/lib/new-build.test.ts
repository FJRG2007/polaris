/**
 * Noticing an update under an open tab.
 *
 * The rules worth pinning: a build with no stamp never announces anything (a
 * source build would otherwise claim an update on every poll), a check that
 * cannot reach the server is not evidence of one, and once a tab has seen a new
 * build it stays seen - a later answer from the container still serving the old
 * one must not take the banner away again.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Fresh module per test: the store is deliberately module-level, so the tab it
 *  stands for is one page load. */
async function load() {
    vi.resetModules();
    return import("@/lib/new-build");
}

function answering(...builds: (string | null)[]) {
    let call = 0;
    return vi.fn(async () => ({
        ok: true,
        json: async () => ({ build: builds[Math.min(call++, builds.length - 1)] })
    })) as unknown as typeof fetch;
}

describe("the tab noticing that the deployment moved", () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it("says nothing when the served build carries no stamp", async () => {
        const store = await load();
        const fetcher = answering("something-else");
        vi.stubGlobal("fetch", fetcher);

        store.rememberServedBuild(null);

        expect(await store.checkForNewBuild()).toBe(false);
        expect(store.newBuildReady()).toBe(false);
        // Not even asked: there is nothing to compare the answer against.
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("reports the same build as no change", async () => {
        const store = await load();
        vi.stubGlobal("fetch", answering("abc123"));

        store.rememberServedBuild("abc123");

        expect(await store.checkForNewBuild()).toBe(false);
        expect(store.newBuildReady()).toBe(false);
    });

    it("tells its listeners once the answer changes", async () => {
        const store = await load();
        vi.stubGlobal("fetch", answering("def456"));
        const listener = vi.fn();
        store.subscribeToBuild(listener);

        store.rememberServedBuild("abc123");

        expect(await store.checkForNewBuild()).toBe(true);
        expect(store.newBuildReady()).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("stays changed even if the next answer is the old build again", async () => {
        const store = await load();
        // A rollover serves both for a few seconds, so the next poll can land on the
        // container that is on its way out.
        vi.stubGlobal("fetch", answering("def456", "abc123"));

        store.rememberServedBuild("abc123");
        await store.checkForNewBuild();
        await store.checkForNewBuild();

        expect(store.newBuildReady()).toBe(true);
    });

    it("treats a check it could not make as no change", async () => {
        const store = await load();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("offline");
            })
        );

        store.rememberServedBuild("abc123");

        expect(await store.checkForNewBuild()).toBe(false);
        expect(store.newBuildReady()).toBe(false);
    });

    it("asks once for a burst of failures rather than once each", async () => {
        const store = await load();
        const fetcher = answering("def456");
        vi.stubGlobal("fetch", fetcher);

        store.rememberServedBuild("abc123");
        const [a, b, c] = await Promise.all([
            store.checkForNewBuild(),
            store.checkForNewBuild(),
            store.checkForNewBuild()
        ]);

        expect([a, b, c]).toEqual([true, true, true]);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});
