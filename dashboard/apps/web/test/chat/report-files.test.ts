/**
 * What a report keeps, and what it must not cost.
 *
 * Two rules pull against each other here and both are load-bearing.
 *
 * A moderator has to see what was reported. The commonest report is about a
 * picture, and a queue that showed the words and not the picture was showing the
 * one thing nobody was objecting to.
 *
 * And a report must not double the storage. Copying every attachment somebody
 * objects to would quietly grow a second attachment store on an instance where a
 * lot gets reported - so the row points at the same file the message points at,
 * and the file only becomes the report's when the message is deleted. That
 * moment is where every interesting assertion below lives: it is a move, it
 * happens before the delete, and a file no report holds is not touched at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface AttachmentRow {
    id: string;
    name: string;
    size: bigint;
    contentType: string;
    connectionId: string | null;
    path: string;
    durationMs: number | null;
    waveform: string | null;
}

interface ReportFileRow {
    id: string;
    reportId: string;
    attachmentId: string | null;
    connectionId: string | null;
    path: string;
    held: boolean;
}

let attachments: AttachmentRow[] = [];
let reportFiles: ReportFileRow[] = [];
const created: unknown[] = [];
const updated: { id: string; data: Record<string, unknown> }[] = [];
const deleted: string[][] = [];

/** Where `holdFile` was asked to put things, and what it answered. */
const held: { path: string; folder: string; name: string }[] = [];
let holdWorks = true;
/** What the store answers for a file, and the report file row `findFirst` finds. */
let storedBytes = new Uint8Array([1, 2, 3]);
let firstRow: Record<string, unknown> | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        chatAttachment: {
            findMany: async ({ where }: { where: Record<string, unknown> }) => {
                if (where.message) return attachments.map((row) => ({ id: row.id }));
                return attachments;
            }
        },
        chatReportFile: {
            findMany: async ({ where }: { where: Record<string, unknown> }) => {
                const ids = (where.attachmentId as { in?: string[] } | undefined)?.in;
                return reportFiles.filter((row) => {
                    if (where.reportId && row.reportId !== where.reportId) return false;
                    if (where.held !== undefined && row.held !== where.held) return false;
                    if (ids && !ids.includes(row.attachmentId ?? "")) return false;
                    return true;
                });
            },
            findFirst: async () => firstRow,
            createMany: async ({ data }: { data: unknown[] }) => {
                created.push(...data);
                return { count: data.length };
            },
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: Record<string, unknown>;
            }) => {
                updated.push({ id: where.id, data });
                return {};
            },
            deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                deleted.push(where.id.in);
                return { count: where.id.in.length };
            }
        }
    }
}));

vi.mock("@/lib/chat/attachments", () => ({
    readStored: async () => storedBytes,
    discardEvidence: async () => undefined,
    holdFile: async (
        from: { connectionId: string | null; path: string },
        folder: string,
        name: string
    ) => {
        held.push({ path: from.path, folder, name });
        return holdWorks ? { connectionId: null, path: `polaris/chat-reports/${folder}/${name}` } : null;
    }
}));

const files = await import("../../src/lib/chat/report-files");

function attachment(id: string, path: string): AttachmentRow {
    return {
        id,
        name: `${id}.png`,
        size: 10n,
        contentType: "image/png",
        connectionId: null,
        path,
        durationMs: null,
        waveform: null
    };
}

beforeEach(() => {
    attachments = [];
    reportFiles = [];
    created.length = 0;
    updated.length = 0;
    deleted.length = 0;
    held.length = 0;
    holdWorks = true;
    storedBytes = new Uint8Array([1, 2, 3]);
    firstRow = null;
});

