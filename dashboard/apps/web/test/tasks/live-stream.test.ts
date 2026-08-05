/**
 * The live channel end to end: a change published on the server turns into a
 * frame on a reader's connection, or does not.
 *
 * Exercised through the route handler rather than the bus, because the part that
 * matters is the filtering between them. A tab must be woken for work it can
 * see, left alone for a space it cannot, and left alone for its own writes -
 * that last one is what keeps an optimistic row from flickering when the action
 * that made it has already revalidated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const READER = { id: "u1", isAdmin: false, name: "Reader" };

const resolveSession = vi.fn(async () => READER as unknown);
const sessionCan = vi.fn(async () => true);
const visibleScope = vi.fn(async () => ({
    spaceIds: ["visible"],
    partialSpaceIds: [] as string[],
    folderRoles: {},
    listIds: [] as string[],
    partialRoles: {}
}));

vi.mock("../../src/lib/session", () => ({ resolveSession, sessionCan }));
vi.mock("../../src/lib/tasks/access", () => ({ visibleScope }));

const { GET } = await import("../../src/app/api/tasks/stream/route");
const { publishTaskChange } = await import("../../src/lib/tasks/live");

/** Longer than the route's coalescing window, so a frame that is coming has
 *  arrived and one that is not has had its chance. */
const SETTLE_MS = 700;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Open a connection and collect what it writes until it is closed. */
async function listen(): Promise<{ frames: () => string[]; close: () => void }> {
    const controller = new AbortController();
    const response = await GET(new Request("http://polaris.test/api/tasks/stream", { signal: controller.signal }));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];

    void (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                seen.push(decoder.decode(value));
            }
        } catch {
            // Aborting the request is how the test ends; the read rejecting is
            // that, not a failure.
        }
    })();

    // Let the opening comment and the first scope resolution land.
    await wait(50);
    return {
        // Comment frames are keep-alive, not messages: only `data:` wakes a tab.
        frames: () => seen.filter((frame) => frame.startsWith("data:")),
        close: () => controller.abort()
    };
}

describe("the tasks live stream", () => {
    beforeEach(() => {
        resolveSession.mockResolvedValue(READER);
        sessionCan.mockResolvedValue(true);
    });

    afterEach(() => vi.clearAllMocks());

    it("refuses a request with no session, so the browser stops retrying", async () => {
        resolveSession.mockResolvedValue(null);

        const response = await GET(new Request("http://polaris.test/api/tasks/stream"));

        expect(response.status).toBe(401);
    });

    it("refuses somebody the Tasks app is not available to", async () => {
        sessionCan.mockResolvedValue(false);

        const response = await GET(new Request("http://polaris.test/api/tasks/stream"));

        expect(response.status).toBe(403);
    });

    it("wakes the reader when work they can see moves", async () => {
        const connection = await listen();

        publishTaskChange({ spaceId: "visible", actorId: "somebody-else" });
        await wait(SETTLE_MS);
        connection.close();

        expect(connection.frames()).toHaveLength(1);
        expect(connection.frames()[0]).toContain("seq");
    });

    it("says nothing about a space the reader cannot see", async () => {
        const connection = await listen();

        publishTaskChange({ spaceId: "somebody-elses-space", actorId: "somebody-else" });
        await wait(SETTLE_MS);
        connection.close();

        expect(connection.frames()).toEqual([]);
    });

    it("does not wake the reader for their own write", async () => {
        const connection = await listen();

        publishTaskChange({ spaceId: "visible", actorId: READER.id });
        await wait(SETTLE_MS);
        connection.close();

        expect(connection.frames()).toEqual([]);
    });

    it("gathers a burst into one frame rather than one per change", async () => {
        const connection = await listen();

        // What a drag across twenty rows, or a bulk edit, actually publishes.
        for (let index = 0; index < 20; index += 1) {
            publishTaskChange({ spaceId: "visible", actorId: "somebody-else" });
        }
        await wait(SETTLE_MS);
        connection.close();

        expect(connection.frames()).toHaveLength(1);
    });

    it("stops listening once the browser goes away", async () => {
        const connection = await listen();
        connection.close();
        await wait(50);

        publishTaskChange({ spaceId: "visible", actorId: "somebody-else" });
        await wait(SETTLE_MS);

        expect(connection.frames()).toEqual([]);
    });
});
