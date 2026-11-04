/**
 * The badge service against an in-memory database: who may see whose badges,
 * who may hand one out, that an arrangement is kept as saved, and that rarity
 * counts everybody rather than the people whose profile was opened.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ADMIN = "00000000-0000-4000-8000-000000000001";
const ALICE = "00000000-0000-4000-8000-000000000002";
const BOB = "00000000-0000-4000-8000-000000000003";
const CAROL = "00000000-0000-4000-8000-000000000004";
const BADGE = "00000000-0000-4000-8000-0000000000b1";

interface Person {
    id: string;
    isAdmin: boolean;
    createdAt: Date;
    messages: number;
}
interface Unlock {
    userId: string;
    badge: string;
    level: number;
    unlockedAt: Date;
}
interface Pref {
    userId: string;
    badge: string;
    position: number;
    hidden: boolean;
    audience: string | null;
    listId: string | null;
    people: string[];
}

let people: Person[] = [];
let unlocks: Unlock[] = [];
let prefs: Pref[] = [];
let grants: { id: string; badgeId: string; userId: string; grantedAt: Date }[] = [];
let settings = new Map<string, string>();
/** Whether the account-wide `badges` rule lets the viewer through. */
let accountRuleAllows = true;
const upsertGrant = vi.fn();

const grantId = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;

const definitions = [{ id: BADGE, name: "Helper", description: "", icon: "star" }];

vi.mock("@polaris/db", () => ({
    Prisma: { sql: () => ({}), join: () => ({}) },
    prisma: {
        user: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                people.find((p) => p.id === where.id) ?? null,
            count: async (args?: { where?: { isAdmin?: boolean } }) =>
                people.filter(
                    (p) => args?.where?.isAdmin === undefined || p.isAdmin === args.where.isAdmin
                ).length,
            findMany: async ({ where, take }: { where: { id?: { gt: string } }; take: number }) =>
                [...people]
                    .sort((a, b) => a.id.localeCompare(b.id))
                    .filter((p) => !where.id || p.id > where.id.gt)
                    .slice(0, take)
        },
        chatMessage: {
            count: async ({ where }: { where: { authorId: string } }) =>
                people.find((p) => p.id === where.authorId)?.messages ?? 0
        },
        task: { count: async () => 0 },
        arcadeSessionPlayer: { count: async () => 0 },
        gamePlayerLink: { findMany: async () => [] },
        $queryRaw: async () => [{ seconds: 0 }],
        badgeGrant: {
            findMany: async (args: {
                where: { userId?: string; badgeId?: string };
                take?: number;
                cursor?: { id: string };
            }) => {
                if (args.where.badgeId) {
                    const ordered = grants
                        .filter((g) => g.badgeId === args.where.badgeId)
                        .sort((a, b) => b.id.localeCompare(a.id));
                    const start = args.cursor
                        ? ordered.findIndex((g) => g.id === args.cursor!.id) + 1
                        : 0;
                    return ordered.slice(start, start + (args.take ?? ordered.length)).map((g) => ({
                        id: g.id,
                        grantedAt: g.grantedAt,
                        user: { id: g.userId, name: g.userId, username: null }
                    }));
                }
                return grants
                    .filter((g) => g.userId === args.where.userId)
                    .map((g) => ({
                        grantedAt: g.grantedAt,
                        badge: definitions.find((d) => d.id === g.badgeId)!
                    }));
            },
            groupBy: async () =>
                [...new Set(grants.map((g) => g.badgeId))].map((badgeId) => ({
                    badgeId,
                    _count: { _all: grants.filter((g) => g.badgeId === badgeId).length }
                })),
            createMany: async ({ data }: { data: { badgeId: string; userId: string }[] }) => {
                upsertGrant(data);
                let count = 0;
                for (const row of data) {
                    if (grants.some((g) => g.badgeId === row.badgeId && g.userId === row.userId))
                        continue;
                    grants.push({ id: grantId(grants.length), ...row, grantedAt: new Date() });
                    count += 1;
                }
                return { count };
            },
            deleteMany: async ({ where }: { where: { badgeId: string; userId: string } }) => {
                grants = grants.filter(
                    (g) => !(g.badgeId === where.badgeId && g.userId === where.userId)
                );
                return { count: 1 };
            }
        },
        badgeDefinition: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                definitions.find((d) => d.id === where.id) ?? null
        },
        badgeUnlock: {
            findMany: async ({ where }: { where: { userId: string } }) =>
                unlocks.filter((u) => u.userId === where.userId),
            createMany: async ({ data }: { data: Unlock[] }) => {
                for (const row of data) {
                    const known = unlocks.some(
                        (u) =>
                            u.userId === row.userId &&
                            u.badge === row.badge &&
                            u.level === row.level
                    );
                    if (!known) unlocks.push(row);
                }
                return { count: data.length };
            },
            groupBy: async ({ where }: { where: { badge: { in: string[] } } }) => {
                const counts = new Map<string, { badge: string; level: number; n: number }>();
                for (const u of unlocks.filter((row) => where.badge.in.includes(row.badge))) {
                    const key = `${u.badge}#${u.level}`;
                    const entry = counts.get(key) ?? { badge: u.badge, level: u.level, n: 0 };
                    entry.n += 1;
                    counts.set(key, entry);
                }
                return [...counts.values()].map((e) => ({
                    badge: e.badge,
                    level: e.level,
                    _count: { _all: e.n }
                }));
            }
        },
        badgePreference: {
            findMany: async ({ where }: { where: { userId: string } }) =>
                prefs
                    .filter((p) => p.userId === where.userId)
                    .sort((a, b) => a.position - b.position),
            deleteMany: async ({
                where
            }: {
                where: { userId?: string; badge: string | { notIn: string[] } };
            }) => {
                prefs = prefs.filter((p) => {
                    if (where.userId && p.userId !== where.userId) return true;
                    if (typeof where.badge === "string") return p.badge !== where.badge;
                    return where.badge.notIn.includes(p.badge);
                });
                return { count: 0 };
            },
            upsert: async ({ create }: { create: Pref }) => {
                prefs = prefs.filter(
                    (p) => !(p.userId === create.userId && p.badge === create.badge)
                );
                prefs.push(create);
                return {};
            }
        },
        $transaction: async (steps: Promise<unknown>[]) => Promise.all(steps)
    }
}));

