/**
 * Typing a whole address or handle into an "add somebody" field answers only
 * about accounts the person typing may find. An account whose owner said it may
 * not be found that way is answered exactly like no account at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADA = { id: "00000000-0000-4000-8000-0000000000a1", name: "Ada", username: "ada" };
const VIEWER = { id: "00000000-0000-4000-8000-0000000000b2", isAdmin: false };

const state = vi.hoisted(() => ({ findableByEmail: false, discoverable: true, admin: false }));

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        user: {
            findFirst: async ({ where }: { where: { OR: Record<string, unknown>[] } }) =>
                where.OR.some(
                    (clause) => clause.username === "ada" || clause.email === "ada@example.com"
                )
                    ? ADA
                    : null,
            findUnique: async () => ({ isAdmin: state.admin }),
            findMany: async ({ where }: { where: { OR: Record<string, unknown>[] } }) =>
                where.OR.some(
                    (clause) => clause.username === "ada" || clause.email === "ada@example.com"
                )
                    ? [{ id: ADA.id }]
                    : []
        }
    }
}));
vi.mock("@/lib/blocks", () => ({ blockedBetween: async () => new Set() }));
vi.mock("@/lib/friends-service", () => ({ friendIds: async () => [] }));
vi.mock("@/lib/privacy-service", () => ({
    discoverableBy: async (_viewer: unknown, ids: string[]) =>
        new Set(state.discoverable ? ids : []),
    allowedBy: async (_viewer: unknown, _field: string, ids: string[]) =>
        new Set(state.findableByEmail ? ids : [])
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => JSON.stringify({ usernameExact: true, emailExact: true }),
    setSetting: async () => undefined
}));
vi.mock("@/lib/rich-text/mention-service", () => ({ like: (term: string) => ({ contains: term }) }));

const { resolveNamedAccount } = await import("@/lib/people-search");

beforeEach(() => {
    state.findableByEmail = false;
    state.discoverable = true;
    state.admin = false;
});

describe("naming one account by what was typed", () => {
    it("finds somebody by their whole username", async () => {
        expect((await resolveNamedAccount(VIEWER, "@ada"))?.id).toBe(ADA.id);
    });

    it("answers an address its owner keeps unfindable exactly like no account", async () => {
        expect(await resolveNamedAccount(VIEWER, "ada@example.com")).toBeNull();
        expect(await resolveNamedAccount(VIEWER, "nobody@example.com")).toBeNull();
    });

    it("finds them by address once they allow it", async () => {
        state.findableByEmail = true;
        expect((await resolveNamedAccount(VIEWER, "ADA@example.com"))?.id).toBe(ADA.id);
    });

    it("hides somebody who may not be found at all, even by username", async () => {
        state.discoverable = false;
        expect(await resolveNamedAccount(VIEWER, "ada")).toBeNull();
    });

    it("lets an administrator name anybody, read from the account when not given", async () => {
        state.discoverable = false;
        state.admin = true;
        expect((await resolveNamedAccount({ id: VIEWER.id }, "ada@example.com"))?.id).toBe(ADA.id);
    });
});
