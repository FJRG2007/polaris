/**
 * The autosave a device may replay long after it was typed: it writes only over
 * the version the device saw, answers "stale" with where the note lives when
 * the note moved on elsewhere, and the copy kept beside it is made once however
 * often the write is replayed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; title: string; body: string; updatedAt: Date; spaceId: string | null; folderId: string | null; parentId: string | null; userId?: string };
let rows: Row[] = [];
let clock = Date.parse("2026-11-20T10:00:00.000Z");

vi.mock("@/lib/notes/link-service", () => ({ syncNoteLinks: async () => undefined }));
vi.mock("@polaris/db", () => ({
    prisma: {
        note: {
            updateMany: async (args: { where: { id: string; updatedAt?: { lte: Date } }; data: Partial<Row> }) => {
                const row = rows.find(
                    (entry) =>
                        entry.id === args.where.id &&
                        (!args.where.updatedAt || entry.updatedAt.getTime() <= args.where.updatedAt.lte.getTime())
                );
                if (!row) return { count: 0 };
                clock += 1_000;
                Object.assign(row, args.data, { updatedAt: new Date(clock) });
                return { count: 1 };
            },
            findUnique: async (args: { where: { id: string } }) => rows.find((entry) => entry.id === args.where.id) ?? null,
            create: async (args: { data: Row }) => {
                if (rows.some((entry) => entry.id === args.data.id))
                    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                rows.push({ ...args.data, updatedAt: new Date(clock) });
                return { id: args.data.id };
            }
        }
    }
}));

const { keepConflictCopy, saveNoteText } = await import("@/lib/notes/note-service");

const NOTE = "0190a1b2-c3d4-7e5f-8a9b-000000000001";
const COPY = "6f0c1a52-3d4e-4f60-8a71-000000000002";

beforeEach(() => {
    clock = Date.parse("2026-11-20T10:00:00.000Z");
    rows = [{ id: NOTE, title: "T", body: "<p>server</p>", updatedAt: new Date(clock), spaceId: "s1", folderId: null, parentId: null }];
});

describe("saving a note's text against the version a device saw", () => {
    it("writes over the version the device saw and answers the new one", async () => {
        const saved = await saveNoteText({ noteId: NOTE, title: "T", body: "<p>mine</p>" }, new Date("2026-11-20T10:00:00.000Z"));
        expect(saved).toEqual({ updatedAt: new Date(clock) });
        expect(rows[0]?.body).toBe("<p>mine</p>");
    });

    it("leaves an edit made elsewhere since alone and says where the note lives", async () => {
        rows[0]!.updatedAt = new Date("2026-11-20T10:30:00.000Z");
        const saved = await saveNoteText({ noteId: NOTE, title: "T", body: "<p>mine</p>" }, new Date("2026-11-20T10:00:00.000Z"));
        expect(saved).toEqual({ stale: { spaceId: "s1", folderId: null, parentId: null } });
        expect(rows[0]?.body).toBe("<p>server</p>");
    });

    it("writes regardless with no version, and answers null for a note that is gone", async () => {
        rows[0]!.updatedAt = new Date("2026-11-20T10:30:00.000Z");
        expect(await saveNoteText({ noteId: NOTE, title: "T", body: "<p>mine</p>" }, null)).toHaveProperty("updatedAt");
        expect(rows[0]?.body).toBe("<p>mine</p>");
        rows = [];
        expect(await saveNoteText({ noteId: NOTE, title: "T", body: "x" }, null)).toBeNull();
    });

    it("makes the copy once, however often the write is replayed", async () => {
        const placement = { spaceId: "s1", folderId: null, parentId: null };
        expect(await keepConflictCopy("u1", COPY, placement, { title: "T (offline copy)", body: "<p>mine</p>" })).toBe(COPY);
        expect(await keepConflictCopy("u1", COPY, placement, { title: "T (offline copy)", body: "<p>mine</p>" })).toBe(COPY);
        expect(rows.filter((row) => row.id === COPY)).toHaveLength(1);
        expect(rows.find((row) => row.id === COPY)).toMatchObject({ userId: "u1", spaceId: "s1", body: "<p>mine</p>" });
    });
});
