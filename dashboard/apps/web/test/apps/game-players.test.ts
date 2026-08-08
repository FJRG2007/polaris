/**
 * Folding a game server's five lists into one row per player.
 *
 * The lists do not agree on spelling - RCON echoes what the client sent, the
 * whitelist file holds what Mojang returned, and the access rules hold what an
 * operator typed - so the fold is case-insensitive. Getting that wrong is not a
 * cosmetic bug: three spellings of one person become three rows, each missing two
 * thirds of what is true about them, and the operator bans the row that says
 * "banned" while the player carries on playing under the row that does not.
 *
 * The other thing pinned here is the "not registered" state, which is the gap the
 * whole player list exists to close: a name the game knows and Polaris does not is
 * somebody who gets in on a username alone.
 */

import { describe, expect, it } from "vitest";
import { foldPlayers } from "@/lib/apps/minecraft/players";
import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import type { MinecraftRoster, MinecraftStatus } from "@/lib/apps/minecraft/service";

function status(players: string[]): MinecraftStatus {
    return {
        edition: "java",
        running: true,
        answering: true,
        players: { online: players.length, max: 20, players },
        address: "mc.example.com",
        message: null,
        cpuPercent: null,
        memUsedBytes: null,
        memTotalBytes: null
    };
}

function roster(partial: Partial<MinecraftRoster> = {}): MinecraftRoster {
    return { ops: [], whitelist: [], bans: [], whitelistEnforced: true, ...partial };
}

function access(rules: PlayerAccessView["rules"]): PlayerAccessView {
    return { rules, bindAddresses: true, addressesAvailable: true, edition: "java" };
}

function rule(username: string, address: string, note: string | null = null) {
    return { id: username, username, address, note, createdAt: "2026-08-08T00:00:00.000Z" };
}

describe("foldPlayers", () => {
    it("gathers every list a player is in onto one row", () => {
        const folded = foldPlayers(
            status(["Steve"]),
            roster({ ops: ["Steve"], whitelist: ["Steve"], bans: [] }),
            access([rule("Steve", "203.0.113.9", "Created this server")])
        );
        expect(folded).toHaveLength(1);
        expect(folded[0]).toMatchObject({
            name: "Steve",
            online: true,
            operator: true,
            whitelisted: true,
            address: "203.0.113.9",
            note: "Created this server",
            banned: false
        });
    });

    // The lists are written by three different things, so they disagree on case.
    it("treats the same name spelled differently as one player", () => {
        const folded = foldPlayers(
            status(["steve"]),
            roster({ ops: ["STEVE"], whitelist: ["Steve"] }),
            access([rule("sTeVe", "any")])
        );
        expect(folded).toHaveLength(1);
        expect(folded[0]).toMatchObject({ online: true, operator: true, whitelisted: true, address: "any" });
    });

    it("keeps a banned player with the reason the server gave", () => {
        const folded = foldPlayers(
            null,
            roster({ bans: [{ name: "Griefer", reason: "Blew up spawn" }] }),
            access([])
        );
        expect(folded[0]).toMatchObject({ name: "Griefer", banned: true, banReason: "Blew up spawn" });
    });

    // The gap the player list exists to close: the game knows the name, Polaris
    // has no address for it, so nothing checks where they connect from.
    it("reports a player the game knows and Polaris does not as unregistered", () => {
        const folded = foldPlayers(status(["Alex"]), roster({ whitelist: ["Alex"] }), access([]));
        expect(folded[0]).toMatchObject({ name: "Alex", whitelisted: true, address: null });
    });

    it("lists a registered player who has never connected", () => {
        const folded = foldPlayers(status([]), roster(), access([rule("Alex", "203.0.113.0/24")]));
        expect(folded).toHaveLength(1);
        expect(folded[0]).toMatchObject({ name: "Alex", online: false, address: "203.0.113.0/24" });
    });

    // Online first because they are who something can be done about right now,
    // then alphabetically so the table does not reshuffle as people come and go.
    it("puts whoever is on at the top and orders the rest by name", () => {
        const folded = foldPlayers(
            status(["Zoe"]),
            roster({ whitelist: ["Alex", "Mia"] }),
            access([rule("Mia", "any"), rule("Alex", "any")])
        );
        expect(folded.map((player) => player.name)).toEqual(["Zoe", "Alex", "Mia"]);
    });

    it("has nothing to show for a server nothing has answered for yet", () => {
        expect(foldPlayers(null, null, null)).toEqual([]);
    });
});
