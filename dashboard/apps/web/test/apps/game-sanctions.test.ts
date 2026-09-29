/**
 * The bans, timeouts and kicks a game server put on its players, as the linked
 * account's standing page reads them: only players linked to that account, only
 * servers that still exist, what is still in force told apart from what is
 * over, and a pardon or a newer sanction closing the one before it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Row {
    id: string;
    installedAppId: string;
    player: string;
    kind: string;
    reason: string | null;
    at: Date;
    until: Date | null;
    liftedAt: Date | null;
}

const fake = vi.hoisted(() => ({
    links: [] as { installedAppId: string; player: string; userId: string }[],
    installs: [] as { id: string; catalogId: string; name: string; status: string }[],
    rows: [] as Row[],
    sanctionQuery: null as unknown
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
    const pairs = where.OR as { installedAppId: string; player: string }[];
    return pairs.some((pair) => pair.installedAppId === row.installedAppId && pair.player === row.player);
}

vi.mock("@polaris/db", () => ({
    prisma: {
        gamePlayerLink: {
            findMany: async ({ where }: { where: { userId: string } }) =>
                fake.links.filter((link) => link.userId === where.userId)
        },
        installedApp: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                fake.installs.filter(
                    (install) => where.id.in.includes(install.id) && install.status !== "removed"
                )
        },
        gameSanction: {
            findMany: async ({ where }: { where: Record<string, unknown> }) => {
                fake.sanctionQuery = where;
                return fake.rows
                    .filter((row) => matches(row, where))
                    .sort((left, right) => right.at.getTime() - left.at.getTime());
            },
            create: async ({ data }: { data: Omit<Row, "id" | "at" | "liftedAt"> }) => {
                fake.rows.push({ ...data, id: `r${fake.rows.length + 1}`, at: new Date(), liftedAt: null });
            },
            updateMany: async ({
                where,
                data
            }: {
                where: { installedAppId: string; player: string; kind: { in: string[] } };
                data: { liftedAt: Date };
            }) => {
                for (const row of fake.rows) {
                    if (
                        row.installedAppId === where.installedAppId &&
                        row.player === where.player &&
                        where.kind.in.includes(row.kind) &&
                        row.liftedAt === null
                    )
                        row.liftedAt = data.liftedAt;
                }
            }
        }
    }
}));

const service = await import("@polaris-app/game-servers/src/lib/sanctions-service");
const pure = await import("@polaris-app/game-servers/src/lib/sanctions");

function row(overrides: Partial<Row>): Row {
    return {
        id: "r",
        installedAppId: "survival",
        player: "ada",
        kind: "ban",
        reason: null,
        at: new Date(NOW.getTime() - DAY),
        until: null,
        liftedAt: null,
        ...overrides
    };
}

beforeEach(() => {
    fake.links = [
        { installedAppId: "survival", player: "Ada", userId: "u-ada" },
        { installedAppId: "ark", player: "76561198000000001", userId: "u-ada" },
        { installedAppId: "survival", player: "Grace", userId: "u-grace" }
    ];
    fake.installs = [
        { id: "survival", catalogId: "minecraft", name: "Survival", status: "running" },
        { id: "ark", catalogId: "ark", name: "The Island", status: "running" },
        { id: "gone", catalogId: "minecraft", name: "Old world", status: "removed" }
    ];
    fake.rows = [];
    fake.sanctionQuery = null;
});

describe("what is still in force", () => {
    it("is a ban until pardoned, a timeout until its end, and never a kick", () => {
        const at = new Date(NOW.getTime() - HOUR);
        expect(pure.sanctionActive({ kind: "ban", at, until: null, liftedAt: null }, NOW)).toBe(true);
        expect(pure.sanctionActive({ kind: "ban", at, until: null, liftedAt: NOW }, NOW)).toBe(false);
        expect(
            pure.sanctionActive({ kind: "timeout", at, until: new Date(NOW.getTime() + HOUR), liftedAt: null }, NOW)
        ).toBe(true);
        expect(
            pure.sanctionActive({ kind: "timeout", at, until: new Date(NOW.getTime() - 1), liftedAt: null }, NOW)
        ).toBe(false);
        expect(pure.sanctionActive({ kind: "kick", at, until: null, liftedAt: null }, NOW)).toBe(false);
    });
});

describe("the sanctions on an account's players", () => {
    it("lists only players linked to that account, named as the link spells them", async () => {
        fake.rows = [
            row({ id: "mine", player: "ada", reason: "Griefing" }),
            row({ id: "theirs", player: "grace" }),
            row({ id: "stranger", player: "notch" })
        ];
        const listed = await service.sanctionsForUser("u-ada", NOW);
        expect(listed.map((sanction) => sanction.id)).toEqual(["mine"]);
        expect(listed[0]).toMatchObject({
            kind: "ban",
            game: "Minecraft",
            server: "Survival",
            player: "Ada",
            active: true,
            reason: "Griefing",
            until: null
        });
    });

    it("is nothing for an account with no linked player", async () => {
        fake.rows = [row({ player: "ada" })];
        expect(await service.sanctionsForUser("u-nobody", NOW)).toEqual([]);
        expect(fake.sanctionQuery).toBeNull();
    });

    it("tells an active timeout from an expired one, and lists the active first", async () => {
        fake.rows = [
            row({
                id: "expired",
                kind: "timeout",
                at: new Date(NOW.getTime() - 2 * HOUR),
                until: new Date(NOW.getTime() - HOUR)
            }),
            row({
                id: "active",
                kind: "timeout",
                at: new Date(NOW.getTime() - 3 * HOUR),
                until: new Date(NOW.getTime() + HOUR)
            }),
            row({ id: "kick", kind: "kick", at: new Date(NOW.getTime() - HOUR) })
        ];
        const listed = await service.sanctionsForUser("u-ada", NOW);
        expect(listed.map((sanction) => [sanction.id, sanction.active])).toEqual([
            ["active", true],
            ["kick", false],
            ["expired", false]
        ]);
    });

    it("drops what ended before the window, and servers that no longer exist", async () => {
        fake.links.push({ installedAppId: "gone", player: "Ada", userId: "u-ada" });
        fake.rows = [
            row({ id: "old-kick", kind: "kick", at: new Date(NOW.getTime() - 120 * DAY) }),
            row({ id: "old-ban", kind: "ban", at: new Date(NOW.getTime() - 120 * DAY) }),
            row({ id: "gone", installedAppId: "gone" })
        ];
        const listed = await service.sanctionsForUser("u-ada", NOW);
        expect(listed.map((sanction) => sanction.id)).toEqual(["old-ban"]);
    });

    it("finds an ARK ban by the Steam id the player is linked by", async () => {
        fake.rows = [row({ id: "ark", installedAppId: "ark", player: "76561198000000001" })];
        const [sanction] = await service.sanctionsForUser("u-ada", NOW);
        expect(sanction).toMatchObject({ game: "ARK: Survival Evolved", server: "The Island" });
    });
});

describe("recording a sanction", () => {
    it("closes the ban before it when a timeout replaces it, and a pardon closes the timeout", async () => {
        await service.recordSanction({ installedAppId: "survival", player: "Ada", kind: "ban", reason: " " });
        await service.recordSanction({ installedAppId: "survival", player: "Ada", kind: "kick" });
        await service.recordSanction({
            installedAppId: "survival",
            player: "ADA",
            kind: "timeout",
            reason: "Cool off",
            until: new Date(Date.now() + HOUR)
        });
        expect(fake.rows.map((held) => [held.kind, held.player, held.reason, held.liftedAt !== null])).toEqual([
            ["ban", "ada", null, true],
            ["kick", "ada", null, false],
            ["timeout", "ada", "Cool off", false]
        ]);
        await service.liftSanctions("survival", "Ada");
        expect(fake.rows.every((held) => held.kind === "kick" || held.liftedAt !== null)).toBe(true);
    });
});
