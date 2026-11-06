/**
 * A WebP or GIF face for a reader that only draws PNG and JPEG - the desktop
 * app's notices - is redrawn as a PNG; a browser still gets the photo as kept.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { avatarRendition } from "@/lib/avatar-rendition";

const NOTICE_ACCEPT = "image/png, image/jpeg";

describe("avatarRendition", () => {
    it("leaves a browser, or a reader that names no types, the stored photo", () => {
        expect(avatarRendition(null, "image/webp")).toBeNull();
        expect(avatarRendition("image/avif,image/webp,*/*;q=0.8", "image/webp")).toBeNull();
        expect(avatarRendition("image/*", "image/gif")).toBeNull();
    });

    it("leaves a photo the reader already takes as it is", () => {
        expect(avatarRendition(NOTICE_ACCEPT, "image/png")).toBeNull();
        expect(avatarRendition(NOTICE_ACCEPT, "image/jpeg")).toBeNull();
    });

    it("redraws a WebP or GIF for a reader that takes only PNG and JPEG", () => {
        expect(avatarRendition(NOTICE_ACCEPT, "image/webp")?.mime).toBe("image/png");
        expect(avatarRendition(NOTICE_ACCEPT, "image/gif")?.mime).toBe("image/png");
    });

    it("does not count a type the reader refuses with q=0", () => {
        expect(avatarRendition("image/png, image/webp;q=0", "image/webp")?.mime).toBe("image/png");
    });

    it("answers nothing it could not redraw rather than throwing", async () => {
        const rendition = avatarRendition(NOTICE_ACCEPT, "image/webp");
        expect(await rendition?.convert(Uint8Array.from([1, 2, 3]))).toBeNull();
    });

    it("turns a WebP into a PNG of notice size", async () => {
        const webp = await sharp({
            create: { width: 600, height: 400, channels: 3, background: { r: 200, g: 80, b: 40 } }
        })
            .webp()
            .toBuffer();
        const png = await avatarRendition(NOTICE_ACCEPT, "image/webp")?.convert(webp);
        expect(png).toBeTruthy();
        const meta = await sharp(png as Uint8Array).metadata();
        expect(meta.format).toBe("png");
        expect(meta.width).toBe(256);
        expect(meta.height).toBe(256);
    });
});
