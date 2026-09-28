/**
 * What somebody is doing, written by the desktop app and read for the faces that
 * show it.
 *
 * What is pinned:
 * - a reader is told only what the person's `activity` audience allows, and
 *   nothing at all when they switched sharing off - on read, so the switch
 *   takes effect before the next report;
 * - a hidden game is never stored, and never shown if it somehow was;
 * - a row past its lapse is not read;
 * - a report's start is a claim, clamped so a fast clock cannot put somebody's
 *   game in the future;
 * - the screens are told when there is something new to see, and not on the
 *   heartbeat that merely keeps a card alive;
 * - Minecraft on a server here and Minecraft on the computer are one card.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
    userId: string;
    source: string;
    key: string;
    name: string;
    details: string;
    state: string;
    imageUrl: string | null;
    linkUrl: string | null;
    startedAt: Date;
    endsAt: Date | null;
    expiresAt: Date;
};

const fake = vi.hoisted(() => ({
    rows: [] as Row[],
    settings: new Map<string, Record<string, unknown>>(),
    allowed: new Set<string>(),
    playing: new Map<string, { userId: string; game: string; server: string; since: Date }>(),
    announced: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        userActivity: {
            findUnique: async ({ where }: { where: { userId_source: { userId: string; source: string } } }) =>
                fake.rows.find(
                    (row) =>
                        row.userId === where.userId_source.userId && row.source === where.userId_source.source
                ) ?? null,
            findMany: async ({ where }: { where: { userId: { in: string[] }; expiresAt: { gt: Date } } }) =>
                fake.rows.filter((row) => where.userId.in.includes(row.userId) && row.expiresAt > where.expiresAt.gt),
            upsert: async ({
                where,
                create,
                update
            }: {
                where: { userId_source: { userId: string; source: string } };
                create: Row;
                update: Partial<Row>;
            }) => {
                const found = fake.rows.find(
                    (row) =>
                        row.userId === where.userId_source.userId && row.source === where.userId_source.source
                );
                if (found) Object.assign(found, update);
                else fake.rows.push({ ...create });
            },
            deleteMany: async ({ where }: { where: { userId: string; source: string; expiresAt?: Date } }) => {
                const before = fake.rows.length;
                fake.rows = fake.rows.filter(
                    (row) =>
                        !(
                            row.userId === where.userId &&
                            row.source === where.source &&
                            (!where.expiresAt || row.expiresAt.getTime() === where.expiresAt.getTime())
                        )
                );
                return { count: before - fake.rows.length };
            }
        },
        userActivitySettings: {
            findUnique: async ({ where }: { where: { userId: string } }) => fake.settings.get(where.userId) ?? null,
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((id) => fake.settings.has(id))
                    .map((id) => ({ userId: id, ...fake.settings.get(id) })),
            upsert: async ({
                where,
                create,
                update
            }: {
                where: { userId: string };
                create: Record<string, unknown>;
                update: Record<string, unknown>;
            }) => {
                const held = fake.settings.get(where.userId);
                fake.settings.set(where.userId, held ? { ...held, ...update } : { ...defaults(), ...create });
            }
        }
    }
}));
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (_viewer: unknown, field: string, ids: string[]) => {
        expect(field).toBe("activity");
        return new Set(ids.filter((id) => fake.allowed.has(id)));
    }
}));
vi.mock("@/lib/app-extensions/registry", () => ({
    playingNowFor: async (ids: string[]) =>
        new Map([...fake.playing].filter(([id]) => ids.includes(id)))
}));
vi.mock("@/lib/presence-activity/live", () => ({
    announceActivity: async (ids: string[]) => {
        fake.announced.push(...ids);
    }
}));

function defaults(): Record<string, unknown> {
    return {
        share: true,
        spotify: true,
        games: true,
        minecraft: true,
        hiddenGames: "[]",
        customGames: "[]",
        seenGames: "[]"
    };
}

const { activitiesFor, reportGame } = await import("@/lib/presence-activity/service");

const VIEWER = { id: "viewer", isAdmin: false };
const NOW = new Date("2026-09-28T12:00:00.000Z");

function game(key: string, name: string, startedAt = "2026-09-28T11:00:00.000Z") {
    return { game: { key, name, startedAt } };
}

beforeEach(() => {
    fake.rows = [];
    fake.settings.clear();
    fake.allowed = new Set(["ada", "bob"]);
    fake.playing.clear();
    fake.announced = [];
});

describe("a report from the desktop app", () => {
    it("is shown, and announced once rather than on every heartbeat", async () => {
        expect(await reportGame("ada", game("celeste.exe", "Celeste"), NOW)).toEqual({ shown: true });
        expect(fake.announced).toEqual(["ada"]);

        await reportGame("ada", game("celeste.exe", "Celeste"), new Date(NOW.getTime() + 60_000));
        expect(fake.announced).toEqual(["ada"]);

        const found = await activitiesFor(VIEWER, ["ada"], NOW);
        expect(found.get("ada")).toEqual([
            expect.objectContaining({ source: "game", key: "celeste.exe", name: "Celeste", endsAt: null })
        ]);
    });

    it("clamps a start in the future to now", async () => {
        await reportGame("ada", game("celeste.exe", "Celeste", "2030-01-01T00:00:00.000Z"), NOW);
        expect(fake.rows[0]?.startedAt.toISOString()).toBe(NOW.toISOString());
    });

    it("stores nothing for a hidden game, but remembers it so it can be shown again", async () => {
        fake.settings.set("ada", { ...defaults(), hiddenGames: '["celeste.exe"]' });
        expect(await reportGame("ada", game("celeste.exe", "Celeste"), NOW)).toEqual({
            shown: false,
            reason: "hidden"
        });
        expect(fake.rows).toHaveLength(0);
        expect(JSON.parse(String(fake.settings.get("ada")?.seenGames))[0]).toMatchObject({
            key: "celeste.exe",
            name: "Celeste"
        });
    });

    it("stores nothing with games switched off", async () => {
        fake.settings.set("ada", { ...defaults(), games: false });
        expect((await reportGame("ada", game("celeste.exe", "Celeste"), NOW)).reason).toBe("off");
        expect(fake.rows).toHaveLength(0);
    });

    it("takes the card down when nothing is running, and says so", async () => {
        await reportGame("ada", game("celeste.exe", "Celeste"), NOW);
        fake.announced = [];
        await reportGame("ada", { game: null }, NOW);
        expect(fake.rows).toHaveLength(0);
        expect(fake.announced).toEqual(["ada"]);
    });

    it("tidies a card past its lapse without telling anybody", async () => {
        await reportGame("ada", game("celeste.exe", "Celeste"), NOW);
        fake.announced = [];
        await reportGame("ada", { game: null }, new Date(NOW.getTime() + 60 * 60_000));
        expect(fake.rows).toHaveLength(0);
        expect(fake.announced).toEqual([]);
    });
});

describe("what a reader is told", () => {
    it("is nothing about somebody whose audience leaves them out", async () => {
        await reportGame("ada", game("celeste.exe", "Celeste"), NOW);
        fake.allowed = new Set();
        expect((await activitiesFor(VIEWER, ["ada"], NOW)).size).toBe(0);
    });

    it("is nothing once sharing is off, without waiting for another report", async () => {
        await reportGame("ada", game("celeste.exe", "Celeste"), NOW);
        fake.settings.set("ada", { ...defaults(), share: false });
        expect((await activitiesFor(VIEWER, ["ada"], NOW)).size).toBe(0);
    });

    it("never includes a game hidden after it was stored, or one past its lapse", async () => {
        await reportGame("ada", game("celeste.exe", "Celeste"), NOW);
        await reportGame("bob", game("tetris.exe", "Tetris"), NOW);
        fake.settings.set("ada", { ...defaults(), hiddenGames: '["celeste.exe"]' });
        const later = new Date(NOW.getTime() + 10 * 60_000);
        const found = await activitiesFor(VIEWER, ["ada", "bob"], NOW);
        expect(found.get("ada") ?? []).toHaveLength(0);
        expect(found.get("bob")).toHaveLength(1);
        expect((await activitiesFor(VIEWER, ["bob"], later)).size).toBe(0);
    });

    it("draws a server here as one card with the game on the computer", async () => {
        await reportGame("ada", game("javaw.exe", "Minecraft"), NOW);
        fake.playing.set("ada", { userId: "ada", game: "Minecraft", server: "Survival", since: NOW });
        const found = await activitiesFor(VIEWER, ["ada"], NOW);
        expect(found.get("ada")).toEqual([
            expect.objectContaining({ source: "minecraft", name: "Minecraft", details: "Survival" })
        ]);
    });

    it("leaves the server out for somebody who switched Minecraft off", async () => {
        fake.settings.set("ada", { ...defaults(), minecraft: false });
        fake.playing.set("ada", { userId: "ada", game: "Minecraft", server: "Survival", since: NOW });
        expect((await activitiesFor(VIEWER, ["ada"], NOW)).size).toBe(0);
    });
});