vi.mock("@/lib/privacy-service", () => ({
    maySee: async () => accountRuleAllows,
    ruleAllows: async (_viewer: unknown, _subject: string, rule: { audience: string }) =>
        rule.audience === "everyone",
    assertOwnPrivacyLists: async (_userId: string, ids: string[]) => {
        if (ids.length > 0) throw new Error("That list is not yours");
    }
}));

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));

const service = await import("../../src/lib/badges/badge-service");

const person = (id: string, messages: number, isAdmin = false): Person => ({
    id,
    isAdmin,
    createdAt: new Date(),
    messages
});

beforeEach(() => {
    people = [person(ADMIN, 0, true), person(ALICE, 60), person(BOB, 5), person(CAROL, 0)];
    unlocks = [];
    prefs = [];
    grants = [];
    settings = new Map();
    accountRuleAllows = true;
    upsertGrant.mockClear();
});

const keys = (badges: readonly { key: string }[]) => badges.map((badge) => badge.key);

describe("who sees somebody's badges", () => {
    it("shows nothing when the account's badges rule refuses the viewer", async () => {
        accountRuleAllows = false;
        const seen = await service.badgesFor(ALICE, { id: BOB, isAdmin: false });
        expect(seen).toEqual({ shown: [], available: [], arrangement: null });
        // Nobody signed in is refused the same way.
        expect((await service.badgesFor(ALICE, null)).shown).toEqual([]);
    });

    it("lets an allowed viewer see earned badges, but never what is left or the arrangement", async () => {
        const seen = await service.badgesFor(ALICE, { id: BOB, isAdmin: false });
        expect(keys(seen.shown)).toEqual(["ladder:messages"]);
        expect(seen.available).toEqual([]);
        expect(seen.arrangement).toBeNull();
    });

    it("keeps a hidden badge for its owner alone, administrators included", async () => {
        await service.saveArrangement(ALICE, [{ badge: "ladder:messages", hidden: true }]);
        const own = await service.badgesFor(ALICE, { id: ALICE, isAdmin: false });
        expect(keys(own.shown)).toEqual(["ladder:messages"]);
        expect(own.arrangement?.[0]).toMatchObject({ badge: "ladder:messages", hidden: true });
        expect(own.available.length).toBeGreaterThan(0);
        expect((await service.badgesFor(ALICE, { id: BOB, isAdmin: false })).shown).toEqual([]);
        expect((await service.badgesFor(ALICE, { id: ADMIN, isAdmin: true })).shown).toEqual([]);
    });

    it("applies a badge's own audience on top of the account's", async () => {
        await service.saveArrangement(ALICE, [{ badge: "ladder:messages", audience: "nobody" }]);
        expect((await service.badgesFor(ALICE, { id: BOB, isAdmin: false })).shown).toEqual([]);
        await service.saveArrangement(ALICE, [{ badge: "ladder:messages", audience: "everyone" }]);
        expect(keys((await service.badgesFor(ALICE, { id: BOB, isAdmin: false })).shown)).toEqual([
            "ladder:messages"
        ]);
    });
});

