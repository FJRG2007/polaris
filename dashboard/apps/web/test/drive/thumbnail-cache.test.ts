/**
 * What the grid costs on the second visit, and on the visits after a refusal.
 *
 * The rule the whole thumbnail path rests on is that an original is read at most
 * once, ever, and the two ways to break it are both here: a picture that is not
 * kept, and a refusal that is not kept. The second one is the expensive one -
 * the files that cannot be drawn are the files that cost the most to try.
 *
 * The last of these asserts the ceiling on how many originals are held in memory
 * at once, because a screenful of tiles asks in the same moment and the answer
 * used to be "all of them".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, Buffer>();
const asked: string[] = [];

vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => null) }));
vi.mock("@/lib/storage-service", () => ({ PERSONAL_LOCAL_FOLDER: "drive" }));
vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    resolveTargetChoice: vi.fn(async (value: string | null) => {
        asked.push(value ?? "auto");
        return { id: value ?? "auto", name: "This server", automatic: false };
    }),
    driverForTarget: vi.fn(async () => cache())
}));

import { collectStream, thumbnailFor, thumbnailKey, thumbnailPath } from "@/lib/drive-thumbnail";

/** The instance's own storage, in memory. */
function cache() {
    return {
        async stat(path: string) {
            const held = files.get(path);
            if (!held) throw new Error("no such file");
            return { kind: "file" as const, size: BigInt(held.byteLength) };
        },
        async readStream(path: string) {
            const held = files.get(path);
            if (!held) throw new Error("no such file");
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    if (held.byteLength > 0) controller.enqueue(new Uint8Array(held));
                    controller.close();
                }
            });
        },
        async writeStream(path: string, body: ReadableStream<Uint8Array>) {
            const written = await collectStream(body);
            files.set(path, written);
            return { kind: "file" as const, size: BigInt(written.byteLength) };
        },
        async mkdir() {},
        async dispose() {}
    };
}

/** A real one-pixel image, so the drawing half is the library rather than a
 *  stand-in for it. */
async function pixel(): Promise<Buffer> {
    const { default: sharp } = await import("sharp");
    return await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 90, b: 200 } }
    })
        .png()
        .toBuffer();
}

const keyFor = (name: string) => thumbnailKey("c1", name, new Date("2026-01-02T03:04:05Z"), 10n);

/** An ordinary drawing. Single-quoted inside, so the markup can be written
 *  plainly here. */
const DRAWING = Buffer.from(
    [
        "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'>",
        "<rect width='40' height='40' fill='#0099ff'/></svg>"
    ].join("")
);

/** The same file, with five levels of entities declared in terms of each other:
 *  a few hundred bytes that expand to something no machine finishes. */
const ENTITIES = Buffer.from(
    [
        "<?xml version='1.0'?>",
        "<!DOCTYPE svg [",
        "  <!ENTITY a 'aaaaaaaaaa'>",
        "  <!ENTITY b '&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;'>",
        "  <!ENTITY c '&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;'>",
        "  <!ENTITY d '&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;'>",
        "  <!ENTITY e '&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;'>",
        "]>",
        "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><text>&e;</text></svg>"
    ].join("\n")
);

/** One page with a line of text on it, which is what a contract is. */
const ONE_PAGE = Buffer.from(
    [
        "%PDF-1.4",
        "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
        // Split across lines only because a newline is whitespace to a PDF dict.
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R",
        "/Resources<</Font<</F1 5 0 R>>>>>>endobj",
        "4 0 obj<</Length 41>>stream",
        "BT /F1 24 Tf 20 100 Td (Hello) Tj ET",
        "endstream",
        "endobj",
        "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
        "trailer<</Root 1 0 R/Size 6>>",
        "%%EOF"
    ].join("\n"),
    "latin1"
);

