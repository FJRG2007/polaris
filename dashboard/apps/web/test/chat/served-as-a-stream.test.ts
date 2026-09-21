/**
 * Handing a conversation's file back without holding it.
 *
 * What used to happen: the route read the whole file into memory and sliced the
 * answer out of it, so dragging the bar of an hour-long recording read the whole
 * recording off the NAS for every drag - and a file bigger than the dashboard's
 * heap could not be served at all, which was half the reason the per-file limit
 * existed.
 *
 * Four things are pinned. The slice is taken by the storage. A storage that cannot
 * start part-way through a file answers with all of it rather than with a refusal,
 * because a player that gets everything plays and one that gets a 416 does not. A
 * range past the end is refused. And the storage session is given back exactly
 * once - held while the bytes are still leaving, released when they stop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What each opened driver was asked for, and whether it was let go of. */
interface Opened {
    readonly reads: { start?: number; end?: number }[];
    disposed: number;
}

let opened: Opened[] = [];
/** How many times the storage refused to open at all, from the front of the queue. */
let refuseOpens = 0;
/** Whether this storage can start part-way through a file. */
let randomRead = true;
/** What `stat` says, or null for "there is no such file". */
let stat: { kind: string; size: number } | null = { kind: "file", size: 1000 };

vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    driverForTarget: async () => {
        if (refuseOpens > 0) {
            refuseOpens -= 1;
            throw new Error("the share is not answering");
        }
        const mine: Opened = { reads: [], disposed: 0 };
        opened.push(mine);
        return {
            capabilities: { randomRead },
            stat: async () => {
                if (!stat) throw new Error("no such file");
                return stat;
            },
            readStream: async (_path: string, range?: { start: number; end: number }) => {
                mine.reads.push(range ?? {});
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array([1, 2, 3]));
                        controller.close();
                    }
                });
            },
            dispose: async () => {
                mine.disposed += 1;
            }
        };
    }
}));

const { streamStored, rangeHeaders } = await import("@/lib/chat/streamed-file");

const WHERE = { connectionId: null, path: "polaris/chat/c1/file" };

/** Read a body to the end, which is what a response does. */
async function drain(body: ReadableStream<Uint8Array>): Promise<number> {
    const reader = body.getReader();
    let bytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return bytes;
        bytes += value.byteLength;
    }
}

beforeEach(() => {
    opened = [];
    refuseOpens = 0;
    randomRead = true;
    stat = { kind: "file", size: 1000 };
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("a range request", () => {
    it("is taken by the storage rather than out of a copy of the file", async () => {
        const file = await streamStored(WHERE, "bytes=100-199", "a file");
        expect(file.ok).toBe(true);
        if (!file.ok) return;
        expect(opened[0]!.reads).toEqual([{ start: 100, end: 199 }]);
        expect(file.range).toEqual({ from: 100, to: 199 });
        expect(rangeHeaders(file)).toEqual({
            "Content-Range": "bytes 100-199/1000",
            "Content-Length": "100"
        });
    });

    it("answers the last bytes of a file, which is how an index is fetched", async () => {
        const file = await streamStored(WHERE, "bytes=-50", "a file");
        expect(file.ok).toBe(true);
        if (!file.ok) return;
        expect(file.range).toEqual({ from: 950, to: 999 });
    });

    it("is answered with the whole file where the storage cannot seek", async () => {
        randomRead = false;
        const file = await streamStored(WHERE, "bytes=100-199", "a file");
        expect(file.ok).toBe(true);
        if (!file.ok) return;
        // No range asked of the driver, and the response says so: a player that
        // asked for a slice and got everything plays.
        expect(opened[0]!.reads).toEqual([{}]);
        expect(file.range).toBeNull();
        expect(rangeHeaders(file)).toEqual({ "Content-Length": "1000" });
    });

    it("is refused when it starts past the end", async () => {
        expect(await streamStored(WHERE, "bytes=5000-", "a file")).toEqual({
            ok: false,
            why: "unsatisfiable"
        });
    });

    it("is ignored when it is unreadable, rather than failing the response", async () => {
        const file = await streamStored(WHERE, "bytes=nonsense", "a file");
        expect(file.ok).toBe(true);
        if (!file.ok) return;
        expect(file.range).toBeNull();
    });
});

describe("the storage session", () => {
    it("outlives the call and is given back when the bytes stop", async () => {
        const file = await streamStored(WHERE, null, "a file");
        expect(file.ok).toBe(true);
        if (!file.ok) return;
        // Still open: the bytes have not left yet, and disposing here is what used
        // to pull the session out from under the transfer.
        expect(opened[0]!.disposed).toBe(0);
        expect(await drain(file.body)).toBe(3);
        expect(opened[0]!.disposed).toBe(1);
    });

    it("is given back when the reader walks away part-way through", async () => {
        const file = await streamStored(WHERE, null, "a file");
        expect(file.ok).toBe(true);
        if (!file.ok) return;
        await file.body.cancel("the tab was closed");
        expect(opened[0]!.disposed).toBe(1);
    });

    it("is given back on every answer that is not a stream", async () => {
        stat = { kind: "folder", size: 0 };
        expect(await streamStored(WHERE, null, "a file")).toEqual({ ok: false, why: "gone" });
        expect(opened[0]!.disposed).toBe(1);
    });
});

describe("a storage that was busy", () => {
    it("is tried once more before the file is called gone", async () => {
        // A handle another request left open a second ago, a session just reaped, a
        // share reconnecting: one retry turns most of those into a pause nobody
        // notices.
        refuseOpens = 1;
        const file = await streamStored(WHERE, null, "a file");
        expect(file.ok).toBe(true);
        expect(opened).toHaveLength(1);
    });

    it("is not tried forever", async () => {
        refuseOpens = 5;
        expect(await streamStored(WHERE, null, "a file")).toEqual({ ok: false, why: "gone" });
        expect(opened).toHaveLength(0);
    });
});
