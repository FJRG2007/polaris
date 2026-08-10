/**
 * What creating a server will and will not accept.
 *
 * One schema per game joined on the game itself, which is the point of this file:
 * a single flat object with half its fields optional cannot refuse anything, and
 * the refusal it does not make lands at the container instead of on the form. So
 * these check both directions - that each game's own questions are required, and
 * that the other game's are not quietly accepted alongside them.
 */

import { describe, expect, it } from "vitest";
import { createGameServerSchema } from "@/lib/apps/games-schema";

const minecraft = {
    game: "minecraft" as const,
    name: "Survival",
    serverId: "local",
    ownerPlayer: "Steve",
    ownerAddress: "203.0.113.9",
    edition: "java" as const
};

const ark = {
    game: "ark" as const,
    name: "Island",
    serverId: "local",
    map: "TheIsland",
    sessionName: "Island",
    joinPassword: "Correct9Horse",
    ownerSteamId: "76561198000000001"
};

describe("creating an ARK server", () => {
    it("takes the questions ARK actually has", () => {
        const parsed = createGameServerSchema.safeParse(ark);
        expect(parsed.success).toBe(true);
        if (parsed.success && parsed.data.game === "ark") {
            // Closed unless somebody deliberately opened it.
            expect(parsed.data.exclusiveJoin).toBe(true);
        }
    });

    it("refuses a map the server cannot load", () => {
        // Case matters and four of the names are not what the map is called, so a
        // typed map name is the one thing this must not pass through.
        expect(createGameServerSchema.safeParse({ ...ark, map: "Aberration" }).success).toBe(false);
        expect(createGameServerSchema.safeParse({ ...ark, map: "theisland" }).success).toBe(false);
        expect(createGameServerSchema.safeParse({ ...ark, map: "Aberration_P" }).success).toBe(true);
    });

    it("refuses a password ARK would not carry", () => {
        expect(createGameServerSchema.safeParse({ ...ark, joinPassword: "short1" }).success).toBe(false);
        expect(createGameServerSchema.safeParse({ ...ark, joinPassword: "with a space" }).success).toBe(false);
    });

    it("refuses anything that is not a Steam id", () => {
        expect(createGameServerSchema.safeParse({ ...ark, ownerSteamId: "Alice" }).success).toBe(false);
        expect(createGameServerSchema.safeParse({ ...ark, ownerSteamId: "" }).success).toBe(false);
    });

    it("refuses mods that steamcmd could not install", () => {
        expect(createGameServerSchema.safeParse({ ...ark, mods: "731604991,893735676" }).success).toBe(true);
        expect(createGameServerSchema.safeParse({ ...ark, mods: "structures plus" }).success).toBe(false);
    });

    it("does not accept a Minecraft server's answers", () => {
        // A seed and an edition mean nothing here, and a schema that took them
        // would be one that never noticed the form sent the wrong shape.
        const parsed = createGameServerSchema.safeParse({ ...ark, seed: "hello", edition: "java" });
        expect(parsed.success && "seed" in parsed.data).toBe(false);
    });
});

describe("creating a Minecraft server", () => {
    it("still takes what it always did", () => {
        expect(createGameServerSchema.safeParse(minecraft).success).toBe(true);
    });

    it("refuses a username the server would not let in", () => {
        expect(createGameServerSchema.safeParse({ ...minecraft, ownerPlayer: "a" }).success).toBe(false);
    });

    it("refuses crossplay on the edition that cannot have it", () => {
        expect(
            createGameServerSchema.safeParse({ ...minecraft, edition: "bedrock", crossplay: true }).success
        ).toBe(false);
    });

    it("refuses an ARK map, whatever else is right", () => {
        const parsed = createGameServerSchema.safeParse({ ...minecraft, map: "TheIsland" });
        expect(parsed.success && "map" in parsed.data).toBe(false);
    });
});

describe("either game", () => {
    it("refuses more players at once than there are slots", () => {
        expect(createGameServerSchema.safeParse({ ...ark, maxPlayers: 4, concurrentPlayers: 10 }).success).toBe(false);
        expect(
            createGameServerSchema.safeParse({ ...minecraft, maxPlayers: 4, concurrentPlayers: 10 }).success
        ).toBe(false);
    });

    it("refuses a game nobody has", () => {
        expect(createGameServerSchema.safeParse({ ...ark, game: "halo" }).success).toBe(false);
    });
});
