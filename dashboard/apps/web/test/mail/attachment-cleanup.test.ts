/**
 * A file attached in the composer leaves storage when nothing needs it.
 *
 * A draft's upload rows cascade with the draft, but a row is not the file: the
 * bytes stayed on disk with nothing pointing at them after every send and every
 * discard. These pin the three ways out - removing one file, deleting a draft,
 * and the scheduled sweep of bytes no row names - and the one thing none of them
 * may do: delete a file a row still lists.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    draftId: string | null;
    connectionId: string | null;
    path: string;
    createdAt: Date;
}

const rows: Row[] = [];
const deleted: string[] = [];
const listing = new Map<string, { path: string; kind: "file" | "dir"; modifiedAt: Date }[]>();

function matches(row: Row, where: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(where)) {
        const held = row[key as keyof Row];
        if (value && typeof value === "object" && !(value instanceof Date)) {
            const test = value as { in?: unknown[]; notIn?: unknown[]; lt?: Date; not?: unknown };
            if (test.in && !test.in.includes(held)) return false;
            if (test.notIn && test.notIn.includes(held)) return false;
            if (test.lt && !((held as Date) < test.lt)) return false;
            if ("not" in test && held === test.not) return false;
        } else if (held !== value) return false;
    }
    return true;
}

vi.mock("@polaris/db", () => ({
    prisma: {
        mailUpload: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                rows.find((row) => matches(row, where)) ?? null,
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                rows.filter((row) => matches(row, where)),
            count: async ({ where }: { where: Record<string, unknown> }) =>
                rows.filter((row) => matches(row, where)).length,
            delete: async ({ where }: { where: { id: string } }) => {
                rows.splice(rows.findIndex((row) => row.id === where.id), 1);
            },
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                for (const row of rows.filter((one) => matches(one, where)))
                    rows.splice(rows.indexOf(row), 1);
            },
            updateMany: async () => ({ count: 0 })
        }
    }
}));

vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    placeFile: vi.fn(),
    resolveStorageTarget: async () => ({ id: "local", name: "This server", automatic: true }),
    driverForTarget: async () => ({
        delete: async (path: string) => {
            deleted.push(path);
        },
        list: async (path: string) => {
            const entries = listing.get(path);
            if (!entries) throw new Error("not found");
            return { entries };
        }
    })
}));

const uploads = await import("@/lib/mailbox/uploads");

const USER = "0190a3c4-0000-7000-8000-000000000001";
const OLD = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
const id = (n: number) => `0190a3c4-0000-7000-8000-${String(n).padStart(12, "0")}`;
const pathOf = (n: number) => `polaris/mail/${USER}/${id(n)}`;

function row(n: number, draftId: string | null, createdAt = OLD): Row {
    return { id: id(n), userId: USER, draftId, connectionId: null, path: pathOf(n), createdAt };
}

beforeEach(() => {
    rows.length = 0;
    deleted.length = 0;
    listing.clear();
});

describe("removing a file from the composer", () => {
    it("takes the row and the bytes", async () => {
        rows.push(row(1, null));
        await uploads.removeUpload(USER, id(1));
        expect(rows).toHaveLength(0);
        expect(deleted).toEqual([pathOf(1)]);
    });

    it("never reaches somebody else's upload", async () => {
        rows.push({ ...row(1, null), userId: "someone-else" });
        await uploads.removeUpload(USER, id(1));
        expect(rows).toHaveLength(1);
        expect(deleted).toEqual([]);
    });

    it("keeps the bytes while another row still names them", async () => {
        rows.push(row(1, "draft-a"), { ...row(1, "draft-b"), id: id(2) });
        await uploads.removeUpload(USER, id(1));
        expect(rows).toHaveLength(1);
        expect(deleted).toEqual([]);
    });
});

describe("deleting a draft", () => {
    it("releases its files and nobody else's", async () => {
        rows.push(row(1, "draft-a"), row(2, "draft-a"), row(3, "draft-b"));
        expect(await uploads.releaseDraftUploads(["draft-a"])).toBe(2);
        expect(rows.map((one) => one.id)).toEqual([id(3)]);
        expect(deleted.sort()).toEqual([pathOf(1), pathOf(2)]);
    });

    it("does nothing for no drafts", async () => {
        rows.push(row(1, "draft-a"));
        expect(await uploads.releaseDraftUploads([])).toBe(0);
        expect(rows).toHaveLength(1);
    });

    it("is called before every draft delete in the send and discard paths", async () => {
        const { readFile } = await import("node:fs/promises");
        const compose = await readFile(new URL("../../src/lib/mailbox/compose.ts", import.meta.url), "utf8");
        const deletes = compose.match(/prisma\.mailDraft\.delete(?:Many)?\(/g) ?? [];
        const releases = compose.match(/await releaseDraftUploads\(\[draft\.id\]\)/g) ?? [];
        expect(deletes.length).toBeGreaterThan(0);
        expect(releases.length).toBe(deletes.length);
        const delegate = await readFile(new URL("../../src/lib/mailbox/delegate-act.ts", import.meta.url), "utf8");
        expect(delegate).toContain("await releaseDraftUploads(doomed.map((draft) => draft.id));");
    });
});

describe("which stored files are loose", () => {
    const now = Date.now();

    it("is only old files no row names, in the shape uploads are written", () => {
        const files = [
            { path: pathOf(1), modifiedAt: OLD },
            { path: pathOf(2), modifiedAt: OLD },
            { path: pathOf(3), modifiedAt: new Date(now - 60_000) },
            { path: `polaris/mail/${USER}/notes.txt`, modifiedAt: OLD },
            { path: "polaris/drive/whatever", modifiedAt: OLD }
        ];
        expect(uploads.looseFiles(files, new Set([pathOf(2)]), now)).toEqual([pathOf(1)]);
    });

    it("is nothing on an empty disk", () => {
        expect(uploads.looseFiles([], new Set(), now)).toEqual([]);
    });
});

describe("the scheduled sweep", () => {
    it("deletes old unattached uploads and loose bytes, and never a draft's file", async () => {
        rows.push(row(1, null), row(2, "draft-a"), row(3, null, new Date()));
        listing.set("polaris/mail", [{ path: `polaris/mail/${USER}`, kind: "dir", modifiedAt: OLD }]);
        listing.set(`polaris/mail/${USER}`, [
            { path: pathOf(2), kind: "file", modifiedAt: OLD },
            { path: pathOf(3), kind: "file", modifiedAt: OLD },
            { path: pathOf(9), kind: "file", modifiedAt: OLD }
        ]);
        const swept = await uploads.sweepOrphanUploads();
        expect(rows.map((one) => one.id).sort()).toEqual([id(2), id(3)]);
        // Row 1 went with its bytes; 9 had no row at all; 2 is on a draft and 3
        // is a fresh upload nobody has saved yet.
        expect(deleted.sort()).toEqual([pathOf(1), pathOf(9)].sort());
        expect(swept).toBe(2);
    });

    it("survives a storage it cannot list", async () => {
        rows.push(row(2, "draft-a"));
        expect(await uploads.sweepOrphanUploads()).toBe(0);
        expect(deleted).toEqual([]);
    });
});
