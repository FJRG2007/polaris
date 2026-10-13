/**
 * The players table does not reshuffle on a reload.
 *
 * Its rows fold several reads that land one by one. Until all of them are in,
 * the last whole list is drawn instead of a partial one whose order changes as
 * each read lands, and a stopped server's missing roster counts as answered.
 */

import { describe, expect, it } from "vitest";
import * as view from "@polaris-app/game-servers/src/lib/minecraft/players-view";
import { foldPlayers } from "@polaris-app/game-servers/src/lib/minecraft/players";

const STATUS = { answering: true, players: { players: ["PlayerTwo"] } } as never;
const ROSTER = { ops: [], whitelist: ["PlayerOne", "PlayerThree"], bans: [] } as never;
const ACCESS = { rules: [], links: [], refusals: [] } as never;

describe("the players table between reads", () => {
    it("waits for every read, and takes a stopped server's missing roster as whole", () => {
        expect(view.playersComplete({ status: null, roster: ROSTER, access: ACCESS })).toBe(false);
        expect(view.playersComplete({ status: STATUS, roster: null, access: ACCESS })).toBe(false);
        expect(view.playersComplete({ status: STATUS, roster: ROSTER, access: null })).toBe(false);
        expect(view.playersComplete({ status: STATUS, roster: ROSTER, access: ACCESS })).toBe(true);
        expect(
            view.playersComplete({ status: { answering: false }, roster: null, access: ACCESS })
        ).toBe(true);
    });

    it("keeps drawing the last whole list while a reload is partial", () => {
        const whole = foldPlayers(STATUS, ROSTER, ACCESS);
        expect(whole.map((one) => one.name)).toEqual(["PlayerTwo", "PlayerOne", "PlayerThree"]);
        const kept = view.keptPlayers(whole);

        // The first read back is who is on, without the lists yet.
        const partial = foldPlayers(STATUS, null, null);
        expect(view.playersOnScreen(partial, kept, false).map((one) => one.name)).toEqual([
            "PlayerTwo",
            "PlayerOne",
            "PlayerThree"
        ]);
        // Whole again: the fresh fold, in the same order.
        const fresh = foldPlayers(STATUS, ROSTER, ACCESS);
        expect(view.playersOnScreen(fresh, kept, true)).toBe(fresh);
        expect(fresh.map((one) => one.name)).toEqual(kept.map((one) => one.name));
    });

    it("draws the fresh fold when nothing was kept", () => {
        const partial = foldPlayers(STATUS, null, null);
        expect(view.playersOnScreen(partial, null, false)).toBe(partial);
        expect(view.playersOnScreen(partial, [], false)).toBe(partial);
    });

    it("keeps a bounded list, without the session history", () => {
        const many = Array.from({ length: view.MAX_KEPT_PLAYERS + 50 }, (_, index) => ({
            ...foldPlayers(STATUS, null, null)[0]!,
            name: `Player${index}`,
            sessions: [{ name: `Player${index}` } as never]
        }));
        const kept = view.keptPlayers(many);
        expect(kept.length).toBe(view.MAX_KEPT_PLAYERS);
        expect(kept.every((one) => one.sessions.length === 0)).toBe(true);
    });
});
