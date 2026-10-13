/**
 * Who has the sound pack, as counts and as one bounded page: a server of
 * thousands is never sent, or drawn, whole.
 */

import { describe, expect, it } from "vitest";
import {
    MAX_LIVE_PAGE,
    countLiveSounds,
    liveSoundsPage,
    type LiveSoundPlayer
} from "@polaris-app/game-servers/src/lib/minecraft/sounds-live";

const STATES = ["loaded", "pending", "declined", "failed"] as const;
const MANY: LiveSoundPlayer[] = Array.from({ length: 5000 }, (_, index) => ({
    name: `Player${String(4999 - index).padStart(4, "0")}`,
    state: STATES[index % 4]!
}));

describe("live sounds", () => {
    it("counts who has the pack and who refused or failed it", () => {
        expect(countLiveSounds(MANY)).toEqual({
            online: 5000,
            loaded: 1250,
            pending: 1250,
            refused: 2500
        });
        expect(countLiveSounds([])).toEqual({ online: 0, loaded: 0, pending: 0, refused: 0 });
    });

    it("pages by name, in the same order on every read", () => {
        const first = liveSoundsPage(MANY, { query: "", filter: "all", offset: 0, limit: 3 });
        expect(first.total).toBe(5000);
        expect(first.players.map((one) => one.name)).toEqual([
            "Player0000",
            "Player0001",
            "Player0002"
        ]);
        const reversed = [...MANY].reverse();
        expect(liveSoundsPage(reversed, { query: "", filter: "all", offset: 0, limit: 3 })).toEqual(
            first
        );
    });

    it("searches by name and filters by having the pack", () => {
        const have = liveSoundsPage(MANY, {
            query: "player00",
            filter: "have",
            offset: 0,
            limit: 50
        });
        expect(have.players.length).toBeGreaterThan(0);
        expect(have.players.every((one) => one.state === "loaded")).toBe(true);
        expect(have.players.every((one) => one.name.startsWith("Player00"))).toBe(true);
        const missing = liveSoundsPage(MANY, { query: "", filter: "missing", offset: 0, limit: 1 });
        expect(missing.total).toBe(3750);
        expect(missing.players[0]!.state).not.toBe("loaded");
    });

    it("never hands back more than one page", () => {
        const page = liveSoundsPage(MANY, {
            query: "",
            filter: "all",
            offset: 4990,
            limit: 10_000
        });
        expect(page.players.length).toBe(10);
        expect(
            liveSoundsPage(MANY, { query: "", filter: "all", offset: 0, limit: 10_000 }).players
                .length
        ).toBe(MAX_LIVE_PAGE);
    });
});
