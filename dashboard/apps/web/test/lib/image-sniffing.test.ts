/**
 * Working out what an image is from its bytes.
 *
 * A content type is a claim, and plenty of hosts do not make it: Steam serves
 * most Workshop preview pictures as `application/octet-stream`, so the proxy that
 * only forwarded declared image types dropped nearly all of them and the mods
 * screen came up with no pictures on it.
 */

import { describe, expect, it } from "vitest";
import { imageTypeOfBytes } from "@/lib/mime";

const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const gif = () => Buffer.from("GIF89a....", "latin1");
const webp = () => Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1")]);

describe("imageTypeOfBytes", () => {
    it("reads each of the formats a preview can be", () => {
        expect(imageTypeOfBytes(png())).toBe("image/png");
        expect(imageTypeOfBytes(jpeg())).toBe("image/jpeg");
        expect(imageTypeOfBytes(gif())).toBe("image/gif");
        expect(imageTypeOfBytes(webp())).toBe("image/webp");
    });

    it("refuses something that is not an image, whatever it was called", () => {
        expect(imageTypeOfBytes(Buffer.from("<html><body>nope", "latin1"))).toBeUndefined();
        expect(imageTypeOfBytes(Buffer.alloc(0))).toBeUndefined();
    });

    it("refuses an SVG, which is a document that can carry script", () => {
        expect(imageTypeOfBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">', "latin1"))).toBeUndefined();
    });

    it("is not fooled by a RIFF container that is not WebP", () => {
        // A wav file starts the same way.
        const wav = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WAVE", "latin1")]);
        expect(imageTypeOfBytes(wav)).toBeUndefined();
    });
});
