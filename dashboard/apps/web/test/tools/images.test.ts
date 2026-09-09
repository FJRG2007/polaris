import { describe, expect, it } from "vitest";
import { readImageFacts, transformImage } from "@/lib/tools/images";

/**
 * The picture tools, doing what they say.
 *
 * These are the jobs people currently hand their photos to a stranger's website
 * to do, which is the reason the app exists - so the bar is not "it returns
 * bytes", it is that the bytes are the format asked for, at the size asked for,
 * and that the two defaults which quietly matter hold: a photo does not come
 * back sideways, and its location does not travel unless somebody said so.
 *
 * The picture is generated rather than committed: a binary fixture is something
 * nobody can review, and everything asserted here is a property of the
 * transformation rather than of one particular photograph.
 */
describe("what Tools does to a picture", () => {
    /** A picture of a known size, in a known format. */
    const picture = async (width: number, height: number): Promise<Uint8Array> => {
        const { default: sharp } = await import("sharp");
        const data = await sharp({
            create: {
                width,
                height,
                channels: 3,
                background: { r: 20, g: 120, b: 200 }
            }
        })
            .png()
            .toBuffer();
        return new Uint8Array(data);
    };

    it("reads what a picture is before anything is done to it", async () => {
        const facts = await readImageFacts(await picture(320, 200));
        expect(facts.format).toBe("png");
        expect(facts.width).toBe(320);
        expect(facts.height).toBe(200);
        expect(facts.bytes).toBeGreaterThan(0);
        expect(facts.hasLocation).toBe(false);
    });

    it("refuses a file that is not a picture", async () => {
        // The screen says "that file is not a picture", and it can only say that
        // if this throws rather than answering something empty.
        await expect(readImageFacts(new TextEncoder().encode("hello"))).rejects.toThrow();
    });

    it.each([
        ["webp", [0x52, 0x49, 0x46, 0x46]],
        ["jpeg", [0xff, 0xd8, 0xff]],
        ["png", [0x89, 0x50, 0x4e, 0x47]]
    ] as const)("converts to %s, and the bytes really are %s", async (format, magic) => {
        const made = await transformImage(await picture(64, 64), {
            format,
            quality: 80,
            longestSide: null,
            keepMetadata: false
        });
        expect([...made.bytes.slice(0, magic.length)]).toEqual([...magic]);
    });

    it("resizes by the longest side, keeping the shape", async () => {
        const made = await transformImage(await picture(800, 400), {
            format: "webp",
            quality: 80,
            longestSide: 200,
            keepMetadata: false
        });
        expect(made.width).toBe(200);
        // 2:1 in, 2:1 out. Resizing into a box rather than to a box is the whole
        // difference between a smaller picture and a squashed one.
        expect(made.height).toBe(100);
    });

    it("leaves a picture that is already smaller alone", async () => {
        // Enlarging invents pixels and makes the file bigger for nothing, which
        // is the opposite of what somebody asking for a maximum size wants.
        const made = await transformImage(await picture(100, 50), {
            format: "webp",
            quality: 80,
            longestSide: 4000,
            keepMetadata: false
        });
        expect(made.width).toBe(100);
        expect(made.height).toBe(50);
    });

    it("drops the metadata unless it is asked to keep it", async () => {
        const { default: sharp } = await import("sharp");
        // A picture that knows when it was taken, the way a camera leaves it.
        const withExif = new Uint8Array(
            await sharp({
                create: { width: 40, height: 40, channels: 3, background: "#fff" }
            })
                .withExif({ IFD0: { Copyright: "Someone", Software: "Polaris" } })
                .jpeg()
                .toBuffer()
        );

        const stripped = await transformImage(withExif, {
            format: "jpeg",
            quality: 80,
            longestSide: null,
            keepMetadata: false
        });
        const kept = await transformImage(withExif, {
            format: "jpeg",
            quality: 80,
            longestSide: null,
            keepMetadata: true
        });

        const has = async (bytes: Uint8Array): Promise<boolean> =>
            Boolean((await sharp(bytes).metadata()).exif);
        expect(await has(stripped.bytes)).toBe(false);
        expect(await has(kept.bytes)).toBe(true);
    });

    it("makes a photograph smaller at a lower quality", async () => {
        // The point of the quality control. Asserted as an ordering rather than
        // a byte count, which depends on the encoder's version.
        const source = await picture(400, 400);
        const good = await transformImage(source, {
            format: "jpeg",
            quality: 92,
            longestSide: null,
            keepMetadata: false
        });
        const rough = await transformImage(source, {
            format: "jpeg",
            quality: 30,
            longestSide: null,
            keepMetadata: false
        });
        expect(rough.bytes.byteLength).toBeLessThan(good.bytes.byteLength);
    });
});
