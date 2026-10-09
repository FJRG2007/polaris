/**
 * What an uploaded emoji really is, read from its bytes.
 *
 * The extension and the type the browser sent are the uploader's word for the
 * file; neither is trusted. The first bytes decide the format, the whole
 * picture is then decoded, and the frame count decides whether it takes a
 * still slot or an animated one.
 */

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { CUSTOM_EMOJI_MAX_BYTES } from "@polaris/core";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    placeFile: async () => ({ targetId: "local" }),
    driverForTarget: async () => null
}));
vi.mock("@/lib/chat/attachments", () => ({
    CHAT_LOCAL_FOLDER: "chat",
    chatTarget: async () => ({ id: "local" }),
    readStored: async () => null,
    removeStoredFiles: async () => undefined
}));

const { inspectEmojiFile } = await import("@/lib/chat/custom-emoji");

function square(red: number, side = 8): Promise<Buffer> {
    return sharp({
        create: {
            width: side,
            height: side,
            channels: 4,
            background: { r: red, g: 0, b: 0, alpha: 1 }
        }
    })
        .png()
        .toBuffer();
}

const bytes = (value: Buffer | string) =>
    new Uint8Array(typeof value === "string" ? Buffer.from(value) : value);

describe("an uploaded emoji", () => {
    it("is a still PNG, with its real size", async () => {
        const result = await inspectEmojiFile(bytes(await square(255, 64)));
        expect(result).toEqual({
            ok: true,
            mime: "image/png",
            animated: false,
            width: 64,
            height: 64
        });
    });

    it("is animated when a GIF has more than one frame, measured per frame", async () => {
        const gif = await sharp([await square(255), await square(0)], { join: { animated: true } })
            .gif()
            .toBuffer();
        const result = await inspectEmojiFile(bytes(gif));
        expect(result).toEqual({
            ok: true,
            mime: "image/gif",
            animated: true,
            width: 8,
            height: 8
        });
    });

    it("is still when a GIF has one frame", async () => {
        const gif = await sharp(await square(10))
            .gif()
            .toBuffer();
        const result = await inspectEmojiFile(bytes(gif));
        expect(result).toMatchObject({ ok: true, mime: "image/gif", animated: false });
    });

    it("takes JPEG and WEBP too", async () => {
        const jpeg = await sharp(await square(20))
            .jpeg()
            .toBuffer();
        const webp = await sharp(await square(30))
            .webp()
            .toBuffer();
        expect(await inspectEmojiFile(bytes(jpeg))).toMatchObject({ ok: true, mime: "image/jpeg" });
        expect(await inspectEmojiFile(bytes(webp))).toMatchObject({ ok: true, mime: "image/webp" });
    });
});

describe("a file that is refused", () => {
    it("is empty", async () => {
        expect(await inspectEmojiFile(new Uint8Array())).toEqual({ ok: false, problem: "empty" });
    });

    it("is over 256 KB, whatever it is", async () => {
        const big = new Uint8Array(CUSTOM_EMOJI_MAX_BYTES + 1);
        expect(await inspectEmojiFile(big)).toEqual({ ok: false, problem: "size" });
    });

    it("does not start like one of the four formats, whatever it is called", async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
        expect(await inspectEmojiFile(bytes(svg))).toEqual({ ok: false, problem: "type" });
        expect(await inspectEmojiFile(bytes("just some text pretending to be a .png"))).toEqual({
            ok: false,
            problem: "type"
        });
        const tiff = await sharp(await square(40))
            .toFormat("tiff")
            .toBuffer();
        expect(await inspectEmojiFile(bytes(tiff))).toEqual({ ok: false, problem: "type" });
    });

    it("has the right first bytes and nothing behind them", async () => {
        const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const fake = Buffer.concat([header, Buffer.from("not a picture at all")]);
        expect(await inspectEmojiFile(bytes(fake))).toEqual({ ok: false, problem: "unreadable" });
        expect(await inspectEmojiFile(bytes("GIF89a and then nothing"))).toEqual({
            ok: false,
            problem: "unreadable"
        });
    });

    it("is a real picture cut short", async () => {
        const whole = await square(50, 64);
        const cut = whole.subarray(0, Math.floor(whole.length / 2));
        expect(await inspectEmojiFile(bytes(cut))).toEqual({ ok: false, problem: "unreadable" });
    });

    it("is wider than 2048 pixels", async () => {
        const wide = await sharp({
            create: { width: 2049, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } }
        })
            .png()
            .toBuffer();
        expect(await inspectEmojiFile(bytes(wide))).toEqual({ ok: false, problem: "dimensions" });
    });

    it("packs more pixels across its frames than one is worth decoding", async () => {
        const frame = (red: number) =>
            sharp({
                create: {
                    width: 2048,
                    height: 2048,
                    channels: 3,
                    background: { r: red, g: 0, b: 0 }
                }
            })
                .png()
                .toBuffer();
        const gif = await sharp(await Promise.all([frame(0), frame(120), frame(240)]), {
            join: { animated: true }
        })
            .gif()
            .toBuffer();
        expect(gif.length).toBeLessThanOrEqual(CUSTOM_EMOJI_MAX_BYTES);
        expect(await inspectEmojiFile(bytes(gif))).toEqual({ ok: false, problem: "frames" });
    });

    it("is animated at full size within the budget", async () => {
        const frame = (red: number) =>
            sharp({
                create: {
                    width: 1024,
                    height: 1024,
                    channels: 3,
                    background: { r: red, g: 0, b: 0 }
                }
            })
                .png()
                .toBuffer();
        const gif = await sharp(await Promise.all([frame(0), frame(120)]), {
            join: { animated: true }
        })
            .gif()
            .toBuffer();
        expect(await inspectEmojiFile(bytes(gif))).toMatchObject({
            ok: true,
            animated: true,
            width: 1024
        });
    });
});
