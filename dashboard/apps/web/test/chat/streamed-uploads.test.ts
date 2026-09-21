/**
 * A file that reaches a conversation without passing through the dashboard.
 *
 * This is the half of the big-file change that is a decision rather than I/O: who
 * a staged file belongs to, what happens when a message names one that is not
 * theirs, what a cap does to a stream mid-flight, and what is left behind by
 * somebody who uploads and never sends.
 *
 * The reason it is pinned this hard is what the alternative was. An id in a form
 * field that nobody checked would let one account put another account's upload on
 * its own message; a claim that took what it could find would send three of four
 * files and say nothing about the fourth; and an upload nobody swept is the
 * operator's disk filling up with files that were never sent to anybody.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The staging table, as the module under test sees it. */
interface Row {
    id: string;
    userId: string;
    channelId: string;
    name: string;
    contentType: string;
    size: bigint;
    connectionId: string | null;
    path: string;
    spoiler: boolean;
    createdAt: Date;
}

let rows: Row[] = [];
/** Every file the storage was asked to delete. */
let deleted: string[] = [];
/** What was written, and what the storage says it kept. */
let written: { path: string; bytes: number }[] = [];

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const OTHER_CHANNEL = "22222222-2222-4222-8222-222222222222";

vi.mock("@polaris/db", () => ({
    prisma: {
        chatUpload: {
            create: async ({ data, select }: { data: Omit<Row, "id" | "createdAt">; select?: unknown }) => {
                // Uuid-shaped, because the module refuses anything else outright -
                // an id from a request is a uuid or it is nothing.
                const id = `44444444-4444-4444-8444-${String(rows.length + 1).padStart(12, "0")}`;
                const row: Row = { id, createdAt: new Date(), ...data };
                rows.push(row);
                void select;
                return row;
            },
            findMany: async ({ where, select }: { where: Record<string, unknown>; select?: unknown }) => {
                void select;
                return rows.filter((row) => matches(row, where));
            },
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                rows.find((row) => matches(row, where)) ?? null,
            delete: async ({ where }: { where: { id: string } }) => {
                rows = rows.filter((row) => row.id !== where.id);
                return null;
            },
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                const going = rows.filter((row) => matches(row, where));
                rows = rows.filter((row) => !going.includes(row));
                return { count: going.length };
            }
        }
    }
}));

/** Only the shapes the module actually queries with. */
function matches(row: Row, where: Record<string, unknown>): boolean {
    for (const [key, want] of Object.entries(where)) {
        if (key === "id" && typeof want === "object" && want !== null && "in" in want) {
            if (!(want as { in: string[] }).in.includes(row.id)) return false;
            continue;
        }
        if (key === "createdAt" && typeof want === "object" && want !== null && "lt" in want) {
            if (!(row.createdAt < (want as { lt: Date }).lt)) return false;
            continue;
        }
        if ((row as unknown as Record<string, unknown>)[key] !== want) return false;
    }
    return true;
}

vi.mock("@/lib/chat/attachments", () => ({
    chatTarget: async () => ({ id: "local", name: "this server", automatic: true })
}));

vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    streamFile: async (input: { path: string; body: ReadableStream<Uint8Array> }) => {
        // What the storage kept, counted the way a driver counts it: by reading
        // the stream it was handed. A cap that fails mid-way therefore fails here,
        // which is exactly what it does against a real driver.
        const reader = input.body.getReader();
        let bytes = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
        }
        written.push({ path: input.path, bytes });
        return { targetId: "local", size: bytes, fellBackFrom: null };
    },
    driverForTarget: async () => ({
        delete: async (path: string) => {
            deleted.push(path);
        },
        dispose: async () => undefined
    })
}));

const uploads = await import("@/lib/chat/uploads");
const { cappedStream, wasTooLarge } = await import("@/lib/stream-cap");

/** A body of `size` bytes, in chunks small enough that a cap has to act part-way
 *  through rather than on the first read. */
function body(size: number, chunk = 16): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (sent >= size) {
                controller.close();
                return;
            }
            const next = Math.min(chunk, size - sent);
            sent += next;
            controller.enqueue(new Uint8Array(next));
        }
    });
}

async function stage(over: Partial<Parameters<typeof uploads.stageUpload>[0]> = {}) {
    return uploads.stageUpload({
        userId: "ada",
        channelId: CHANNEL,
        name: "holiday.mp4",
        contentType: "video/mp4",
        spoiler: false,
        body: body(64),
        ...over
    });
}