describe("custom badges are handed out by administrators only", () => {
    it("refuses a grant or a revoke from anybody else, before touching anything", async () => {
        const member = { id: BOB, isAdmin: false };
        await expect(service.grantBadge(member, BADGE, ALICE)).rejects.toBeInstanceOf(
            service.BadgeError
        );
        await expect(service.revokeBadge(member, BADGE, ALICE)).rejects.toBeInstanceOf(
            service.BadgeError
        );
        await expect(service.createDefinition(member, { name: "Mine" })).rejects.toBeInstanceOf(
            service.BadgeError
        );
        await expect(service.deleteDefinition(member, BADGE)).rejects.toBeInstanceOf(
            service.BadgeError
        );
        expect(upsertGrant).not.toHaveBeenCalled();
    });

    it("lets an administrator give one and take it back", async () => {
        const admin = { id: ADMIN, isAdmin: true };
        await service.grantBadge(admin, BADGE, ALICE);
        expect(
            keys((await service.badgesFor(ALICE, { id: ALICE, isAdmin: false })).shown)
        ).toContain(`custom:${BADGE}`);
        await service.revokeBadge(admin, BADGE, ALICE);
        expect(
            keys((await service.badgesFor(ALICE, { id: ALICE, isAdmin: false })).shown)
        ).not.toContain(`custom:${BADGE}`);
    });

    it("counts a grant once, however often it is given", async () => {
        const admin = { id: ADMIN, isAdmin: true };
        expect(await service.grantBadge(admin, BADGE, ALICE)).toBe(true);
        expect(await service.grantBadge(admin, BADGE, ALICE)).toBe(false);
        expect(grants).toHaveLength(1);
    });

    it("pages through every holder, past the first page", async () => {
        const admin = { id: ADMIN, isAdmin: true };
        for (let index = 0; index < 120; index++) {
            grants.push({
                id: grantId(index),
                badgeId: BADGE,
                userId: grantId(1000 + index),
                grantedAt: new Date()
            });
        }
        const seen = new Set<string>();
        let cursor: string | null = null;
        let pages = 0;
        do {
            const page = await service.holdersOf(admin, BADGE, { cursor });
            for (const holder of page.holders) seen.add(holder.id);
            cursor = page.next;
            pages += 1;
        } while (cursor && pages < 10);
        expect(seen.size).toBe(120);
        expect(pages).toBe(3);
        await expect(
            service.holdersOf(admin, BADGE, { cursor: "not-an-id" })
        ).rejects.toBeInstanceOf(service.BadgeError);
    });

    it("refuses an id that is not one", async () => {
        await expect(
            service.grantBadge({ id: ADMIN, isAdmin: true }, "nope", ALICE)
        ).rejects.toBeInstanceOf(service.BadgeError);
    });
});

