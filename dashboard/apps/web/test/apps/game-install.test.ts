/**
 * Folding the old per-game apps into the one that replaced them.
 *
 * This runs against instances that are already in use, which is the whole risk:
 * the manager row is what the Game servers page reads to decide it is on at all,
 * and the servers people are actually playing on are separate installs beside it.
 * Getting this wrong takes somebody's page away, or their servers.
 *
 * So what is asserted is the boring part: the oldest manager becomes the new app
 * and keeps its id - grants point at that id - the duplicates are retired rather
 * than deleted, nothing that is not a manager is touched at all, and running it
 * again does nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GAME_SERVERS_APP_ID } from "@/lib/apps/games-catalog";

const OWNER = "11111111-1111-4111-8111-111111111111";

interface Row {
    id: string;
    ownerId: string;
    catalogId: string;
    name: string;
    status: string;
    createdAt: Date;
}

let rows: Row[];
/** What installApp was asked to install, for the case where there is nothing to
 *  adopt and the app has to be created from scratch. */
let installed: string[];

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async ({ where }: { where: { catalogId: { in: string[] }; ownerId: string } }) =>
                rows
                    .filter(
                        (row) =>
                            row.ownerId === where.ownerId &&
                            where.catalogId.in.includes(row.catalogId) &&
                            row.status !== "removed"
                    )
                    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
            update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                const row = rows.find((entry) => entry.id === where.id);
                if (row) Object.assign(row, data);
                return row;
            },
            updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<Row> }) => {
                for (const row of rows) if (where.id.in.includes(row.id)) Object.assign(row, data);
                return { count: where.id.in.length };
            }
        }
    }
}));

vi.mock("@/lib/apps/install-service", () => ({
    installApp: async (_ownerId: string, _actorId: string, input: { catalogId: string }) => {
        installed.push(input.catalogId);
        return { installedAppId: "fresh", applicationId: null };
    }
}));

const { adoptGameServersApp, installGameServersApp } = await import("@/lib/apps/game-install");

/** A row as the database holds it. */
function row(id: string, catalogId: string, createdAt: string, status = "running"): Row {
    return { id, ownerId: OWNER, catalogId, name: catalogId, status, createdAt: new Date(createdAt) };
}

function find(id: string): Row | undefined {
    return rows.find((entry) => entry.id === id);
}

beforeEach(() => {
    rows = [];
    installed = [];
});

describe("adopting what is already installed", () => {
    it("turns the one manager somebody has into the app that replaced it", async () => {
        rows = [row("mc-manager", "minecraft-manager", "2026-01-01")];
        expect(await adoptGameServersApp(OWNER)).toBe("mc-manager");
        // The same row, so whatever was granted on it still points somewhere.
        expect(find("mc-manager")).toMatchObject({
            catalogId: GAME_SERVERS_APP_ID,
            name: "Game servers",
            status: "running"
        });
    });

    it("keeps the oldest of two and retires the other", async () => {
        rows = [row("ark-manager", "ark-manager", "2026-03-01"), row("mc-manager", "minecraft-manager", "2026-01-01")];
        expect(await adoptGameServersApp(OWNER)).toBe("mc-manager");
        expect(find("mc-manager")?.catalogId).toBe(GAME_SERVERS_APP_ID);
        expect(find("ark-manager")?.status).toBe("removed");
    });

    it("keeps the new app and retires a manager left beside it", async () => {
        rows = [row("games", GAME_SERVERS_APP_ID, "2026-05-01"), row("mc-manager", "minecraft-manager", "2026-01-01")];
        expect(await adoptGameServersApp(OWNER)).toBe("games");
        expect(find("mc-manager")?.status).toBe("removed");
        expect(find("games")?.catalogId).toBe(GAME_SERVERS_APP_ID);
    });

    it("touches nothing that is not a manager", async () => {
        // The servers themselves. Losing one of these is losing somebody's world.
        rows = [
            row("mc-manager", "minecraft-manager", "2026-01-01"),
            row("survival", "minecraft", "2026-01-02"),
            row("island", "ark", "2026-01-03"),
            row("bridge", "messaging-bridge", "2026-01-04")
        ];
        await adoptGameServersApp(OWNER);
        for (const id of ["survival", "island", "bridge"]) {
            expect(find(id)?.status, id).toBe("running");
        }
        expect(find("survival")?.catalogId).toBe("minecraft");
    });

    it("says nothing is on for somebody who never turned it on", async () => {
        rows = [row("bridge", "messaging-bridge", "2026-01-04")];
        expect(await adoptGameServersApp(OWNER)).toBeNull();
        expect(find("bridge")?.status).toBe("running");
    });

    it("does nothing the second time", async () => {
        rows = [row("mc-manager", "minecraft-manager", "2026-01-01"), row("ark-manager", "ark-manager", "2026-03-01")];
        const first = await adoptGameServersApp(OWNER);
        const before = JSON.stringify(rows);
        expect(await adoptGameServersApp(OWNER)).toBe(first);
        expect(JSON.stringify(rows)).toBe(before);
    });
});

describe("turning it on", () => {
    it("installs the app when there is nothing to adopt", async () => {
        expect(await installGameServersApp(OWNER, OWNER)).toBe("fresh");
        expect(installed).toEqual([GAME_SERVERS_APP_ID]);
    });

    it("adopts rather than installing a second one beside a manager", async () => {
        rows = [row("mc-manager", "minecraft-manager", "2026-01-01")];
        expect(await installGameServersApp(OWNER, OWNER)).toBe("mc-manager");
        expect(installed).toEqual([]);
    });
});
