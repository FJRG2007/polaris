/**
 * The card is read against the reader's own access: somebody who cannot read
 * the server is told so, and never gets its address.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SERVER = "aaaaaaaa-1111-4111-8111-111111111111";
let access: { ownerId: string } | null = null;
let asked: string[] = [];

vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "reader", isAdmin: false }) }));
vi.mock("@/lib/apps/install-access", () => ({
    gameServerAccess: async (_user: unknown, id: string, permission: string) => {
        asked.push(`${id}:${permission}`);
        return access;
    }
}));
let link: { id: string } | null = null;
let linkAsked: unknown[] = [];
vi.mock("@polaris/db", () => ({
    prisma: {
        gamePlayerLink: {
            findFirst: async (query: unknown) => {
                linkAsked.push(query);
                return link;
            }
        },
        installedApp: { findFirst: async () => ({ ownerId: "owner" }) }
    }
}));
vi.mock("@/lib/app-extensions/registry", () => ({
    gamePlayerJoinFrom: async () => ({ kind: "signIns" }),
    gameServerCardFacts: async (_ownerId: string, id: string) => ({
        id,
        name: "Survival",
        game: "fivem",
        edition: null,
        address: "192.0.2.4:30120",
        release: null,
        running: true
    })
}));

const { readGameServerCard, readGameInviteCard } = await import("../../../src/app/(app)/chat/game-server-card-actions");

beforeEach(() => {
    access = null;
    asked = [];
    link = null;
    linkAsked = [];
});

describe("reading the game server card", () => {
    it("tells a reader without access only that, with no address", async () => {
        expect(await readGameServerCard(SERVER)).toEqual({ state: "denied" });
        expect(asked).toEqual([`${SERVER}:games.read`]);
    });

    it("hands a reader with access the address and the Join link", async () => {
        access = { ownerId: "owner" };
        expect(await readGameServerCard(SERVER)).toMatchObject({
            state: "ready",
            address: "192.0.2.4:30120",
            joinLink: "fivem://connect/192.0.2.4:30120"
        });
    });

    it("reads nothing for a mark that is not an id", async () => {
        expect(await readGameServerCard("nope")).toBeNull();
        expect(asked).toEqual([]);
    });
});

describe("reading a game invite card", () => {
    it("shows the server's page to a reader who may read it", async () => {
        access = { ownerId: "owner" };
        expect(await readGameInviteCard(SERVER, "demo")).toMatchObject({
            state: "ready",
            player: "demo",
            canOpen: true,
            // Somebody who may read the server but is not the player: the card
            // speaks about the player, not to them.
            forPlayer: false,
            joinFrom: { kind: "signIns" },
            address: "192.0.2.4:30120"
        });
    });

    it("lets the linked player in without the server's page", async () => {
        link = { id: "link" };
        expect(await readGameInviteCard(SERVER, "demo")).toMatchObject({
            state: "ready",
            canOpen: false,
            forPlayer: true,
            address: "192.0.2.4:30120"
        });
        expect(linkAsked[0]).toMatchObject({
            where: {
                installedAppId: SERVER,
                userId: "reader",
                player: { equals: "demo", mode: "insensitive" }
            }
        });
    });

    it("speaks to the player who also may read the server", async () => {
        access = { ownerId: "owner" };
        link = { id: "link" };
        expect(await readGameInviteCard(SERVER, "demo")).toMatchObject({
            state: "ready",
            canOpen: true,
            forPlayer: true
        });
    });

    it("tells anybody else only that it is not theirs", async () => {
        expect(await readGameInviteCard(SERVER, "demo")).toEqual({ state: "denied" });
    });

    it("reads nothing for a mark that is not a server and a player", async () => {
        expect(await readGameInviteCard("nope", "demo")).toBeNull();
        expect(await readGameInviteCard(SERVER, "")).toBeNull();
        expect(asked).toEqual([]);
    });
});