describe("the owner's arrangement", () => {
    it("keeps the order and hiding as saved, and drops badges left out", async () => {
        grants.push({ id: grantId(0), badgeId: BADGE, userId: ALICE, grantedAt: new Date() });
        await service.saveArrangement(ALICE, [
            { badge: "ladder:messages", hidden: false },
            { badge: `custom:${BADGE}`, hidden: true }
        ]);
        await service.saveArrangement(ALICE, [
            { badge: `custom:${BADGE}`, hidden: true },
            { badge: "ladder:messages" }
        ]);
        const saved = await service.arrangementOf(ALICE);
        expect(saved.map((row) => [row.badge, row.hidden])).toEqual([
            [`custom:${BADGE}`, true],
            ["ladder:messages", false]
        ]);
        const own = await service.badgesFor(ALICE, { id: ALICE, isAdmin: false });
        expect(keys(own.shown)).toEqual([`custom:${BADGE}`, "ladder:messages"]);

        await service.saveArrangement(ALICE, [{ badge: "ladder:messages" }]);
        expect((await service.arrangementOf(ALICE)).map((row) => row.badge)).toEqual([
            "ladder:messages"
        ]);
    });

    it("refuses a badge named twice, an unknown badge, and a list that is not theirs", async () => {
        await expect(
            service.saveArrangement(ALICE, [
                { badge: "ladder:messages" },
                { badge: "ladder:messages" }
            ])
        ).rejects.toBeInstanceOf(service.BadgeError);
        await expect(
            service.saveArrangement(ALICE, [{ badge: "ladder:nope" }])
        ).rejects.toBeInstanceOf(service.BadgeError);
        await expect(
            service.saveArrangement(ALICE, [
                {
                    badge: "ladder:messages",
                    audience: "only",
                    listId: "00000000-0000-4000-8000-0000000000aa"
                }
            ])
        ).rejects.toThrow("not yours");
        expect(prefs).toEqual([]);
    });
});

describe("rarity", () => {
    it("counts every person once the sweep has passed, not only profiles somebody opened", async () => {
        const { people: reached } = await service.sweepBadgeUnlocks();
        expect(reached).toBe(4);
        // The pass reached the end, so the next one starts over.
        expect(settings.has("badges.unlockSweepCursor")).toBe(false);

        // Nobody opened Bob's profile; his level still counts. Alice (60) and
        // Bob (5) hold level 1 of four people; only Alice holds level 2.
        const alice = await service.evaluateBadges(ALICE);
        const messages = alice.find((badge) => badge.key === "ladder:messages")!;
        expect(messages.level).toBe(2);
        expect(messages.rarity).toBe(25);
        const bob = (await service.evaluateBadges(BOB)).find(
            (badge) => badge.key === "ladder:messages"
        )!;
        expect(bob.rarity).toBe(50);
    });

    it("gives Staff to administrators by themselves, and counts it from the role", async () => {
        await service.sweepBadgeUnlocks();
        const admin = await service.evaluateBadges(ADMIN);
        expect(admin[0]).toMatchObject({ key: "staff", owned: true, rarity: 25 });
        expect(keys(await service.evaluateBadges(CAROL))).not.toContain("staff");
    });

    it("is read from what the sweep stored, never counted while a profile draws", async () => {
        await service.evaluateBadges(ALICE);
        const before = (await service.evaluateBadges(BOB)).find(
            (badge) => badge.key === "ladder:messages"
        )!;
        expect(before.rarity).toBe(0);
        await service.sweepBadgeUnlocks();
        expect(JSON.parse(settings.get("badges.rarity")!)).toMatchObject({ staff: 25 });
    });

    it("dates a tenure level by the account's age, not by when it was noticed", async () => {
        const made = new Date("2024-01-01T00:00:00Z");
        people = [{ ...person(ALICE, 0), createdAt: made }];
        const now = new Date("2026-06-01T00:00:00Z");
        const tenure = (await service.evaluateBadges(ALICE, now)).find(
            (badge) => badge.key === "ladder:tenure"
        )!;
        expect(tenure.levels[0]!.unlockedAt).toBe(new Date("2024-01-08T00:00:00Z").toISOString());
        expect(tenure.levels[1]!.unlockedAt).toBe(new Date("2024-01-31T00:00:00Z").toISOString());
        expect(
            unlocks.find((row) => row.badge === "ladder:tenure" && row.level === 1)!.unlockedAt
        ).toEqual(new Date("2024-01-08T00:00:00Z"));
    });

    it("never moves the day a level was first reached", async () => {
        const first = new Date("2026-01-01T00:00:00Z");
        await service.sweepBadgeUnlocks(first);
        await service.sweepBadgeUnlocks(new Date("2026-06-01T00:00:00Z"));
        const messages = (await service.evaluateBadges(ALICE)).find(
            (badge) => badge.key === "ladder:messages"
        )!;
        expect(messages.unlockedAt).toBe(first.toISOString());
    });
});
