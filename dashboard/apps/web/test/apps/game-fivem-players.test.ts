/**
 * Who a FiveM player is, out of the documents the server publishes.
 *
 * The thing being defended here is that the name means nothing. A FiveM player
 * sets their own, two of them can pick the same one, and either can change it
 * between one evening and the next - so every rule Polaris writes is written
 * against an identifier the game handed over. Which identifier is not a detail:
 * a licence is the account and is always presented, a Steam id only appears when
 * the server was given a Steam key, and an address is whoever is sitting behind
 * it today.
 *
 * The parsers are deliberately forgiving in one direction only: a row that cannot
 * be read is dropped, never repaired, because a repaired row is a moderation
 * button pointed at somebody it was not meant for.
 */

import { describe, expect, it } from "vitest";
import * as players from "@/lib/apps/fivem/players";

const ALICE = {
    endpoint: "203.0.113.9:52000",
    id: 3,
    identifiers: ["license:0123456789abcdef0123456789abcdef01234567", "discord:112233445566778899", "ip:203.0.113.9"],
    name: "Alice",
    ping: 42
};

describe("the player list", () => {
    it("reads a row the server published", () => {
        const [player] = players.parsePlayers([ALICE]);
        expect(player).toMatchObject({ id: 3, name: "Alice", ping: 42, endpoint: "203.0.113.9:52000" });
        expect(player?.identifiers).toHaveLength(3);
    });

    it("drops a row it cannot read rather than inventing one", () => {
        expect(players.parsePlayers([{ name: "no id" }, ALICE, null, "nonsense"])).toHaveLength(1);
    });

    it("is empty for anything that is not a list", () => {
        expect(players.parsePlayers(null)).toEqual([]);
        expect(players.parsePlayers({ players: [] })).toEqual([]);
    });
});

describe("how full it is", () => {
    it("comes off the document the server publishes for the browser", () => {
        const dynamic = players.parseDynamic({
            clients: 4,
            gametype: "Roleplay",
            hostname: "Los Santos",
            mapname: "fivem-map-skater",
            sv_maxclients: 48
        });
        expect(dynamic).toMatchObject({ clients: 4, maxClients: 48, hostname: "Los Santos" });
    });

    it("is null when there was nothing to read", () => {
        expect(players.parseDynamic(null)).toBe(null);
    });
});

describe("what it is running", () => {
    it("carries the resources and the advertised variables", () => {
        const info = players.parseInfo({
            resources: ["chat", "hardcap", "polaris"],
            server: "FXServer-master v1.0.0.7290",
            vars: { tags: "roleplay", locale: "en-US", banner: 1 }
        });
        expect(info?.resources).toEqual(["chat", "hardcap", "polaris"]);
        expect(info?.server).toContain("FXServer");
        // A variable that is not text is not a variable this screen can print.
        expect(info?.vars).toEqual({ tags: "roleplay", locale: "en-US" });
    });
});

describe("an identifier", () => {
    it("is picked off a player by kind", () => {
        expect(players.identifierOf(ALICE, "discord")).toBe("112233445566778899");
        expect(players.identifierOf(ALICE, "steam")).toBe(null);
    });

    it("prefers the licence, which is the account rather than a shop it was bought from", () => {
        expect(players.primaryIdentifier(ALICE)).toBe(
            "license:0123456789abcdef0123456789abcdef01234567"
        );
    });

    it("falls back in order, and an address is the last resort", () => {
        expect(players.primaryIdentifier({ identifiers: ["ip:203.0.113.9"] })).toBe("ip:203.0.113.9");
        expect(players.primaryIdentifier({ identifiers: ["discord:1", "ip:203.0.113.9"] })).toBe("discord:1");
        expect(players.primaryIdentifier({ identifiers: [] })).toBe(null);
    });

    it("has to name a kind the game actually presents", () => {
        expect(players.isIdentifier("license:abc")).toBe(true);
        expect(players.isIdentifier("DISCORD:112233")).toBe(true);
        expect(players.isIdentifier("Alice")).toBe(false);
        expect(players.isIdentifier("twitter:alice")).toBe(false);
        expect(players.isIdentifier("license:")).toBe(false);
        expect(players.isIdentifier(":abc")).toBe(false);
        // A space would make it two arguments in a console command.
        expect(players.isIdentifier("license:a b")).toBe(false);
    });

    it("is stored lowercased, because the door compares it that way", () => {
        expect(players.normalizeIdentifier(" LICENSE:AbCdEf ")).toBe("license:abcdef");
    });

    it("says which kind it is, for the label beside it", () => {
        expect(players.kindOf("discord:1")).toBe("discord");
        expect(players.kindOf("twitter:1")).toBe(null);
    });
});

describe("matching a player", () => {
    it("is by any identifier they presented, whichever way it was typed", () => {
        expect(players.playerHasIdentifier(ALICE, "DISCORD:112233445566778899")).toBe(true);
        expect(players.playerHasIdentifier(ALICE, "discord:999")).toBe(false);
    });
});

describe("where they are connected from", () => {
    it("prefers the identifier and falls back to the endpoint without its port", () => {
        expect(players.addressOf(players.parsePlayers([ALICE])[0]!)).toBe("203.0.113.9");
        const hidden = players.parsePlayers([{ ...ALICE, identifiers: ["license:abc"] }])[0]!;
        expect(players.addressOf(hidden)).toBe("203.0.113.9");
    });

    it("is null on a server that hides it, which is how Polaris creates one", () => {
        const hidden = players.parsePlayers([{ ...ALICE, identifiers: ["license:abc"], endpoint: "" }])[0]!;
        expect(players.addressOf(hidden)).toBe(null);
    });
});
