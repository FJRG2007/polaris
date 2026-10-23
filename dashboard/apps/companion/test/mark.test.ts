/**
 * The Polaris mark button is a real PNG at Companion's button size.
 */

import { describe, expect, it } from "vitest";
import { POLARIS_MARK_PNG64 } from "../src/mark";

describe("the Polaris mark preset", () => {
    it("is a 72 by 72 PNG", () => {
        const png = Buffer.from(POLARIS_MARK_PNG64, "base64");
        expect(png.subarray(0, 8)).toEqual(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        );
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([72, 72]);
    });
});
