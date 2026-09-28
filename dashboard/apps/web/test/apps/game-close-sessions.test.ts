/**
 * Closing every open visit on a server that has stopped, been deleted, or been
 * reset - and telling the accounts behind those players, so a "Playing
 * Minecraft" card does not outlive the server it was on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    sessions: [] as { id: string; installedAppId: string; name: string; leftAt: Date | null }[],
    links: [] as { installedAppId: string; player: string; userId: string }[],
    announced: [] as string[][]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        gamePlayerSession: {
            findMany: async ({ where }: { where: { installedAppId: string; leftAt: null } }) =>
                fake.sessions
                    .filter((row) => row.installedAppId === where.installedAppId && row.leftAt === null)
                    .map((row) => ({ id: row.id, name: row.name })),
            updateMany: async ({
                where,
                data
            }: {
                where: { id?: { in: string[] }; installedAppId?: string; leftAt?: null };
                data: { leftAt: Date };
            }) => {
                let count = 0;
                for (const row of fake.sessions) {
                    const matches = where.id
                        ? where.id.in.includes(row.id)
                        : row.installedAppId === where.installedAppId;
                    if (matches && row.leftAt === null) {
                        row.leftAt = data.leftAt;
                        count++;
                    }
                }
                return { count };
            }
        },
        gamePlayerLink: {
            findMany: async ({ where }: { where: { installedAppId: string } }) =>
                fake.links.filter((link) => link.installedAppId === where.installedAppId)
        }
    }
}));

vi.mock("@/lib/presence-activity/live", () => ({
    announceActivity: async (ids: string[]) => {
        fake.announced.push(ids);
    }
}));

const { closeGameSessions } = await import("@polaris-app/game-servers/src/lib/games-activity-service");

beforeEach(() => {
    fake.sessions = [];
    fake.links = [];
    fake.announced = [];
});

describe("closing every visit on a server nobody is going to ask again", () => {
    it("closes the open visits and tells the accounts behind them, so their card clears", async () => {
        fake.sessions = [
            { id: "1", installedAppId: "s1", name: "AdaPlays", leftAt: null },
            { id: "2", installedAppId: "s1", name: "Other", leftAt: new Date("2026-09-28T09:00:00.000Z") }
        ];
        fake.links = [{ installedAppId: "s1", player: "adaplays", userId: "ada" }];

        await closeGameSessions("s1", new Date("2026-09-28T12:00:00.000Z"));

        expect(fake.sessions.find((row) => row.id === "1")?.leftAt).toEqual(
            new Date("2026-09-28T12:00:00.000Z")
        );
        // The already-closed visit is left exactly as it was.
        expect(fake.sessions.find((row) => row.id === "2")?.leftAt).toEqual(
            new Date("2026-09-28T09:00:00.000Z")
        );
        expect(fake.announced).toEqual([["ada"]]);
    });

    it("does nothing, and tells nobody, when the server had no one on it", async () => {
        await closeGameSessions("s1", new Date());
        expect(fake.announced).toEqual([]);
    });
});
