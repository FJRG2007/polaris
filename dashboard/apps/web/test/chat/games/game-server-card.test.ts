/**
 * The card somebody gets when they are let onto a game server: which guide it
 * shows, which games get a Join link, and that its mark is only ever a server id.
 */

import { describe, expect, it } from "vitest";
import * as card from "../../../src/lib/chat/game-server-card";

const SERVER = "aaaaaaaa-1111-4111-8111-111111111111";

describe("the card's mark", () => {
    it("round-trips a server id", () => {
        expect(card.gameServerIdIn(card.gameServerMark(SERVER))).toBe(SERVER);
    });

    it("is null for any other body, and for a mark that is not an id", () => {
        expect(card.gameServerIdIn("hello")).toBeNull();
        expect(card.gameServerIdIn("polaris-game-server:../admin")).toBeNull();
        expect(card.gameServerIdIn(`polaris-activity:${SERVER}`)).toBeNull();
    });
});

describe("how to join", () => {
    it("tells the two Minecraft editions apart", () => {
        expect(card.joinGuideFor("minecraft", "java")).toBe("minecraftJava");
        expect(card.joinGuideFor("minecraft", null)).toBe("minecraftJava");
        expect(card.joinGuideFor("minecraft", "bedrock")).toBe("minecraftBedrock");
    });

    it("has a guide per game and a plain one for anything else", () => {
        expect(card.joinGuideFor("fivem", null)).toBe("fivem");
        expect(card.joinGuideFor("ark", null)).toBe("ark");
        expect(card.joinGuideFor("hytale", null)).toBe("hytale");
        expect(card.joinGuideFor(null, null)).toBe("other");
    });

    it("splits an address into host and port for the games with two fields", () => {
        expect(card.splitAddress("play.example.test:19132")).toEqual({
            host: "play.example.test",
            port: "19132"
        });
        expect(card.splitAddress("play.example.test")).toEqual({
            host: "play.example.test",
            port: null
        });
    });
});

describe("the Join button", () => {
    it("opens FiveM straight on the server", () => {
        expect(card.joinLinkFor("fivem", "192.0.2.4:30120")).toBe("fivem://connect/192.0.2.4:30120");
    });

    it("is absent where the address is pasted by hand, or there is none", () => {
        expect(card.joinLinkFor("minecraft", "192.0.2.4:25565")).toBeNull();
        expect(card.joinLinkFor("fivem", null)).toBeNull();
    });

    it("builds the reader's view from what the game app read", () => {
        const view = card.cardView({
            id: SERVER,
            name: "Survival",
            game: "minecraft",
            edition: "java",
            address: "mc.example.test",
            release: "1.21.4",
            running: true
        });
        expect(view).toMatchObject({
            state: "ready",
            guide: "minecraftJava",
            joinLink: null,
            href: `/game-servers/${SERVER}`
        });
    });
});
