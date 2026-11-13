import { describe, expect, it } from "vitest";
import type { Permission } from "@polaris/core";
import { SCOPE_GROUPS } from "@/lib/api-key-scopes";
import { levelOf, withLevel } from "@/lib/scope-levels";

const storage = SCOPE_GROUPS.find((group) => group.title === "Storage");
const levels = storage?.levels;
if (!levels) throw new Error("Storage has levels");

describe("scope levels", () => {
    it("read keys stored before levels existed as the level they amount to", () => {
        // Existing keys keep their stored scopes; the level is only how they read.
        const cases: [Permission[], string | null][] = [
            [[], "none"],
            [["connections.manage"], "none"],
            [["drive.read"], "read"],
            [["drive.read", "connections.manage"], "read"],
            [["drive.read", "drive.write", "drive.delete"], "write"],
            [["drive.read", "drive.write"], null]
        ];
        for (const [scopes, level] of cases) expect(levelOf(levels, scopes)).toBe(level);
    });

    it("sets one app's level and leaves every other scope alone", () => {
        const before: Permission[] = ["connections.manage", "tasks.read", "drive.read"];
        expect(withLevel(before, levels, "write").sort()).toEqual(
            ["connections.manage", "drive.delete", "drive.read", "drive.write", "tasks.read"].sort()
        );
        expect(withLevel(before, levels, "none").sort()).toEqual(
            ["connections.manage", "tasks.read"].sort()
        );
        expect(levelOf(levels, withLevel(before, levels, "read"))).toBe("read");
    });

    it("names only scopes of its own area, and every area's write covers its read", () => {
        for (const group of SCOPE_GROUPS) {
            if (!group.levels) continue;
            for (const scope of [...group.levels.read, ...group.levels.write])
                expect(group.scopes).toContain(scope);
            for (const scope of group.levels.read) expect(group.levels.write).toContain(scope);
        }
    });

    it("keeps every scope a key could carry in exactly one area", () => {
        const all = SCOPE_GROUPS.flatMap((group) => group.scopes);
        expect(new Set(all).size).toBe(all.length);
        expect(all).toContain("connections.manage");
        expect(all).toContain("drive.read");
    });
});
