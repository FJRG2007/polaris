/**
 * An administrator can lock a privacy field to its default (ledger row 13).
 * A lock overrides what an account stored without erasing it, a save cannot
 * write past it, and with no lock set every account resolves as it did before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let stored = new Map<string, string | null>();
let settings = new Map<string, string>();
let upserts: { update: Record<string, unknown> }[] = [];
let listDeletes: { field: { notIn: string[] } }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        userPrivacy: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((userId) => stored.has(userId))
                    .map((userId) => ({ userId, lastSeen: stored.get(userId) })),
            findUnique: async ({ where }: { where: { userId: string } }) =>
                stored.has(where.userId) ? { lastSeen: stored.get(where.userId) } : null,
            upsert: (args: { update: Record<string, unknown> }) => {
                upserts.push(args);
                return args;
            }
        },
        privacyFieldList: {
            findMany: async () => [],
            deleteMany: (args: { where: { field: { notIn: string[] } } }) => {
                listDeletes.push(args.where);
                return args;
            },
            upsert: (args: unknown) => args
        },
        privacyList: { deleteMany: async () => ({ count: 0 }) },
        privacyListMember: { findMany: async () => [] },
        follow: { findMany: async () => [] },
        friendship: { findMany: async () => [] },
        $transaction: async (ops: unknown[]) => ops
    }
}));

vi.mock("@/lib/friends-service", () => ({ friendIds: async () => new Set<string>() }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    getSettings: async (keys: readonly string[]) =>
        new Map(keys.filter((key) => settings.has(key)).map((key) => [key, settings.get(key)!])),
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));

const core = await import("@polaris/core");
const privacy = await import("@/lib/privacy-service");

const viewer = { id: "viewer", isAdmin: false };

beforeEach(() => {
    stored = new Map();
    settings = new Map();
    upserts = [];
    listDeletes = [];
});

describe("resolvedAudience with a lock", () => {
    it("reads the person's own choice when unlocked, as before", () => {
        expect(core.resolvedAudience("lastSeen", "nobody", "friends")).toBe("nobody");
        expect(core.resolvedAudience("lastSeen", "nobody", "friends", false)).toBe("nobody");
    });

    it("ignores the person's choice when locked", () => {
        expect(core.resolvedAudience("lastSeen", "everyone", "friends", true)).toBe("friends");
    });

    it("falls to the code's default when locked without an administrator default", () => {
        expect(core.resolvedAudience("email", "everyone", null, true)).toBe("nobody");
    });
});

describe("a locked field, enforced on the server", () => {
    it("lets a stranger see an open last-seen while nothing is locked", async () => {
        stored.set("subject", "everyone");
        expect((await privacy.allowedBy(viewer, "lastSeen", ["subject"])).has("subject")).toBe(true);
    });

    it("holds every account to the default once locked", async () => {
        stored.set("subject", "everyone");
        await privacy.setDefaultAudience("lastSeen", "nobody");
        await privacy.setPrivacyLock("lastSeen", true);
        expect((await privacy.allowedBy(viewer, "lastSeen", ["subject"])).has("subject")).toBe(false);
        expect((await privacy.privacyFor("subject")).lastSeen.audience).toBe("nobody");
    });

    it("gives the stored choice back when the lock is lifted", async () => {
        stored.set("subject", "everyone");
        await privacy.setDefaultAudience("lastSeen", "nobody");
        await privacy.setPrivacyLock("lastSeen", true);
        await privacy.setPrivacyLock("lastSeen", false);
        expect((await privacy.privacyFor("subject")).lastSeen.audience).toBe("everyone");
    });

    it("keeps the stored column and its list when a save names a locked field", async () => {
        stored.set("subject", "friends");
        await privacy.setPrivacyLock("lastSeen", true);
        const wanted = {
            ...core.DEFAULT_PRIVACY,
            lastSeen: { audience: "everyone" as const, listId: null, people: [] }
        };
        await privacy.setPrivacy("subject", wanted);
        expect(upserts[0]!.update.lastSeen).toBe("friends");
        expect(listDeletes[0]!.field.notIn).toContain("lastSeen");
    });
});
