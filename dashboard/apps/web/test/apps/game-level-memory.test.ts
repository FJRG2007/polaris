/**
 * The last level each player was seen on is written from every status poll, so a
 * poll that learns nothing new must not be a write.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { installedAppId: string; username: string; level: number; levelAt: Date };
const rows = new Map<string, Row>();
let writes = 0;

vi.mock("@polaris/db", () => ({
    prisma: {
        gamePlayerStat: {
            findMany: async ({ where }: { where: { username?: { in: string[] } } }) =>
                [...rows.values()].filter(
                    (row) => !where.username || where.username.in.includes(row.username)
                ),
            upsert: async (args: {
                create: Row;
                update: Pick<Row, "level" | "levelAt">;
                where: { installedAppId_username: { username: string } };
            }) => {
                writes += 1;
                const name = args.where.installedAppId_username.username;
                const current = rows.get(name);
                rows.set(name, current ? { ...current, ...args.update } : args.create);
            }
        }
    }
}));

const { rememberLevels } = await import("@/lib/apps/minecraft/level-memory");

const SERVER = "server";
const START = new Date("2026-01-01T00:00:00Z");
const later = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

beforeEach(() => {
    rows.clear();
    writes = 0;
});

describe("remembering levels", () => {
    it("writes a player seen for the first time", async () => {
        await rememberLevels(SERVER, { Alice: 3 }, START);
        expect(rows.get("Alice")).toMatchObject({ level: 3, levelAt: START });
        expect(writes).toBe(1);
    });

    it("skips an unchanged level that was dated recently", async () => {
        await rememberLevels(SERVER, { Alice: 3 }, START);
        await rememberLevels(SERVER, { Alice: 3 }, later(1));
        expect(writes).toBe(1);
        expect(rows.get("Alice")?.levelAt).toEqual(START);
    });

    it("writes a changed level, and an unchanged one whose date has gone stale", async () => {
        await rememberLevels(SERVER, { Alice: 3, Bob: 7 }, START);
        await rememberLevels(SERVER, { Alice: 4, Bob: 7 }, later(1));
        expect(rows.get("Alice")?.level).toBe(4);
        expect(writes).toBe(3);
        await rememberLevels(SERVER, { Alice: 4, Bob: 7 }, later(10));
        expect(rows.get("Bob")?.levelAt).toEqual(later(10));
        expect(rows.get("Alice")?.levelAt).toEqual(later(1));
        expect(writes).toBe(4);
    });

    it("writes nothing for an answer with no usable level", async () => {
        await rememberLevels(SERVER, { Alice: -1, Bob: 1.5 }, START);
        expect(writes).toBe(0);
    });
});
