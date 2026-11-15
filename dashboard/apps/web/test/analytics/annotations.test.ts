/**
 * Chart notes: the input is normalized and bounded, a site holds at most
 * `ANNOTATION_CAP`, a delete only reaches the site's own notes, and each note
 * hangs on the chart point whose bucket holds it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const count = vi.fn(async (_args: unknown) => 0);
const create = vi.fn(async (args: { data: { at: Date; text: string } }) => ({ id: "n-1", at: args.data.at, text: args.data.text }));
const deleteMany = vi.fn(async (_args: unknown) => ({ count: 1 }));

vi.mock("@polaris/db", () => ({
    prisma: {
        analyticsAnnotation: {
            count: (args: unknown) => count(args),
            create: (args: { data: { at: Date; text: string } }) => create(args),
            deleteMany: (args: unknown) => deleteMany(args)
        }
    }
}));

const { ANNOTATION_CAP, annotationInputSchema, createAnnotation, deleteAnnotation } = await import("@/lib/analytics-annotations");
const { notesByPoint } = await import("@/app/(app)/analytics/analytics-format");

const at = Date.UTC(2026, 10, 10, 12);

beforeEach(() => {
    count.mockClear();
    create.mockClear();
    deleteMany.mockClear();
});

describe("the note input", () => {
    it("trims and collapses the text", () => {
        expect(annotationInputSchema.parse({ at, text: "  New   pricing\n page " })).toEqual({ at, text: "New pricing page" });
    });

    it("refuses an empty, an overlong or an undated note", () => {
        expect(annotationInputSchema.safeParse({ at, text: "   " }).success).toBe(false);
        expect(annotationInputSchema.safeParse({ at, text: "x".repeat(201) }).success).toBe(false);
        expect(annotationInputSchema.safeParse({ at: 12, text: "Launch" }).success).toBe(false);
    });
});

describe("storing notes", () => {
    it("adds a note while the site is under the cap", async () => {
        const note = await createAnnotation("site-1", "user-1", { at, text: "Launch" });
        expect(note).toEqual({ id: "n-1", at, text: "Launch" });
        expect(create.mock.calls[0]?.[0]).toMatchObject({ data: { siteId: "site-1", createdById: "user-1", text: "Launch" } });
    });

    it("refuses a note past the cap", async () => {
        count.mockResolvedValueOnce(ANNOTATION_CAP);
        expect(await createAnnotation("site-1", "user-1", { at, text: "Launch" })).toBeNull();
        expect(create).not.toHaveBeenCalled();
    });

    it("deletes only within the site", async () => {
        expect(await deleteAnnotation("site-1", "n-1")).toBe(true);
        expect(deleteMany).toHaveBeenCalledWith({ where: { id: "n-1", siteId: "site-1" } });
        deleteMany.mockResolvedValueOnce({ count: 0 });
        expect(await deleteAnnotation("site-1", "n-2")).toBe(false);
    });
});

describe("notes on the chart", () => {
    const day = 86_400_000;
    const points = [{ t: 0 }, { t: day }, { t: 2 * day }];

    it("hangs each note on the bucket it falls in, joining notes that share one", () => {
        const notes = notesByPoint(points, [
            { at: day + 1000, text: "Launch" },
            { at: day + 5000, text: "Ad campaign" },
            { at: 2 * day + 10, text: "Outage" },
            { at: -5, text: "Before the window" }
        ]);
        expect([...notes]).toEqual([
            [1, "Launch / Ad campaign"],
            [2, "Outage"]
        ]);
    });
});
