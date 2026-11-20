/**
 * Pictures sent before they were measured get their size and blur afterwards.
 *
 * The pass reads real pictures through the real image library, so what is held
 * here is what a reader will be shown: the size the picture is displayed at,
 * EXIF rotation applied, and a ThumbHash that decodes. And it is held to the
 * rules that make it safe to run on any schedule: only the rows it is meant to
 * touch, only while they are still unmeasured, a batch at a time.
 */

import sharp from "sharp";
import { isThumbHash } from "@/lib/chat/media-shape";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    connectionId: string | null;
    path: string;
    size: bigint;
    contentType: string;
    viewOnce: boolean;
    borrowed: boolean;
    width: number | null;
    height: number | null;
    thumbhash: string | null;
}

let rows: Row[] = [];
let stored = new Map<string, Uint8Array>();
let queries: Record<string, unknown>[] = [];
let writes: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];

vi.mock("@/lib/chat/attachments", () => ({
    readStored: async (_connection: string | null, path: string) => stored.get(path) ?? null
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatAttachment: {
            findMany: async ({
                where,
                take
            }: {
                where: {
                    width: null;
                    contentType: { startsWith: string };
                    viewOnce: boolean;
                    borrowed: boolean;
                    id?: { gt: string };
                };
                take: number;
            }) => {
                queries.push(where);
                return rows
                    .filter(
                        (row) =>
                            row.width === null &&
                            row.contentType.startsWith(where.contentType.startsWith) &&
                            row.viewOnce === where.viewOnce &&
                            row.borrowed === where.borrowed &&
                            (!where.id || row.id > where.id.gt)
                    )
                    .sort((a, b) => a.id.localeCompare(b.id))
                    .slice(0, take)
                    .map(({ id, connectionId, path, size }) => ({ id, connectionId, path, size }));
            },
            updateMany: async ({
                where,
                data
            }: {
                where: { id: string; width: null };
                data: Partial<Row>;
            }) => {
                writes.push({ where, data });
                const row = rows.find((one) => one.id === where.id && one.width === where.width);
                if (row) Object.assign(row, data);
                return { count: row ? 1 : 0 };
            }
        }
    }
}));

const { backfillMediaShapes, measureImage, resetBackfillCursor, BACKFILL_BATCH } = await import(
    "@/lib/chat/media-backfill"
);

async function picture(width: number, height: number, orientation?: number): Promise<Uint8Array> {
    const image = sharp({
        create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } }
    }).jpeg();
    return new Uint8Array(await (orientation ? image.withMetadata({ orientation }) : image).toBuffer());
}

function row(id: string, overrides: Partial<Row> = {}): Row {
    return {
        id,
        connectionId: null,
        path: `chat/c1/${id}`,
        size: 1000n,
        contentType: "image/jpeg",
        viewOnce: false,
        borrowed: false,
        width: null,
        height: null,
        thumbhash: null,
        ...overrides
    };
}

beforeEach(() => {
    rows = [];
    stored = new Map();
    queries = [];
    writes = [];
    resetBackfillCursor();
});

describe("measuring one picture", () => {
    it("answers the size it is shown at, with a blur that decodes", async () => {
        const shape = await measureImage(await picture(640, 360));
        expect(shape).toMatchObject({ width: 640, height: 360 });
        expect(shape?.thumbhash && isThumbHash(shape.thumbhash)).toBe(true);
    });

    it("turns a picture whose EXIF says it was taken on its side", async () => {
        expect(await measureImage(await picture(640, 360, 6))).toMatchObject({ width: 360, height: 640 });
    });

    it("answers nothing for bytes that are not a picture", async () => {
        expect(await measureImage(new TextEncoder().encode("not a picture"))).toBeNull();
    });
});

describe("the pass", () => {
    it("measures unmeasured pictures and leaves everything else alone", async () => {
        rows = [
            row("a"),
            row("b", { contentType: "video/mp4" }),
            row("c", { viewOnce: true }),
            row("d", { borrowed: true }),
            row("e", { width: 10, height: 10 })
        ];
        stored.set("chat/c1/a", await picture(300, 200));

        expect(await backfillMediaShapes()).toEqual({ measured: 1, unreadable: 0 });
        expect(rows[0]).toMatchObject({ width: 300, height: 200 });
        expect(rows[0]?.thumbhash).toBeTruthy();
        expect(rows.slice(1).map((one) => one.width)).toEqual([null, null, null, 10]);
        expect(queries[0]).toMatchObject({
            width: null,
            contentType: { startsWith: "image/" },
            viewOnce: false,
            borrowed: false
        });
    });

    it("writes only while the row is still unmeasured, so a second pass changes nothing", async () => {
        rows = [row("a")];
        stored.set("chat/c1/a", await picture(300, 200));
        await backfillMediaShapes();
        expect(writes[0]?.where).toEqual({ id: "a", width: null });

        writes = [];
        expect(await backfillMediaShapes()).toEqual({ measured: 0, unreadable: 0 });
        expect(writes).toEqual([]);
    });

    it("marks a file the image library cannot read with a width of 0, and does not read it again", async () => {
        rows = [row("a")];
        stored.set("chat/c1/a", new TextEncoder().encode("broken"));

        expect(await backfillMediaShapes()).toEqual({ measured: 0, unreadable: 1 });
        expect(rows[0]).toMatchObject({ width: 0, height: null, thumbhash: null });
        expect(await backfillMediaShapes()).toEqual({ measured: 0, unreadable: 0 });
    });

    it("leaves a file the storage could not hand over for a later pass", async () => {
        rows = [row("a")];
        expect(await backfillMediaShapes()).toEqual({ measured: 0, unreadable: 0 });
        expect(rows[0]?.width).toBeNull();
        expect(writes).toEqual([]);
    });

    it("walks in batches by id, each one after the last", async () => {
        const bytes = await picture(20, 10);
        rows = Array.from({ length: BACKFILL_BATCH + 3 }, (_, at) => row(`r${String(at).padStart(3, "0")}`));
        for (const one of rows) stored.set(one.path, bytes);

        expect(await backfillMediaShapes()).toEqual({ measured: BACKFILL_BATCH + 3, unreadable: 0 });
        expect(queries[0]?.id).toBeUndefined();
        expect(queries[1]?.id).toEqual({ gt: `r${String(BACKFILL_BATCH - 1).padStart(3, "0")}` });
        expect(rows.every((one) => one.width === 20)).toBe(true);
    });
});
