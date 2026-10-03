/**
 * Files kept on this server while their NAS was away go back to it once it
 * answers - copied, read back and compared, repointed, and only then removed
 * from here.
 *
 * Each failure on the way must leave the file readable where its row points:
 * a storage still down, one that gives back different bytes, a file whose owner
 * deleted it meanwhile.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NAS = "018f2b7a-0000-7000-8000-0000000000d4";
const PATH = "attachments/channel-1/0f0e0d0c-0000-4000-8000-000000000001";

/** A disk in memory. `corrupt` hands back different bytes than it was given. */
function disk(options: { corrupt?: boolean } = {}) {
    const files = new Map<string, Uint8Array>();
    return {
        files,
        mkdir: vi.fn(async () => undefined),
        stat: vi.fn(async (path: string) => {
            const bytes = files.get(path);
            if (!bytes) throw new Error("not found");
            return { size: BigInt(bytes.length) };
        }),
        readStream: vi.fn(async (path: string) => {
            const bytes = files.get(path);
            if (!bytes) throw new Error("not found");
            const out = options.corrupt ? bytes.map((byte) => byte ^ 0xff) : bytes;
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(out);
                    controller.close();
                }
            });
        }),
        writeStream: vi.fn(async (path: string, body: ReadableStream<Uint8Array>) => {
            const bytes = new Uint8Array(await new Response(body).arrayBuffer());
            files.set(path, bytes);
            return { size: BigInt(bytes.length) };
        }),
        delete: vi.fn(async (path: string) => {
            files.delete(path);
        }),
        dispose: vi.fn(async () => undefined)
    };
}

let here = disk();
let nas: ReturnType<typeof disk> | null = disk();

type Ledger = {
    id: string;
    targetId: string;
    localFolder: string;
    path: string;
    movedAt: Date | null;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
};
let ledger: Ledger[];
/** The chat attachment rows, by path: which storage each one points at. */
let attachments: { path: string; connectionId: string | null }[];

const none = { updateMany: vi.fn(async () => ({ count: 0 })) };
const db = {
    storageConnection: { findUnique: vi.fn(async () => ({ id: NAS })) },
    storageFallbackFile: {
        findMany: vi.fn(async ({ where }: { where: { movedAt?: null | { lt: Date } } }) =>
            ledger.filter((row) =>
                where.movedAt === null
                    ? row.movedAt === null
                    : row.movedAt !== null && row.movedAt < where.movedAt!.lt
            )
        ),
        updateMany: vi.fn(
            async ({ where, data }: { where: { id: string; attempts: number }; data: unknown }) => {
                const row = ledger.find(
                    (one) => one.id === where.id && one.attempts === where.attempts && !one.movedAt
                );
                if (!row || !data) return { count: 0 };
                row.attempts += 1;
                return { count: 1 };
            }
        ),
        update: vi.fn(
            async ({
                where,
                data
            }: {
                where: { id: string };
                data: Omit<Partial<Ledger>, "attempts"> & { attempts?: { decrement: number } };
            }) => {
                const row = ledger.find((one) => one.id === where.id)!;
                const { attempts, ...rest } = data;
                Object.assign(row, rest);
                if (attempts) row.attempts -= attempts.decrement;
            }
        ),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
            ledger = ledger.filter((one) => one.id !== where.id);
        }),
        deleteMany: vi.fn(async () => ({ count: 0 }))
    },
    chatAttachment: {
        updateMany: vi.fn(
            async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Record<string, string>;
            }) => {
                if (!("path" in where)) return { count: 0 };
                const hits = attachments.filter(
                    (one) => one.path === where.path && one.connectionId === null
                );
                for (const hit of hits) hit.connectionId = data.connectionId!;
                return { count: hits.length };
            }
        )
    },
    chatUpload: none,
    chatScheduledFile: none,
    meetingAttachment: none,
    chatReportFile: none,
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(db)
};

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    driverForTarget: vi.fn(async (target: string) => {
        if (target === "local") return here;
        if (!nas) throw new Error("connect EHOSTUNREACH 10.0.1.129:445");
        return nas;
    })
}));

