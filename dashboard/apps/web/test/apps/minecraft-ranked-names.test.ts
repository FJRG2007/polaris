/**
 * A ranked player is read by their own name.
 *
 * Ranks put a team prefix before the name (`✦ [VIP] Reckmy`), and `list`
 * answers with that display name. Reading its first word stored the rank's
 * symbol as the player: every ranked player became `✦` or `⚔`, showed as offline
 * while playing, was never linked to their account, and filled "Turned away
 * recently" with refusals for a name nobody has. The lines here are the live
 * Offgrid server's.
 */

import { describe, expect, it } from "vitest";
import * as parse from "@polaris-app/game-servers/src/lib/minecraft/parse";
import { ownerOfSymbol } from "@polaris-app/game-servers/src/lib/minecraft/visit-names-repair";
import type { Rank } from "@polaris-app/game-servers/src/lib/minecraft/ranks";

describe("list through rank prefixes", () => {
    it("reads the names behind the live server's prefixes", () => {
        expect(
            parse.parsePlayerList(
                "There are 2 of a max of 20 players online: ✦ [VIP] Reckmy, ⚔ [ADMIN] FJRG2007"
            )
        ).toEqual({ online: 2, max: 20, players: ["Reckmy", "FJRG2007"] });
    });

    it("keeps plain names, Bedrock dots and a suffix as before", () => {
        expect(
            parse.parsePlayerList("There are 3 of a max of 20 players online: Alice, .Bob, Carol (AFK)")
                ?.players
        ).toEqual(["Alice", ".Bob", "Carol"]);
    });

    it("reads a tag with spaces in it, and drops an entry with no name", () => {
        expect(parse.playerOfEntry("✦ [TOP 10] Steve")).toBe("Steve");
        expect(parse.playerOfEntry("✦")).toBeNull();
        expect(parse.playerOfEntry("⚔ [ADMIN]")).toBeNull();
    });
});

describe("ownerOfSymbol", () => {
    const rank = (symbol: string, players: string[]): Rank => ({
        id: symbol === "✦" ? "vip" : "admin",
        name: symbol,
        tag: "T",
        symbol,
        color: "gold",
        bold: false,
        players
    });

    it("gives a stored symbol back to the one player holding its rank", () => {
        expect(ownerOfSymbol("✦", [rank("✦", ["Reckmy"]), rank("⚔", ["FJRG2007"])])).toBe("Reckmy");
    });

    it("cannot tell when the rank has several players or the symbol several ranks", () => {
        expect(ownerOfSymbol("✦", [rank("✦", ["Reckmy", "Ana"])])).toBeNull();
        expect(ownerOfSymbol("✦", [rank("✦", ["Reckmy"]), rank("✦", ["Ana"])])).toBeNull();
        expect(ownerOfSymbol("✦", [])).toBeNull();
    });
});
