/**
 * A space that asks before it lets people in.
 *
 * A request is one per person per space and tells whoever runs the space once;
 * only they see the queue or answer it; answering claims the request so two
 * answers cannot both act, and a ban made while somebody waited still holds.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let requests: Array<{ id: string; spaceId: string; userId: string }> = [];
let members: Array<{ spaceId: string; userId: string; role: string }> = [];
let banned = false;
let admin = true;
const told: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        chatSpaceJoinRequest: {
            findUnique: vi.fn(async ({ where }: any) =>
                where.id
                    ? (requests.find((row) => row.id === where.id) ?? null)
                    : (requests.find(
                          (row) =>
                              row.spaceId === where.spaceId_userId.spaceId &&
                              row.userId === where.spaceId_userId.userId
                      ) ?? null)
            ),
            create: vi.fn(async ({ data }: any) => {
                const row = { id: `r${requests.length + 1}`, ...data };
                requests.push(row);
                return row;
            }),
            deleteMany: vi.fn(async ({ where }: any) => {
                const before = requests.length;
                requests = requests.filter((row) => row.id !== where.id);
                return { count: before - requests.length };
            })
        },
        chatSpace: {
            findUnique: vi.fn(async () => ({ name: "Lab", ownerId: "owner" }))
        },
        chatSpaceMember: {
            findMany: vi.fn(async () => [{ userId: "mod" }]),
            findUnique: vi.fn(async ({ where }: any) =>
                members.find((row) => row.userId === where.spaceId_userId.userId) ?? null
            ),
            create: vi.fn(async ({ data }: any) => {
                members.push(data);
                return data;
            })
        },
        user: { findUnique: vi.fn(async () => ({ name: "Grace" })) },
        chatSpaceBan: { findUnique: vi.fn(async () => (banned ? { id: "ban" } : null)) }
    }
}));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: vi.fn(async ({ userId }: { userId: string }) => {
        told.push(userId);
    })
}));
vi.mock("@/lib/chat/text", () => ({
    chatWordsFor: async () => (key: string) => key
}));
vi.mock("@/lib/chat/notices", () => ({ postSpaceNotice: vi.fn(async () => undefined) }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: vi.fn() }));
vi.mock("@/lib/chat/access", () => {
    class ChatAccessError extends Error {
        constructor(readonly text: { key: string }) {
            super(text.key);
        }
    }
    return {
        ChatAccessError,
        requireSpace: vi.fn(async () => {
            if (!admin) throw new ChatAccessError({ key: "errors.spaceAdminOnly" });
            return "admin";
        })
    };
});

const joins = await import("@/lib/chat/join-requests");

beforeEach(() => {
    requests = [];
    members = [];
    banned = false;
    admin = true;
    told.length = 0;
});

describe("asking to join", () => {
    it("files one request and tells the owner and the administrators once", async () => {
        await joins.requestToJoin({ id: "grace" }, "s1");
        await joins.requestToJoin({ id: "grace" }, "s1");
        expect(requests).toHaveLength(1);
        expect(told.sort()).toEqual(["mod", "owner"]);
        expect(await joins.isWaiting({ id: "grace" }, "s1")).toBe(true);
    });

    it("lets in somebody accepted, once", async () => {
        await joins.requestToJoin({ id: "grace" }, "s1");
        await joins.answerJoinRequest({ id: "owner" }, "r1", true);
        expect(members).toEqual([{ spaceId: "s1", userId: "grace", role: "member" }]);
        await expect(joins.answerJoinRequest({ id: "mod" }, "r1", true)).rejects.toMatchObject({
            text: { key: "errors.joinRequestGone" }
        });
        expect(members).toHaveLength(1);
    });

    it("lets nobody in on a decline", async () => {
        await joins.requestToJoin({ id: "grace" }, "s1");
        await joins.answerJoinRequest({ id: "owner" }, "r1", false);
        expect(members).toHaveLength(0);
        expect(requests).toHaveLength(0);
    });

    it("keeps out somebody banned while they waited", async () => {
        await joins.requestToJoin({ id: "grace" }, "s1");
        banned = true;
        await expect(joins.answerJoinRequest({ id: "owner" }, "r1", true)).rejects.toMatchObject({
            text: { key: "errors.spaceJoinNotAllowed" }
        });
        expect(members).toHaveLength(0);
    });

    it("leaves the queue to whoever runs the space", async () => {
        await joins.requestToJoin({ id: "grace" }, "s1");
        admin = false;
        await expect(joins.answerJoinRequest({ id: "eve" }, "r1", true)).rejects.toBeTruthy();
        await expect(joins.joinRequestsFor({ id: "eve" }, "s1")).rejects.toBeTruthy();
        await expect(joins.setRequireApproval({ id: "eve" }, "s1", false)).rejects.toBeTruthy();
        expect(requests).toHaveLength(1);
        expect(members).toHaveLength(0);
    });
});