const { returnFallbackFiles } = await import("@/lib/storage-returns");

const BYTES = new TextEncoder().encode("a photo somebody sent while the NAS was away");

beforeEach(() => {
    vi.clearAllMocks();
    here = disk();
    nas = disk();
    here.files.set(PATH, BYTES);
    attachments = [{ path: PATH, connectionId: null }];
    ledger = [
        {
            id: "row-1",
            targetId: NAS,
            localFolder: "chat",
            path: PATH,
            movedAt: null,
            attempts: 0,
            lastError: null,
            createdAt: new Date(Date.now() - 60 * 60 * 1000)
        }
    ];
});

describe("taking a file back to its storage", () => {
    it("copies it, proves it, repoints its row, and removes this copy only later", async () => {
        const result = await returnFallbackFiles();

        expect(result).toMatchObject({ moved: 1, failed: 0 });
        expect(nas!.files.get(PATH)).toEqual(BYTES);
        expect(attachments[0]!.connectionId).toBe(NAS);
        expect(ledger[0]!.movedAt).toBeInstanceOf(Date);
        // Still here for a reader that loaded the old row a moment ago.
        expect(here.files.has(PATH)).toBe(true);

        // A later pass, once that window is over, removes this server's copy.
        ledger[0]!.movedAt = new Date(Date.now() - 60 * 60 * 1000);
        await returnFallbackFiles();
        expect(here.files.has(PATH)).toBe(false);
        expect(ledger).toHaveLength(0);
        expect(nas!.files.get(PATH)).toEqual(BYTES);
    });

    it("waits while the storage is still not answering", async () => {
        nas = null;
        const result = await returnFallbackFiles();
        expect(result).toMatchObject({ moved: 0 });
        expect(attachments[0]!.connectionId).toBeNull();
        expect(here.files.get(PATH)).toEqual(BYTES);
        expect(ledger[0]!.movedAt).toBeNull();
    });

    it("keeps the file here when the storage gives back different bytes", async () => {
        nas = disk({ corrupt: true });
        const result = await returnFallbackFiles();
        expect(result).toMatchObject({ moved: 0, failed: 1 });
        expect(attachments[0]!.connectionId).toBeNull();
        expect(here.files.get(PATH)).toEqual(BYTES);
        // What it wrote there is not left behind.
        expect(nas.files.has(PATH)).toBe(false);
        expect(ledger[0]!.lastError).toMatch(/not what it was given/);
    });

    it("does not count a copy cut short by the storage going away against the file", async () => {
        nas!.writeStream.mockRejectedValueOnce(new Error("write ECONNRESET"));
        const result = await returnFallbackFiles();
        expect(result).toMatchObject({ moved: 0, failed: 0 });
        expect(ledger[0]!.attempts).toBe(0);
        expect(ledger[0]!.lastError).toMatch(/ECONNRESET/);
        expect(here.files.get(PATH)).toEqual(BYTES);
    });

    it("counts a copy that failed on its own merits", async () => {
        nas = disk({ corrupt: true });
        await returnFallbackFiles();
        expect(ledger[0]!.attempts).toBe(1);
    });

    it("drops a file whose owner deleted it meanwhile, leaving nothing on the storage", async () => {
        attachments = [];
        await returnFallbackFiles();
        expect(nas!.files.has(PATH)).toBe(false);
        expect(ledger).toHaveLength(0);
    });

    it("drops a file that is no longer here at all", async () => {
        here.files.clear();
        await returnFallbackFiles();
        expect(nas!.writeStream).not.toHaveBeenCalled();
        expect(ledger).toHaveLength(0);
    });

    it("resumes: a file already claimed by another runner is left to it", async () => {
        ledger[0]!.attempts = 1;
        const stale = { ...ledger[0]!, attempts: 0 };
        // The first read is the copies to remove (none), the second what waits.
        db.storageFallbackFile.findMany.mockImplementationOnce(async () => []);
        db.storageFallbackFile.findMany.mockImplementationOnce(async () => [stale]);
        await returnFallbackFiles();
        expect(nas!.writeStream).not.toHaveBeenCalled();
    });
});
