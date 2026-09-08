/**
 * The click that does nothing.
 *
 * A tab open across an update holds action ids the server has never heard of, so
 * the next thing it asks for is refused. `runAction` catches that for the calls
 * that go through it, and the error boundaries catch the ones that reach them -
 * but a call site that awaits an action and reads its own result is covered by
 * neither. That is the worst version of it: no error, no boundary, no banner,
 * and a row that simply does not open when it is pressed. This is the net under
 * all of them, so it is tested through the request it really makes rather than
 * through a stubbed inner function.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let listener: ((event: { reason: unknown }) => void) | null = null;
let asked: string[] = [];

beforeEach(() => {
    listener = null;
    asked = [];
    vi.resetModules();
    vi.stubGlobal("window", {
        addEventListener: (name: string, handler: (event: { reason: unknown }) => void) => {
            if (name === "unhandledrejection") listener = handler;
        },
        removeEventListener: (name: string) => {
            if (name === "unhandledrejection") listener = null;
        }
    });
    vi.stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        return { ok: true, json: async () => ({ build: "the-new-one" }) } as unknown as Response;
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** The watcher, over a tab that was served a build it can be compared against. */
async function watching(): Promise<{ stop: () => void; moved: () => boolean }> {
    const module = await import("../../src/lib/new-build");
    module.rememberServedBuild("the-old-one");
    return { stop: module.watchForStaleFailures(), moved: module.newBuildReady };
}

/** A rejection nobody caught, as the browser hands it over. */
function rejects(reason: unknown): void {
    listener?.({ reason });
}

describe("a rejection nobody caught", () => {
    it("asks what is being served when it reads as a replaced build", async () => {
        const { stop, moved } = await watching();
        rejects(new Error('Failed to find Server Action "60c3e034acdd9a1c96ab"'));
        await vi.waitFor(() => {
            expect(asked).toEqual(["/api/version"]);
            // Awaited through the same wait: the request being made is not yet
            // the answer having come back.
            expect(moved()).toBe(true);
        });
        stop();
    });

    it("reads the other wording Next uses for a missing action", async () => {
        const { stop } = await watching();
        rejects(new Error('Server Action "abc" was not found on the server'));
        await vi.waitFor(() => expect(asked).toHaveLength(1));
        stop();
    });

    it("reads a chunk from a build that is gone", async () => {
        const { stop } = await watching();
        rejects(Object.assign(new Error("boom"), { name: "ChunkLoadError" }));
        await vi.waitFor(() => expect(asked).toHaveLength(1));
        stop();
    });

    // The narrowness is the point: a reload costs whatever is half-typed, and a
    // banner offered over a genuine bug is one people learn to dismiss.
    it("stays quiet for a failure that is not this", async () => {
        const { stop, moved } = await watching();
        rejects(new Error("Cannot read properties of undefined (reading 'length')"));
        rejects("a string nobody threw deliberately");
        rejects(null);
        expect(asked).toEqual([]);
        expect(moved()).toBe(false);
        stop();
    });

    it("stops listening once it is torn down", async () => {
        const { stop } = await watching();
        stop();
        rejects(new Error("Failed to find Server Action"));
        expect(asked).toEqual([]);
    });
});
