/**
 * The silence sweep's verdict: a quiet session is probed, and only one whose
 * terminal is gone is failed. A machine that cannot be asked gets a longer
 * allowance before it is written off.
 */

import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";

const HOUR = 60 * 60 * 1000;
const MAX = 6 * HOUR;

describe("what the silence sweep does with a quiet session", () => {
    it("keeps one whose terminal answers, however long it has been quiet", () => {
        expect(core.sweepVerdict("alive", 7 * HOUR, MAX)).toBe("keep");
        expect(core.sweepVerdict("alive", 30 * 24 * HOUR, MAX)).toBe("keep");
    });

    it("fails one whose terminal is gone", () => {
        expect(core.sweepVerdict("dead", 7 * HOUR, MAX)).toBe("fail");
    });

    it("waits out a machine that cannot be asked, up to four allowances", () => {
        expect(core.sweepVerdict("unreachable", 7 * HOUR, MAX)).toBe("keep");
        expect(core.sweepVerdict("unreachable", 24 * HOUR, MAX)).toBe("keep");
        expect(core.sweepVerdict("unreachable", 25 * HOUR, MAX)).toBe("fail");
    });
});
