/**
 * Which way round somebody's own picture is drawn.
 *
 * A camera pointed at a face sends a picture that is right for everybody
 * watching it and wrong for the person in it - they have spent their life
 * looking in mirrors, so their own tile unmirrored reads as somebody else
 * wearing their face. A camera pointed at the world is the opposite: mirrored,
 * a road sign in it reads backwards.
 *
 * So the default is read off the camera rather than asked for, and the one
 * honest gap - a capture card or a webcam pointed at a desk, which report
 * nothing and are treated as facing the reader - is what the manual choice is
 * for.
 */

import { describe, expect, it } from "vitest";
import { facesTheReader, mirrorsPicture } from "@/app/(app)/chat/call-mirror";

describe("which way a camera faces", () => {
    it("treats only the rear camera as pointed at the world", () => {
        expect(facesTheReader("environment")).toBe(false);
        expect(facesTheReader("user")).toBe(true);
    });

    // A desktop webcam reports nothing at all, and "a camera facing the person"
    // is the only kind a desktop has.
    it("treats a camera that says nothing as facing the reader", () => {
        expect(facesTheReader(undefined)).toBe(true);
        expect(facesTheReader(null)).toBe(true);
        expect(facesTheReader("")).toBe(true);
    });
});

describe("what gets drawn", () => {
    it("mirrors a webcam and a selfie camera by itself", () => {
        expect(mirrorsPicture("auto", undefined)).toBe(true);
        expect(mirrorsPicture("auto", "user")).toBe(true);
    });

    it("leaves a rear camera alone by itself", () => {
        expect(mirrorsPicture("auto", "environment")).toBe(false);
    });

    // The gap the choice exists for: a document camera reports nothing and would
    // otherwise be mirrored forever.
    it("lets the reader overrule it either way", () => {
        expect(mirrorsPicture("off", "user")).toBe(false);
        expect(mirrorsPicture("on", "environment")).toBe(true);
    });
});
