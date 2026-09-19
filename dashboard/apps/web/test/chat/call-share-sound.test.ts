/**
 * Which sound a screen makes going up or coming down in a call.
 *
 * Everybody in the call hears it. What is pinned: only the picture counts (its
 * sound rides along and would chime a second time), and a screen taken down
 * because its sharer left is not announced over the leave sound.
 */

import { describe, expect, it } from "vitest";
import { SCREEN_SOURCE, shareSound } from "@/app/(app)/chat/call-share-sound";

describe("a screen going up or coming down", () => {
    it("sounds one way going up and the other coming down", () => {
        expect(shareSound({ source: SCREEN_SOURCE, published: true, stillHere: true })).toBe(
            "shareOn"
        );
        expect(shareSound({ source: SCREEN_SOURCE, published: false, stillHere: true })).toBe(
            "shareOff"
        );
    });

    it("says nothing for the screen's sound, a camera or a microphone", () => {
        for (const source of ["screen_share_audio", "camera", "microphone"]) {
            expect(shareSound({ source, published: true, stillHere: true })).toBeNull();
            expect(shareSound({ source, published: false, stillHere: true })).toBeNull();
        }
    });

    it("leaves a sharer walking out to the leave sound", () => {
        expect(
            shareSound({ source: SCREEN_SOURCE, published: false, stillHere: false })
        ).toBeNull();
    });
});
