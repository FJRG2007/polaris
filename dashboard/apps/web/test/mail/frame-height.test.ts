/**
 * A message's frame follows the message, and stops when the message is only
 * following the frame.
 */

import { describe, expect, it } from "vitest";
import { nextFrameHeight } from "@/app/(app)/mail/message-body";

describe("nextFrameHeight", () => {
    it("fits the frame to what the message measures, with a margin", () => {
        expect(nextFrameHeight(240, 600)).toBe(608);
        expect(nextFrameHeight(608, 600)).toBe(608);
        expect(nextFrameHeight(508, 509)).toBe(517);
        expect(nextFrameHeight(508, 507.5)).toBe(508);
    });

    it("does not grow a message sized to the viewport it is drawn in", () => {
        // `min-height: 100vh` reports the frame's own height back, every time.
        let height = 240;
        for (let round = 0; round < 50; round += 1) height = nextFrameHeight(height, height);
        expect(height).toBe(240);
    });

    it("keeps to the floor and the ceiling", () => {
        expect(nextFrameHeight(240, 10)).toBe(120);
        expect(nextFrameHeight(240, 90_000)).toBe(20_000);
    });
});