beforeEach(() => {
    rows = [];
    deleted = [];
    written = [];
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("staging a file", () => {
    it("records what the storage kept, not what anybody claimed", async () => {
        const staged = await stage({ body: body(1024), declared: 10 });
        expect(staged.size).toBe(1024);
        expect(written[0]!.bytes).toBe(1024);
    });

    it("puts it in the conversation's own folder, under a name of Polaris's", async () => {
        await stage({ name: "../../etc/passwd" });
        // The sender's name never reaches the path, and the folder is the one a
        // sent file lives in - so deleting the conversation takes this with it.
        expect(written[0]!.path.startsWith(`polaris/chat/${CHANNEL}/`)).toBe(true);
        expect(written[0]!.path).not.toContain("passwd");
        expect(rows[0]!.name).toBe("../../etc/passwd");
    });

    it("refuses a conversation id that is not one", async () => {
        await expect(stage({ channelId: "chat/../../etc" })).rejects.toThrow(uploads.UploadRefused);
        expect(written).toEqual([]);
    });

    it("keeps a name that is only whitespace from becoming nothing", async () => {
        await stage({ name: "   " });
        expect(rows[0]!.name).toBe("file");
    });
});

describe("the cap on a body nobody is holding", () => {
    it("fails the stream part-way rather than reading the rest of it", async () => {
        await expect(stage({ body: cappedStream(body(4096), 1024) })).rejects.toSatisfy(wasTooLarge);
        // What was read stopped at the limit: the sender is not made to finish
        // uploading a file that is already refused.
        expect(written).toEqual([]);
    });

    it("lets a file exactly at the limit through", async () => {
        const staged = await stage({ body: cappedStream(body(1024), 1024) });
        expect(staged.size).toBe(1024);
    });

    it("treats no limit as no limit, rather than as a limit of zero", async () => {
        // A cap of zero arriving from a setting that means "no limit" must not turn
        // every upload into a refusal of its first byte.
        const staged = await stage({ body: cappedStream(body(2048), 0) });
        expect(staged.size).toBe(2048);
    });
});

describe("claiming what a message names", () => {
    it("hands back the files in the order the message listed them", async () => {
        const one = await stage({ name: "one.png" });
        const two = await stage({ name: "two.png" });

        const claimed = await uploads.claimUploads("ada", CHANNEL, [two.id, one.id]);
        expect(claimed.map((file) => file.name)).toEqual(["two.png", "one.png"]);
        // Claimed once: the rows are gone, so a second send naming them cannot
        // put the same file on two messages.
        expect(rows).toEqual([]);
        await expect(uploads.claimUploads("ada", CHANNEL, [one.id])).rejects.toThrow(
            uploads.UploadRefused
        );
    });

    it("refuses somebody else's upload", async () => {
        const mine = await stage({ userId: "ada" });
        await expect(uploads.claimUploads("bo", CHANNEL, [mine.id])).rejects.toThrow(
            uploads.UploadRefused
        );
        // And leaves it staged: a refused claim is not a way to delete it either.
        expect(rows).toHaveLength(1);
    });

    it("refuses one staged into another conversation", async () => {
        const there = await stage({ channelId: OTHER_CHANNEL });
        await expect(uploads.claimUploads("ada", CHANNEL, [there.id])).rejects.toThrow(
            uploads.UploadRefused
        );
    });

    it("refuses the whole list when one of them is missing", async () => {
        const one = await stage();
        await expect(
            uploads.claimUploads("ada", CHANNEL, [one.id, "33333333-3333-4333-8333-333333333333"])
        ).rejects.toThrow(uploads.UploadRefused);
        // Nothing was claimed: a message with three of its four files, and nothing
        // said about the fourth, is worse than a message that did not send.
        expect(rows).toHaveLength(1);
    });

    it("refuses an id that is not an id, without asking the database", async () => {
        await expect(uploads.claimUploads("ada", CHANNEL, ["../../etc/passwd"])).rejects.toThrow(
            uploads.UploadRefused
        );
    });

    it("carries the cover the sender chose, and what the browser measured", async () => {
        const covered = await stage({ spoiler: true, name: "note.webm" });
        const claimed = await uploads.claimUploads(
            "ada",
            CHANNEL,
            [covered.id],
            [{ durationMs: 4200, waveform: "12345" }]
        );
        expect(claimed[0]!.spoiler).toBe(true);
        expect(claimed[0]!.durationMs).toBe(4200);
        expect(claimed[0]!.waveform).toBe("12345");
        expect(claimed[0]!.borrowed).toBe(false);
    });
});

describe("what nobody sent", () => {
    it("goes when the sender takes it back off, bytes and all", async () => {
        const staged = await stage();
        expect(await uploads.discardUpload("ada", staged.id)).toBe(true);
        expect(rows).toEqual([]);
        expect(deleted).toEqual([written[0]!.path]);
    });

    it("is not somebody else's to take off", async () => {
        const staged = await stage({ userId: "ada" });
        expect(await uploads.discardUpload("bo", staged.id)).toBe(false);
        expect(rows).toHaveLength(1);
        expect(deleted).toEqual([]);
    });

    it("is swept once it is old enough, and not before", async () => {
        const fresh = await stage({ name: "fresh.png" });
        const old = await stage({ name: "old.png" });
        rows = rows.map((row) =>
            row.id === old.id
                ? { ...row, createdAt: new Date(Date.now() - 2 * uploads.UPLOAD_TTL_MS) }
                : row
        );

        expect(await uploads.sweepUploads()).toEqual({ swept: 1 });
        expect(rows.map((row) => row.id)).toEqual([fresh.id]);
        expect(deleted).toHaveLength(1);
    });

    it("says nothing was there when nothing was", async () => {
        expect(await uploads.sweepUploads()).toEqual({ swept: 0 });
        expect(deleted).toEqual([]);
    });
});
