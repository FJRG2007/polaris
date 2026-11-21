/**
 * The once-per-server repair of chunk files an earlier optimizer left owned by
 * root (BUG-0009): which servers it asks, and the one command it runs.
 */

import { describe, expect, it } from "vitest";
import {
    levelFolder,
    ownersRepairDue,
    repairArgv,
    WORLD_OWNERS_KEY
} from "@polaris-app/game-servers/src/lib/minecraft/world-owner-repair";
import { WORLD_TRIM_RUN_KEY } from "@polaris-app/game-servers/src/lib/minecraft/world-trim";

const now = new Date("2026-11-22T12:00:00.000Z");
const trimmed = { [WORLD_TRIM_RUN_KEY]: { at: "2026-11-21T05:05:00.000Z", removed: 20678 } };

describe("which servers are asked", () => {
    it("checks every running server once", () => {
        expect(ownersRepairDue({}, true, now)).toBe("running");
        expect(ownersRepairDue({ [WORLD_OWNERS_KEY]: { at: now.toISOString(), ok: true } }, true, now)).toBeNull();
    });

    it("repairs a stopped server only when the optimizer ever ran on it", () => {
        expect(ownersRepairDue({}, false, now)).toBeNull();
        expect(ownersRepairDue(trimmed, false, now)).toBe("stopped");
    });

    it("waits before trying a failed server again", () => {
        const failed = { [WORLD_OWNERS_KEY]: { at: "2026-11-22T11:00:00.000Z", ok: false } };
        expect(ownersRepairDue(failed, true, now)).toBeNull();
        const old = { [WORLD_OWNERS_KEY]: { at: "2026-11-22T01:00:00.000Z", ok: false } };
        expect(ownersRepairDue(old, true, now)).toBe("running");
    });
});

describe("the command", () => {
    it("only reaches chunk files, never through a link, and fits the daemon's argv", () => {
        const argv = repairArgv("/data/world", "1000", "1000");
        expect(argv.slice(0, 6)).toEqual(["find", "/data/world", "-type", "f", "-name", "*.mca"]);
        expect(argv).toContain("*/region/*");
        expect(argv).toContain("*/entities/*");
        expect(argv).toContain("*/poi/*");
        expect(argv).not.toContain("-L");
        expect(argv.slice(-4)).toEqual(["chown", "1000:1000", "{}", "+"]);
        expect(argv.length).toBeLessThanOrEqual(29);
    });

    it("refuses a level name that points outside the data folder", () => {
        expect(levelFolder("../etc")).toBe("world");
        expect(levelFolder("a/b")).toBe("world");
        expect(levelFolder(null)).toBe("world");
        expect(levelFolder("Survival 2")).toBe("Survival 2");
    });
});
