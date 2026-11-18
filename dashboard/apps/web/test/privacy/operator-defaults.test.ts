/**
 * Administrator defaults, and the two reciprocal settings added beside the ticks.
 *
 * A null column is "never chosen" and follows the operator's default - existing
 * accounts included - while a value somebody stored is theirs. A save sends
 * every row, so it must only write the fields the person actually moved, or one
 * change would freeze every other field at today's default.
 *
 * "Last seen" and typing are reciprocal like read receipts: hide yours and you
 * see nobody's. An administrator sees through.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    /** Stored rows by account: column -> value (null for never chosen). */
    rows: new Map<string, Record<string, string | null>>(),
    /** The Setting table. */
    settings: new Map<string, string>(),
    /** What the last upsert wrote. */
    written: null as Record<string, unknown> | null
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        userPrivacy: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((userId) => state.rows.has(userId))
                    .map((userId) => ({ userId, ...state.rows.get(userId) })),
            findUnique: async ({ where }: { where: { userId: string } }) =>
                state.rows.get(where.userId) ?? null,
            upsert: async ({ update }: { update: Record<string, unknown> }) => {
                state.written = update;
                return {};
            }
        },
        setting: {
            findUnique: async ({ where }: { where: { key: string } }) =>
                state.settings.has(where.key) ? { value: state.settings.get(where.key) } : null,
            findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
                where.key.in
                    .filter((key) => state.settings.has(key))
                    .map((key) => ({ key, value: state.settings.get(key) }))
        },
        privacyFieldList: {
            findMany: async () => [],
            findUnique: async () => null,
            deleteMany: async () => ({ count: 0 }),
            upsert: async () => ({})
        },
        privacyList: {
            count: async () => 0,
            deleteMany: async () => ({ count: 0 })
        },
        privacyListMember: { findMany: async () => [] },
        follow: { findMany: async () => [] },
        friendship: { findMany: async () => [] },
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
    }
}));

vi.mock("@/lib/friends-service", () => ({ friendIds: async () => new Set<string>() }));

const service = await import("@/lib/privacy-service");
const core = await import("@polaris/core");

const viewer = { id: "me", isAdmin: false };

beforeEach(() => {
    state.rows = new Map();
    state.settings = new Map();
    state.written = null;
});

describe("resolvedAudience", () => {
    it("prefers the stored choice, then the operator's default, then the code's", () => {
        expect(core.resolvedAudience("email", "everyone", "friends")).toBe("everyone");
        expect(core.resolvedAudience("email", null, "friends")).toBe("friends");
        expect(core.resolvedAudience("email", null, null)).toBe("nobody");
    });

    it("ignores an operator default that names a list or that the field does not offer", () => {
        expect(core.resolvedAudience("avatar", null, "only")).toBe("everyone");
        expect(core.resolvedAudience("profile", null, "followers")).toBe("everyone");
    });
});

describe("operator defaults", () => {
    it("reach an account with no row and an account whose column is null", async () => {
        state.settings.set("privacy.defaults.avatar", "nobody");
        state.rows.set("b", { avatar: null });
        state.rows.set("c", { avatar: "everyone" });
        expect(await service.allowedBy(viewer, "avatar", ["a", "b", "c"])).toEqual(new Set(["c"]));
    });

    it("keep the follower lists on the key they always had", async () => {
        state.settings.set("profiles.followers.default", "nobody");
        expect((await service.privacyFor("a")).followers.audience).toBe("nobody");
        expect(service.privacyDefaultKey("followers")).toBe("profiles.followers.default");
    });

    it("refuse an audience that names a list", async () => {
        await expect(service.setDefaultAudience("avatar", "only")).rejects.toThrow();
    });
});

describe("setPrivacy", () => {
    it("writes only the field that moved and leaves the rest following the default", async () => {
        const settings = {
            ...core.DEFAULT_PRIVACY,
            avatar: { audience: "friends" as const, listId: null, people: [] }
        };
        await service.setPrivacy("me", settings);
        expect(state.written?.avatar).toBe("friends");
        expect(state.written?.profile).toBeNull();
        expect(state.written?.email).toBeNull();
        expect(state.written?.lastActive).toBeNull();
    });

    it("keeps a field the person already chose, even at the default value", async () => {
        state.rows.set("me", { profile: "everyone" });
        await service.setPrivacy("me", core.DEFAULT_PRIVACY);
        expect(state.written?.profile).toBe("everyone");
        expect(state.written?.avatar).toBeNull();
    });

    it("measures 'moved' against the operator's default, not the code's", async () => {
        state.settings.set("privacy.defaults.avatar", "friends");
        await service.setPrivacy("me", {
            ...core.DEFAULT_PRIVACY,
            avatar: { audience: "friends", listId: null, people: [] }
        });
        expect(state.written?.avatar).toBeNull();
    });
});

describe("reciprocal last seen and typing", () => {
    it("shows a time only to a viewer who shows theirs", async () => {
        state.rows.set("a", { lastActive: "everyone" });
        expect(await service.reciprocalAmong(viewer, "lastActive", ["a"])).toEqual(new Set(["a"]));
        state.rows.set("me", { lastActive: "nobody" });
        expect(await service.reciprocalAmong(viewer, "lastActive", ["a"])).toEqual(new Set());
    });

    it("hides it when the subject hides it, and an administrator sees through", async () => {
        state.rows.set("a", { lastActive: "nobody" });
        expect(await service.reciprocalAmong(viewer, "lastActive", ["a"])).toEqual(new Set());
        expect(
            await service.reciprocalAmong({ id: "me", isAdmin: true }, "lastActive", ["a"])
        ).toEqual(new Set(["a"]));
    });

    it("follows the operator's default for a viewer who never chose", async () => {
        state.settings.set("privacy.defaults.typing", "nobody");
        expect(await service.typingAllowed(viewer, "a")).toBe(false);
        state.rows.set("me", { typing: "everyone" });
        state.rows.set("a", { typing: "everyone" });
        expect(await service.typingAllowed(viewer, "a")).toBe(true);
    });

    it("never hides somebody's typing from themselves", async () => {
        state.rows.set("me", { typing: "nobody" });
        expect(await service.typingAllowed(viewer, "me")).toBe(true);
    });
});