describe("a sealed file the reporter opened", () => {
    const sealedRef = async (id: string, clear: Uint8Array) => {
        const { sealFile } = await import("@polaris/chat-crypto/file-content");
        const { toText } = await import("@/lib/chat/e2ee/base64url");
        const made = await sealFile(clear);
        return {
            sealed: made.sealed,
            ref: { id, key: toText(made.key), sha256: toText(made.digest), name: "evidence.png", type: "image/png", size: clear.length, shape: { w: 4, h: 3, th: "AAAA" } }
        };
    };

    it("is copied under the name, type and shape its seal names, with the key that opens it", async () => {
        const clear = new TextEncoder().encode("the picture");
        const { ref } = await sealedRef("a1", clear);
        attachments = [{ ...attachment("a1", "polaris/chat/c1/one"), name: "file", contentType: "application/octet-stream", sealed: true } as AttachmentRow];
        await files.copyOntoReport("r1", "m1", [ref]);
        expect(created).toEqual([expect.objectContaining({ attachmentId: "a1", name: "evidence.png", contentType: "image/png", size: BigInt(clear.length), width: 4, height: 3, thumbhash: "AAAA" })]);
        const row = created[0] as { sealedKey: Uint8Array; sealedDigest: Uint8Array };
        expect(row.sealedKey).toHaveLength(32);
        expect(row.sealedDigest).toHaveLength(32);
    });

    it("without its key is copied as the sealed blob it is, and a plain file never takes a key", async () => {
        const { ref } = await sealedRef("a1", new Uint8Array([9]));
        attachments = [
            { ...attachment("a1", "polaris/chat/c1/one"), name: "file", contentType: "application/octet-stream", sealed: true } as AttachmentRow,
            { ...attachment("a2", "polaris/chat/c1/two"), sealed: false } as AttachmentRow
        ];
        await files.copyOntoReport("r1", "m1", [{ ...ref, id: "a2" }]);
        expect(created).toEqual([
            expect.objectContaining({ attachmentId: "a1", name: "file" }),
            expect.objectContaining({ attachmentId: "a2", name: "a2.png" })
        ]);
        for (const row of created) expect(row).not.toHaveProperty("sealedKey");
    });

    it("learns its key when it is reported again with one", async () => {
        const { ref } = await sealedRef("a1", new Uint8Array([9]));
        attachments = [{ ...attachment("a1", "polaris/chat/c1/one"), name: "file", sealed: true } as AttachmentRow];
        reportFiles = [{ id: "f1", reportId: "r1", attachmentId: "a1", connectionId: null, path: "polaris/chat/c1/one", held: false, sealedKey: null } as ReportFileRow];
        await files.copyOntoReport("r1", "m1", [ref]);
        expect(updated).toEqual([{ id: "f1", data: expect.objectContaining({ name: "evidence.png", contentType: "image/png" }) }]);
    });

    it("is read back opened, and bytes that do not open to it are gone", async () => {
        const clear = new TextEncoder().encode("the picture");
        const { ref, sealed } = await sealedRef("a1", clear);
        const { fromText } = await import("@/lib/chat/e2ee/base64url");
        firstRow = { name: "evidence.png", contentType: "image/png", connectionId: null, path: "p", sealedKey: fromText(ref.key), sealedDigest: fromText(ref.sha256) };
        storedBytes = sealed;
        expect(await files.readReportFile("r1", "f1")).toEqual({ name: "evidence.png", contentType: "image/png", bytes: clear });
        expect(await files.describeReportFile("r1", "f1")).toMatchObject({ sealed: true });
        const tampered = new Uint8Array(sealed);
        tampered[tampered.length - 1]! ^= 1;
        storedBytes = tampered;
        expect(await files.readReportFile("r1", "f1")).toBeNull();
    });
});