describe("what the second visit costs", () => {
    beforeEach(() => {
        files.clear();
        asked.length = 0;
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps the picture, and does not open the original again", async () => {
        const key = keyFor("a.png");
        const original = await pixel();
        let opened = 0;
        const read = async () => {
            opened += 1;
            return original;
        };

        const first = await thumbnailFor("image", key, read);
        expect(first?.byteLength).toBeGreaterThan(0);
        expect(opened).toBe(1);

        const second = await thumbnailFor("image", key, read);
        expect(second).toEqual(first);
        expect(opened).toBe(1);
    });

    it("keeps the refusal too, so a file that cannot be drawn is tried once", async () => {
        const key = keyFor("lies.png");
        let opened = 0;
        const read = async () => {
            opened += 1;
            return Buffer.from("this is not an image");
        };

        expect(await thumbnailFor("image", key, read)).toBeNull();
        expect(opened).toBe(1);
        // An entry with nothing in it: the refusal itself, kept under the same
        // name the picture would have had.
        expect(files.get(thumbnailPath(key))?.byteLength).toBe(0);

        expect(await thumbnailFor("image", key, read)).toBeNull();
        expect(opened).toBe(1);
    });

    it("does not keep a drive that would not give the original up", async () => {
        const key = keyFor("unreachable.png");
        await expect(
            thumbnailFor("image", key, async () => {
                throw new Error("the share went away");
            })
        ).rejects.toThrow();
        // Nothing was decided about the file, so nothing is written down and the
        // next visit tries again.
        expect(files.has(thumbnailPath(key))).toBe(false);

        const drawn = await thumbnailFor("image", key, pixel);
        expect(drawn?.byteLength).toBeGreaterThan(0);
    });

    it("keeps its cache on this server when nobody has chosen a disk", async () => {
        await thumbnailFor("image", keyFor("b.png"), pixel);
        // Not the automatic rule the rest of the uploads follow: that one prefers
        // a NAS, which is a drive people browse.
        expect(asked.length).toBeGreaterThan(0);
        expect(new Set(asked)).toEqual(new Set(["local"]));
    });

    it("draws the first page of a document, and keeps that too", async () => {
        const key = keyFor("contract.pdf");
        let opened = 0;
        const read = async () => {
            opened += 1;
            return ONE_PAGE;
        };

        const drawn = await thumbnailFor("pdf", key, read);
        expect(drawn?.subarray(0, 4).toString("latin1")).toBe("RIFF");
        expect(await thumbnailFor("pdf", key, read)).toEqual(drawn);
        expect(opened).toBe(1);
    });

    it("keeps the refusal for a document that will not open", async () => {
        // An encrypted contract is the commonest of these, and the one that used
        // to be re-read in full on every visit.
        const key = keyFor("sealed.pdf");
        let opened = 0;
        const read = async () => {
            opened += 1;
            return Buffer.from("not a document at all");
        };

        expect(await thumbnailFor("pdf", key, read)).toBeNull();
        expect(await thumbnailFor("pdf", key, read)).toBeNull();
        expect(opened).toBe(1);
    });

    it("draws an ordinary drawing", async () => {
        const drawn = await thumbnailFor("image", keyFor("logo.svg"), async () => DRAWING);
        expect(drawn?.byteLength).toBeGreaterThan(0);
    });

    it("refuses a drawing that declares entities, before the rasteriser sees it", async () => {
        // Four hundred bytes anybody can upload. Handed to the image library it
        // holds a core and a gigabyte and does not come back, and nothing above
        // it can end that: the work is inside a native call.
        const started = Date.now();
        expect(await thumbnailFor("image", keyFor("bomb.svg"), async () => ENTITIES)).toBeNull();
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it("refuses one written in UTF-16, or with the declaration padded past the head", async () => {
        const wide = Buffer.from(ENTITIES.toString("latin1"), "utf16le");
        expect(await thumbnailFor("image", keyFor("wide.svg"), async () => wide)).toBeNull();

        const padded = Buffer.concat([Buffer.from(`<!--${"x".repeat(8192)}-->\n`), ENTITIES]);
        expect(await thumbnailFor("image", keyFor("padded.svg"), async () => padded)).toBeNull();
    });

    it("holds only a few originals at once, however many tiles ask", async () => {
        let open = 0;
        let peak = 0;
        const read = async () => {
            open += 1;
            peak = Math.max(peak, open);
            await new Promise((resume) => setTimeout(resume, 5));
            open -= 1;
            return Buffer.from("this is not an image");
        };

        const all = await Promise.all(
            Array.from({ length: 12 }, (_, at) => thumbnailFor("image", keyFor(`t${at}.png`), read))
        );
        expect(all.every((one) => one === null)).toBe(true);
        expect(peak).toBeLessThanOrEqual(3);
        expect(peak).toBeGreaterThan(1);
    });
});
