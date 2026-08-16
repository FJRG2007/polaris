/**
 * What a saved setting keeps, and what it lets go of.
 *
 * The people a rule names are only meaningful to three of the six audiences.
 * Moving a setting to "everybody" or "nobody" and saving has to drop them: a
 * name kept against a question that is no longer being asked is somebody's data
 * held for nothing, and it comes back on its own the day the audience changes -
 * a setting that quietly names people the person who set it never re-picked.
 *
 * Retention across the audiences that DO name people is the other half of the
 * rule and is asserted here too, because the obvious fix for the above breaks
 * it: switching "everybody except" to "only" must keep the two names that were
 * picked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    /** Every write, in order, as `model.operation` plus what it named. */
    written: [] as string[],
    /** The list a field is already pointing at, if any. */
    link: null as { list: { id: string; name: string } } | null
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        userPrivacy: {
            upsert: async () => {
                state.written.push("privacy.upsert");
                return {};
            }
        },
        privacyFieldList: {
            findUnique: async () => state.link,
            deleteMany: async ({ where }: { where: { field?: { notIn: string[] } } }) => {
                state.written.push(`link.keep:${(where.field?.notIn ?? []).join(",")}`);
                return { count: 0 };
            },
            upsert: async ({ where }: { where: { userId_field: { field: string } } }) => {
                state.written.push(`link.upsert:${where.userId_field.field}`);
                return {};
            }
        },
        privacyList: {
            count: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length,
            create: async () => {
                state.written.push("list.create");
                return { id: "list-new" };
            },
            deleteMany: async () => {
                state.written.push("list.forget-unused");
                return { count: 0 };
            }
        },
        privacyListMember: {
            deleteMany: async () => ({ count: 0 }),
            upsert: async ({ where }: { where: { listId_userId: { userId: string } } }) => {
                state.written.push(`member.upsert:${where.listId_userId.userId}`);
                return {};
            }
        },
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({ id }))
        },
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
    }
}));

vi.mock("@/lib/friends-service", () => ({ friendIds: async () => new Set<string>() }));

const { setPrivacy } = await import("@/lib/privacy-service");
const core = await import("@polaris/core");

/** The defaults with one field answered, which is what the screen sends. */
function settings(field: core.PrivacyField, rule: Partial<core.PrivacyRule>): core.PrivacySettings {
    return {
        ...core.DEFAULT_PRIVACY,
        [field]: { ...core.DEFAULT_PRIVACY[field], ...rule }
    };
}

beforeEach(() => {
    state.written = [];
    state.link = null;
});

describe("an audience that names people", () => {
    it("keeps them on a list of the setting's own", async () => {
        await setPrivacy("ada", settings("email", { audience: "only", people: ["bob"] }));
        expect(state.written).toContain("list.create");
        expect(state.written).toContain("member.upsert:bob");
        expect(state.written).toContain("link.upsert:email");
    });

    it("reuses the list it already has, so the names survive the change", async () => {
        // "Everybody except these two" to "only these two" is one act of
        // changing your mind, not a reason to re-pick anybody.
        state.link = { list: { id: "list-1", name: "" } };
        await setPrivacy("ada", settings("email", { audience: "everyoneExcept", people: ["bob"] }));
        expect(state.written).not.toContain("list.create");
        expect(state.written).toContain("member.upsert:bob");
    });
});

describe("an audience that names nobody in particular", () => {
    it("does not keep the people the row was carrying", async () => {
        // The regression: the screen holds the chips in its draft while the
        // dropdown moves, so the people arrive here with an audience that has no
        // use for them.
        await setPrivacy("ada", settings("email", { audience: "nobody", people: ["bob"] }));
        expect(state.written).not.toContain("list.create");
        expect(state.written).not.toContain("member.upsert:bob");
        expect(state.written).not.toContain("link.upsert:email");
    });

    it("lets go of the list a saved one was pointed at", async () => {
        await setPrivacy(
            "ada",
            settings("email", {
                audience: "everyone",
                listId: "11111111-1111-4111-8111-111111111111"
            })
        );
        expect(state.written).not.toContain("link.upsert:email");
        // Nothing points at the setting's own list any more, so it goes with it.
        expect(state.written).toContain("list.forget-unused");
    });
});
