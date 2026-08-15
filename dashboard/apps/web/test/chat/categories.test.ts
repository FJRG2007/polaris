/**
 * Headings inside a space, and the one guarantee they carry.
 *
 * A category is an arrangement and nothing else. It grants nothing, hides
 * nothing, and - the part that would be expensive to get wrong - removing one
 * does not remove the channels under it. The foreign key is ON DELETE SET NULL
 * for exactly that reason, so this asserts the rule at the level somebody can
 * read: tidying the rail is not a request to lose four rooms.
 *
 * The other half is that a channel cannot be filed under a heading from another
 * space, which would put it somewhere nobody in that space can see.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let role: "owner" | "member" = "owner";
let categorySpace: string | null = "space-1";
let deleted: string[] = [];
let created: { spaceId?: string; name?: string; categoryId?: string | null; kind?: string } = {};

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatSpace: {
            findUnique: async () => ({
                ownerId: role === "owner" ? "ada" : "grace",
                orgId: null,
                visibility: "private"
            }),
            findMany: async () => [{ id: "space-1" }]
        },
        chatSpaceMember: {
            findUnique: async () => (role === "member" ? { role: "member" } : null)
        },
        chatCategory: {
            findMany: async () => [{ id: "category-1", spaceId: "space-1", name: "Planning" }],
            findUnique: async () => (categorySpace ? { spaceId: categorySpace } : null),
            findFirst: async ({ where }: { where: { spaceId: string } }) =>
                categorySpace === where.spaceId ? { id: "category-1" } : null,
            create: async ({ data }: { data: { spaceId: string; name: string } }) => {
                created = data;
                return { id: "category-new" };
            },
            update: async () => ({}),
            delete: async ({ where }: { where: { id: string } }) => {
                deleted.push(where.id);
                return {};
            }
        },
        chatChannel: {
            findFirst: async () => null,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                created = data;
                return { id: "channel-new" };
            }
        }
    }
}));

const chat = await import("@/lib/chat/chat-service");
const { ChatAccessError } = await import("@/lib/chat/access");

const ada = { id: "ada" };

beforeEach(() => {
    role = "owner";
    categorySpace = "space-1";
    deleted = [];
    created = {};
});

describe("who arranges a space", () => {
    it("lets somebody who runs it add a heading", async () => {
        await chat.createCategory(ada, { spaceId: "space-1", name: "Planning" });
        expect(created.name).toBe("Planning");
    });

    it("refuses an ordinary member", async () => {
        role = "member";
        await expect(
            chat.createCategory(ada, { spaceId: "space-1", name: "Mine" })
        ).rejects.toBeInstanceOf(ChatAccessError);
    });
});

describe("removing a heading", () => {
    it("removes the heading and nothing else", async () => {
        // The channels under it are re-parented to nothing by the foreign key,
        // which is why this deletes one row and not five.
        await chat.deleteCategory(ada, "category-1");
        expect(deleted).toEqual(["category-1"]);
    });

    it("does nothing at all for one that is already gone", async () => {
        categorySpace = null;
        await chat.deleteCategory(ada, "category-1");
        expect(deleted).toEqual([]);
    });
});

describe("filing a channel", () => {
    it("puts it under a heading in its own space", async () => {
        await chat.createChannel(ada, {
            spaceId: "space-1",
            name: "release",
            topic: "",
            private: false,
            kind: "text",
            categoryId: "category-1"
        });
        expect(created.categoryId).toBe("category-1");
    });

    it("refuses a heading from another space", async () => {
        categorySpace = "space-2";
        await expect(
            chat.createChannel(ada, {
                spaceId: "space-1",
                name: "release",
                topic: "",
                private: false,
                kind: "text",
                categoryId: "category-1"
            })
        ).rejects.toThrow(/not in this space/);
    });

    it("makes a voice channel when asked for one", async () => {
        await chat.createChannel(ada, {
            spaceId: "space-1",
            name: "lounge",
            topic: "",
            private: false,
            kind: "voice",
            categoryId: null
        });
        expect(created.kind).toBe("voice");
    });
});
