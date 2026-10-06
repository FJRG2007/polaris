/**
 * The door a linked player comes through reads where they are signed in now.
 *
 * The report: a player tied to a Polaris account was turned away from home,
 * where their account had no sign-in. Opening Polaris there should let them in
 * - but the door read the addresses as the last two-minute sweep had left
 * them, so they were refused again until it came round. The door brings a
 * linked player's sign-ins up to date before it decides.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ order: [] as string[], rules: [] as unknown[] }));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findUnique: async () => ({ config: {} }) }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/player-access", () => ({
    syncLinkedAddresses: async () => {
        calls.order.push("sync");
        // What the sync found: the player signed in from home now.
        calls.rules = [{ username: "yeray", address: "79.117.253.67" }];
    },
    playerAccessRules: async () => {
        calls.order.push("rules");
        return calls.rules;
    },
    noteRefusal: async () => {
        calls.order.push("refused");
    }
}));

const service = await import("@polaris-app/game-servers/src/lib/minecraft/polaris-login-service");

const SERVER = { installedAppId: "server-1" } as never;

beforeEach(() => {
    calls.order = [];
    calls.rules = [{ username: "yeray", address: "198.51.100.7" }];
});

describe("the door", () => {
    it("lets a linked player in from where they just signed in to Polaris", async () => {
        expect(await service.joinRefusal(SERVER, "yeray", "79.117.253.67")).toBeNull();
        expect(calls.order.slice(0, 2)).toEqual(["sync", "rules"]);
        expect(calls.order).not.toContain("refused");
    });

    it("still turns away an address nobody allowed", async () => {
        expect(await service.joinRefusal(SERVER, "yeray", "203.0.113.9")).not.toBeNull();
        expect(calls.order).toContain("refused");
    });
});
