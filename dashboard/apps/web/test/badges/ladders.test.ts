import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";

describe("badge ladders", () => {
    it("counts the thresholds reached, in order", () => {
        expect(core.levelFor([1, 10, 100], 0)).toBe(0);
        expect(core.levelFor([1, 10, 100], 10)).toBe(2);
        expect(core.levelFor([1, 10, 100], 1000)).toBe(3);
    });

    it("reports progress between the current level and the next", () => {
        expect(core.ladderProgress([10, 20], 15)).toEqual({
            value: 15,
            level: 1,
            top: 2,
            next: 20,
            fraction: 0.5
        });
        expect(core.ladderProgress([10, 20], 25)).toMatchObject({
            level: 2,
            next: null,
            fraction: 1
        });
        expect(core.ladderProgress([10, 20], -3)).toMatchObject({
            value: 0,
            level: 0,
            next: 10,
            fraction: 0
        });
        expect(core.ladderProgress([10, 20], Number.NaN)).toMatchObject({ value: 0 });
    });

    it("keeps every ladder between six and eight increasing levels", () => {
        for (const id of core.BADGE_LADDER_IDS) {
            const { thresholds } = core.BADGE_LADDERS[id];
            expect(thresholds.length).toBeGreaterThanOrEqual(6);
            expect(thresholds.length).toBeLessThanOrEqual(core.BADGE_LEVELS.length);
            expect([...thresholds].sort((a, b) => a - b)).toEqual([...thresholds]);
        }
    });

    it("names levels and parses keys", () => {
        expect(core.levelName(0)).toBeNull();
        expect(core.levelName(1)).toBe("spark");
        expect(core.parseBadgeKey("staff")).toEqual({ kind: "staff" });
        expect(core.parseBadgeKey("ladder:messages")).toEqual({ kind: "ladder", id: "messages" });
        expect(core.parseBadgeKey("ladder:nope")).toBeNull();
        expect(core.parseBadgeKey("custom:not-a-uuid")).toBeNull();
    });

    it("rounds rarity up to 1% for anybody holding it", () => {
        expect(core.rarityPercent(0, 10)).toBe(0);
        expect(core.rarityPercent(1, 1000)).toBe(1);
        expect(core.rarityPercent(5, 10)).toBe(50);
        expect(core.rarityPercent(3, 0)).toBe(0);
    });
});

describe("badge arrangement", () => {
    const badges = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }];

    it("puts arranged badges first in their order and new ones after", () => {
        const order = core.orderBadges(
            badges,
            new Map([
                ["c", 0],
                ["a", 1]
            ])
        );
        expect(order.map((badge) => badge.key)).toEqual(["c", "a", "b", "d"]);
    });

    it("moves one entry with the keyboard, clamped at the ends", () => {
        expect(core.moveEntry(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
        expect(core.moveEntry(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
        expect(core.moveEntry(["a", "b", "c"], 2, 5)).toEqual(["a", "b", "c"]);
    });

    it("refuses a badge listed twice or an unknown key", () => {
        expect(
            core.badgePreferencesSchema.safeParse([{ badge: "staff" }, { badge: "staff" }]).success
        ).toBe(false);
        expect(core.badgePreferencesSchema.safeParse([{ badge: "bogus" }]).success).toBe(false);
        const ok = core.badgePreferencesSchema.safeParse([
            { badge: "staff", hidden: true },
            { badge: "ladder:tasks" }
        ]);
        expect(ok.success && ok.data[1]).toEqual({
            badge: "ladder:tasks",
            hidden: false,
            audience: null,
            listId: null,
            people: []
        });
    });
});
