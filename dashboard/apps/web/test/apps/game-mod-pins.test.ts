/**
 * Which entries on a mod list can be out of date, and which cannot.
 *
 * The distinction is the whole feature. `grimac` takes whatever is newest at the
 * next restart, so it is never behind; `grimac:beta` says which builds count, which
 * is a rule and not a version. Only `grimac:2.3.73` is a pin, and only a pin can
 * fall behind. Marking every entry would tell somebody their server is stale when
 * it updates itself on every boot.
 */

import { describe, expect, it } from "vitest";
import { pinnedBuild, repinEntry } from "@/lib/apps/minecraft/modrinth";

describe("what an entry is nailed to", () => {
    it("finds a version", () => {
        expect(pinnedBuild("grimac:2.3.73")).toBe("2.3.73");
    });

    it("says nothing for one that follows the newest build", () => {
        expect(pinnedBuild("grimac")).toBeNull();
        expect(pinnedBuild("coreprotect?")).toBeNull();
    });

    it("does not mistake a release type for a version", () => {
        // These say which builds count, not which build to take.
        expect(pinnedBuild("bedwars1058:beta")).toBeNull();
        expect(pinnedBuild("geyser:alpha?")).toBeNull();
    });

    it("finds the version beside a release type", () => {
        expect(pinnedBuild("bedwars1058:beta:25.5")).toBe("25.5");
    });
});

describe("moving a pin", () => {
    it("keeps everything else about the entry", () => {
        expect(repinEntry("grimac:2.3.73", "2.3.74")).toBe("grimac:2.3.74");
        expect(repinEntry("bedwars1058:beta:25.5", "25.6")).toBe("bedwars1058:beta:25.6");
        // The trailing question mark is what makes an entry optional, and losing it
        // turns a plugin that may fail to install into one that stops the boot.
        expect(repinEntry("geyser:alpha:1.0?", "1.1")).toBe("geyser:alpha:1.1?");
    });

    it("pins one that was following the newest build", () => {
        expect(repinEntry("grimac", "2.3.74")).toBe("grimac:2.3.74");
    });
});
