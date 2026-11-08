/**
 * Somebody in a game played together here but away from it reads as idle.
 *
 * The card said "Playing Skyline Roam, 7:37 elapsed" for a player whose game
 * tab sat in the background while they played something else: nothing in the
 * renewal that keeps the seat said whether anybody was at it.
 */

import { describe, expect, it } from "vitest";
import { isGameAway, noteGameAway } from "@/lib/chat/game-away";
import { PASS_TTL_MS } from "@/lib/chat/call-activity";
import { AWAY_AFTER_MS, awayAt } from "@/app/(app)/chat/use-game-away";

describe("game away marks", () => {
    it("holds a mark until the player is back", () => {
        noteGameAway("ana", true, 1_000);
        expect(isGameAway("ana", 2_000)).toBe(true);
        noteGameAway("ana", false, 3_000);
        expect(isGameAway("ana", 3_000)).toBe(false);
    });

    it("forgets a mark nobody renewed within a pass", () => {
        noteGameAway("bea", true, 0);
        expect(isGameAway("bea", PASS_TTL_MS + 1)).toBe(false);
    });
});

describe("awayAt", () => {
    it("is away only after a minute out of view", () => {
        expect(awayAt(null, 10_000)).toBe(false);
        expect(awayAt(0, AWAY_AFTER_MS - 1)).toBe(false);
        expect(awayAt(0, AWAY_AFTER_MS)).toBe(true);
    });
});
