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
vi.mock("@/lib/app-extensions/registry", () => ({
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

const { readGameServerCard } = await import("../../../src/app/(app)/chat/game-server-card-actions");

beforeEach(() => {
    access = null;
    asked = [];
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
