/**
 * What a photograph of somebody is sent as.
 *
 * The type comes from the browser, so it is narrowed rather than trusted: it is
 * passed on to a recognizer that may be one the house runs itself, and a service
 * handed WebP bytes labelled as a JPEG is entitled to refuse them - as is one
 * handed a type nobody has ever heard of.
 */

import { describe, expect, it } from "vitest";
import { FACE_EXTENSION, FACE_IMAGE_TYPES, faceImageType } from "@/lib/home/face-image";

describe("the type a face photograph is sent as", () => {
    it("keeps the three the recognizer reads", () => {
        expect(faceImageType("image/jpeg")).toBe("image/jpeg");
        expect(faceImageType("image/png")).toBe("image/png");
        expect(faceImageType("image/webp")).toBe("image/webp");
    });

    it("reads what a browser actually sends", () => {
        expect(faceImageType("IMAGE/WEBP")).toBe("image/webp");
        expect(faceImageType("image/jpeg; charset=binary")).toBe("image/jpeg");
    });

    it("falls back rather than passing on something invented", () => {
        expect(faceImageType(undefined)).toBe("image/jpeg");
        expect(faceImageType("")).toBe("image/jpeg");
        expect(faceImageType("application/x-msdownload")).toBe("image/jpeg");
        expect(faceImageType("image/heic")).toBe("image/jpeg");
    });

    it("has a name to send every one of them under", () => {
        for (const type of FACE_IMAGE_TYPES) expect(FACE_EXTENSION[type]).toMatch(/^\.[a-z]+$/);
    });
});