describe("copying a message's files onto a report", () => {
    it("writes a row per file, pointing at the file that is already there", async () => {
        attachments = [attachment("a1", "polaris/chat/c1/one")];
        await files.copyOntoReport("r1", "m1");

        // The same path. Nothing was written, nothing was read, and the report
        // costs a row rather than a second copy of the picture.
        expect(created).toEqual([
            {
                reportId: "r1",
                attachmentId: "a1",
                name: "a1.png",
                size: 10n,
                contentType: "image/png",
                connectionId: null,
                path: "polaris/chat/c1/one",
                durationMs: null,
                waveform: null
            }
        ]);
    });

    it("does not write a second row for a file it already has", async () => {
        attachments = [attachment("a1", "polaris/chat/c1/one")];
        reportFiles = [
            { id: "f1", reportId: "r1", attachmentId: "a1", connectionId: null, path: "p", held: false }
        ];
        await files.copyOntoReport("r1", "m1");

        // Pressing report twice is the same report updated, and the message may
        // not have changed at all.
        expect(created).toEqual([]);
    });

    it("drops a file an edit took off the message", async () => {
        attachments = [];
        reportFiles = [
            { id: "f1", reportId: "r1", attachmentId: "a1", connectionId: null, path: "p", held: false }
        ];
        await files.copyOntoReport("r1", "m1");

        expect(deleted).toEqual([["f1"]]);
    });

    it("keeps one whose bytes it already holds, however the message changed", async () => {
        attachments = [];
        reportFiles = [
            { id: "f1", reportId: "r1", attachmentId: null, connectionId: null, path: "p", held: true }
        ];
        await files.copyOntoReport("r1", "m1");

        // Once the bytes are the report's, they are the record - there is no
        // message left to compare them against.
        expect(deleted).toEqual([]);
    });
});

describe("rescuing what a report holds, before a message loses it", () => {
    it("moves the file and points the row at where it went", async () => {
        reportFiles = [
            {
                id: "f1",
                reportId: "r1",
                attachmentId: "a1",
                connectionId: null,
                path: "polaris/chat/c1/one",
                held: false
            }
        ];
        await files.keepForReports(["a1"]);

        expect(held).toEqual([{ path: "polaris/chat/c1/one", folder: "r1", name: "f1" }]);
        // Held, and no longer pointing at an attachment row that is about to
        // stop existing.
        expect(updated).toEqual([
            {
                id: "f1",
                data: {
                    connectionId: null,
                    path: "polaris/chat-reports/r1/f1",
                    held: true,
                    attachmentId: null
                }
            }
        ]);
    });

    it("touches nothing when no report holds the file", async () => {
        reportFiles = [];
        await files.keepForReports(["a1", "a2"]);

        // The ordinary case, which is every message anybody ever deletes. One
        // indexed lookup that finds nothing, and no storage is opened.
        expect(held).toEqual([]);
        expect(updated).toEqual([]);
    });

    it("leaves the row alone when the file could not be moved", async () => {
        holdWorks = false;
        reportFiles = [
            {
                id: "f1",
                reportId: "r1",
                attachmentId: "a1",
                connectionId: null,
                path: "polaris/chat/c1/one",
                held: false
            }
        ];
        await files.keepForReports(["a1"]);

        // A row still naming the old file at least says what was there. One
        // pointing at an address nothing was ever written to says nothing and
        // looks like it should work.
        expect(updated).toEqual([]);
    });

    it("does not move a file it has already moved", async () => {
        reportFiles = [
            {
                id: "f1",
                reportId: "r1",
                attachmentId: null,
                connectionId: null,
                path: "polaris/chat-reports/r1/f1",
                held: true
            }
        ];
        await files.keepForReports(["a1"]);

        expect(held).toEqual([]);
    });

    it("rescues everything in a conversation being deleted whole", async () => {
        attachments = [attachment("a1", "polaris/chat/c1/one")];
        reportFiles = [
            {
                id: "f1",
                reportId: "r1",
                attachmentId: "a1",
                connectionId: null,
                path: "polaris/chat/c1/one",
                held: false
            }
        ];
        await files.keepChannelForReports(["c1"]);

        // The channel folder is deleted recursively, so this has to have run
        // first or the evidence goes with the room.
        expect(held).toEqual([{ path: "polaris/chat/c1/one", folder: "r1", name: "f1" }]);
    });
});
