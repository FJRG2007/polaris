/**
 * Writing who is on into the record, the path both the minute's sweep and the live
 * feed take.
 *
 * Against an in-memory table rather than a mocked call list, because what matters is
 * the state it leaves behind: one open visit per player, begun when their current
 * connection began, whichever reader got there first and however often they asked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    installedAppId: string;
    name: string;
    playerId: string | null;
    joinedAt: Date;
    leftAt: Date | null;
}

const fake = vi.hoisted(() => ({ rows: [] as Row[], next: 0, announced: [] as string[][] }));

vi.mock("@polaris/db", () => ({
    prisma: {
        gamePlayerSession: {
            findMany: async ({
                where,
                orderBy
            }: {
                where: { installedAppId: string; leftAt: null };
                orderBy?: { joinedAt: "asc" | "desc" };
            }) => {
                const found = fake.rows.filter(
                    (row) => row.installedAppId === where.installedAppId && row.leftAt === null
                );
                if (orderBy) {
                    found.sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime());
                    if (orderBy.joinedAt === "desc") found.reverse();
                }
                // A tick of latency, so two passes started together really overlap.
                await new Promise((resolve) => setTimeout(resolve, 1));
                return found.map((row) => ({ ...row }));
            },
            updateMany: async ({
                where,
                data
            }: {
                where: { id: { in: string[] }; leftAt?: null; playerId?: null };
                data: { leftAt?: Date; playerId?: string };
            }) => {
                let count = 0;
                for (const row of fake.rows) {
                    if (!where.id.in.includes(row.id)) continue;
                    if (where.leftAt === null && row.leftAt !== null) continue;
                    Object.assign(row, data);
                    count++;
                }
                return { count };
            },
            createMany: async ({ data }: { data: Omit<Row, "id" | "leftAt">[] }) => {
                for (const row of data) fake.rows.push({ ...row, id: `v${++fake.next}`, leftAt: null });
                return { count: data.length };
            }
        },
        gamePlayerLink: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/presence-activity/live", () => ({
    announceActivity: async (ids: string[]) => {
        fake.announced.push(ids);
    }
}));

const { recordRoster } = await import("@polaris-app/game-servers/src/lib/games-activity-service");
const { parsePlayerSessions } = await import("@polaris-app/game-servers/src/lib/minecraft/sessions");

const SERVER = "aaaaaaaa-1111-4111-8111-111111111111";
const FJ = [{ name: "FJRG2007", id: null }];

/** A NeoForge 1.21.4 console line as docker returns it. */
function line(stamp: string, logger: string, message: string): string {
    return `${stamp} [${stamp.slice(11, 19)}] [Server thread/INFO] [minecraft/${logger}]: ${message}`;
}

function logOf(...lines: string[]) {
    const events = parsePlayerSessions(lines.join("\n"));
    return async () => events;
}

const at = (iso: string) => new Date(iso);

beforeEach(() => {
    fake.rows = [];
    fake.next = 0;
    fake.announced = [];
});

describe("recordRoster", () => {
    it("opens a visit at the log's arrival, and splits it at a reconnect no look saw", async () => {
        const firstLog = logOf(
            line("2026-09-29T08:00:00.000000000Z", "PlayerList", "FJRG2007[/203.0.113.9:51001] logged in with entity id 1 at (0.5, 64.0, 0.5)"),
            line("2026-09-29T08:00:00.500000000Z", "MinecraftServer", "FJRG2007 joined the game")
        );
        await recordRoster(SERVER, FJ, at("2026-09-29T08:00:40.000Z"), { log: "always", readLog: firstLog });
        expect(fake.rows).toMatchObject([
            { name: "FJRG2007", joinedAt: at("2026-09-29T08:00:00.000Z"), leftAt: null }
        ]);

        // Between two looks a minute apart he dropped and came back.
        const secondLog = logOf(
            line("2026-09-29T08:00:00.000000000Z", "PlayerList", "FJRG2007[/203.0.113.9:51001] logged in with entity id 1 at (0.5, 64.0, 0.5)"),
            line("2026-09-29T08:00:00.500000000Z", "MinecraftServer", "FJRG2007 joined the game"),
            line("2026-09-29T08:30:10.000000000Z", "ServerGamePacketListenerImpl", "FJRG2007 lost connection: Timed out"),
            line("2026-09-29T08:30:10.100000000Z", "MinecraftServer", "FJRG2007 left the game"),
            line("2026-09-29T08:30:30.000000000Z", "PlayerList", "FJRG2007[/203.0.113.9:51002] logged in with entity id 2 at (0.5, 64.0, 0.5)"),
            line("2026-09-29T08:30:30.400000000Z", "MinecraftServer", "FJRG2007 joined the game")
        );
        const record = await recordRoster(SERVER, FJ, at("2026-09-29T08:30:40.000Z"), {
            log: "always",
            readLog: secondLog
        });
        expect(fake.rows).toMatchObject([
            { joinedAt: at("2026-09-29T08:00:00.000Z"), leftAt: at("2026-09-29T08:30:10.000Z") },
            { joinedAt: at("2026-09-29T08:30:30.000Z"), leftAt: null }
        ]);
        expect(record.since.get("@fjrg2007")).toEqual(at("2026-09-29T08:30:30.000Z"));

        // The next look, with nothing new in the log, changes nothing.
        await recordRoster(SERVER, FJ, at("2026-09-29T08:31:40.000Z"), { log: "always", readLog: secondLog });
        expect(fake.rows).toHaveLength(2);
    });

    it("never opens two visits for one arrival when the sweep and a screen look at once", async () => {
        const now = at("2026-09-29T09:00:00.000Z");
        await Promise.all([
            recordRoster(SERVER, FJ, now, { log: "always", readLog: async () => null }),
            recordRoster(SERVER, FJ, now, { log: "changes", readLog: async () => null }),
            recordRoster(SERVER, FJ, now)
        ]);
        expect(fake.rows.filter((row) => row.leftAt === null)).toHaveLength(1);
    });

    it("closes a visit once the server stops listing them, log or no log", async () => {
        await recordRoster(SERVER, FJ, at("2026-09-29T09:00:00.000Z"));
        const record = await recordRoster(SERVER, [], at("2026-09-29T10:00:00.000Z"), {
            log: "changes",
            readLog: async () => {
                throw new Error("the log could not be read");
            }
        });
        expect(fake.rows).toMatchObject([{ leftAt: at("2026-09-29T10:00:00.000Z") }]);
        expect(record.since.size).toBe(0);
    });

    it("reads the log on a live look only when somebody arrived or left", async () => {
        let reads = 0;
        const readLog = async () => {
            reads++;
            return null;
        };
        await recordRoster(SERVER, FJ, at("2026-09-29T09:00:00.000Z"), { log: "changes", readLog });
        await recordRoster(SERVER, FJ, at("2026-09-29T09:00:03.000Z"), { log: "changes", readLog });
        await recordRoster(SERVER, FJ, at("2026-09-29T09:00:06.000Z"), { log: "changes", readLog });
        expect(reads).toBe(1);
        await recordRoster(SERVER, FJ, at("2026-09-29T09:01:00.000Z"), { log: "always", readLog });
        expect(reads).toBe(2);
    });
});
