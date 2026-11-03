/**
 * The camera reads a frame again only when the scene changed, not for the
 * noise of a still one.
 */

import { describe, expect, it } from "vitest";
import { changed } from "@polaris-app/translate/src/screens/camera-mode";

describe("changed", () => {
    const still = new Uint8Array(256).fill(100);

    it("reads the first frame", () => {
        expect(changed(null, still)).toBe(true);
    });

    it("ignores noise across a still scene", () => {
        expect(changed(still, still.map((value, at) => value + (at % 2 ? 5 : -5)))).toBe(false);
        expect(changed(still, still.map((value, at) => (at < 2 ? 200 : value)))).toBe(false);
    });

    it("reads a frame where part of the scene moved", () => {
        expect(changed(still, still.map((value, at) => (at < 3 ? 200 : value)))).toBe(true);
    });
});
