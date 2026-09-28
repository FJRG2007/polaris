/**
 * What one presence reading costs the database.
 *
 * The watcher reads every few seconds for as long as anybody has a game screen
 * open, so what it asks for is asked many thousands of times a day. Two things
 * are pinned: the list is narrowed in the query - to game servers, and to the
 * servers a page is about - rather than loaded whole and filtered afterwards; and
 * the Minecraft servers it then asks are resolved together, once, and handed to
 * the read rather than each looked up again on its own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ONE = "aaaaaaaa-1111-4111-8111-111111111111";
const TWO = "bbbbbbbb-1111-4111-8111-111111111111";

function row(id: string) {
    return {
        id,
        name: `Server ${id.slice(0, 1)}`,
        catalogId: "minecraft",
        applicationId: `app-${id}`,
        targetId: "target",
        config: "{}"
    };
}

let listed: { where: Record<string, unknown>; select?: Record<string, unknown> }[] = [];
let resolvedFor: string[][] = [];
let playersAsked: { id: string; resolved: unknown }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async (query: {
                where: Record<string, unknown>;
                select?: Record<string, unknown>;
            }) => {
                listed.push(query);
                return [row(ONE), row(TWO)];
            }
        },
        deployTarget: { findMany: async () => [{ id: "target", name: "This machine" }] },
        application: {
            findMany: async () =>
                [ONE, TWO].map((id) => ({
                    id: `app-${id}`,
                    sourceConfig: "{}",
                    desiredState: "running",
                    currentDeploymentId: null,
                    target: { kind: "remote", hostId: "host" }
                }))
        },
        deployment: { findMany: async () => [] },
        host: { findMany: async () => [{ id: "host", address: "10.0.0.5" }] },
        envVar: { findMany: async () => [] }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    resolveInstalls: async (_ownerId: string, ids: readonly string[]) => {
        resolvedFor.push([...ids]);
        return new Map(ids.map((id) => [id, { installedAppId: id }]));
    },
    getServerPlayers: async (_ownerId: string, id: string, resolved: unknown) => {
        playersAsked.push({ id, resolved });
        return {
            answering: true,
            containerRunning: true,
            players: { online: 0, max: 20, players: [] },
            message: null,
            crashLoop: null
        };
    },
    applyFirewallBans: async () => undefined,
    editionOf: () => "java"
}));

const { listGameServerPresence } = await import("@polaris-app/game-servers/src/lib/games-service");

beforeEach(() => {
    listed = [];
    resolvedFor = [];
    playersAsked = [];
});

describe("listGameServerPresence", () => {
    it("asks the database for game servers only, without their whole rows", async () => {
        await listGameServerPresence(OWNER);
        const where = listed[0]!.where as { catalogId?: { in: string[] } };
        expect(where.catalogId?.in).toContain("minecraft");
        expect(where.catalogId?.in).not.toContain("game-servers");
        expect(listed[0]!.select).toBeDefined();
    });

    it("narrows to the servers a page is about in the query itself", async () => {
        await listGameServerPresence(OWNER, [], [ONE]);
        expect((listed[0]!.where as { id?: unknown }).id).toEqual({ in: [ONE] });
    });

    it("resolves every Minecraft server it will ask in one pass, and hands each its own", async () => {
        await listGameServerPresence(OWNER);
        expect(resolvedFor).toEqual([[ONE, TWO]]);
        expect(playersAsked).toEqual([
            { id: ONE, resolved: { installedAppId: ONE } },
            { id: TWO, resolved: { installedAppId: TWO } }
        ]);
    });
});
