/**
 * Advanced chat privacy: who may switch it, and that each switch is said in
 * the conversation. The refusals it drives (Polar, downloads, forwards) all
 * ask `isShielded`, which reads the stored column and treats unknown as off.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let access: Record<string, unknown> | null = null;
let stored = false;
const notices: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: {
            findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
                stored ? where.id.in.map((id) => ({ id })) : []
            ),
            updateMany: vi.fn(async ({ where, data }: { where: { advancedPrivacy: boolean }; data: { advancedPrivacy: boolean } }) => {
                if (stored !== where.advancedPrivacy) return { count: 0 };
                stored = data.advancedPrivacy;
                return { count: 1 };
            })
        },
        user: { findUnique: vi.fn(async () => ({ name: "Grace" })) }
    }
}));
vi.mock("@/lib/chat/access", async () => {
    class ChatAccessError extends Error {
        constructor(readonly text: { key: string }) {
            super(text.key);
        }
    }
    return {
        ChatAccessError,
        requireChannel: vi.fn(async () => {
            if (!access) throw new ChatAccessError({ key: "errors.notFound" });
            return access;
        })
    };
});
vi.mock("@/lib/chat/notices", () => ({
    postNoticeBody: vi.fn(async (_channelId: string, body: string) => {
        notices.push(body);
    })
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: vi.fn() }));

const { isShielded, setAdvancedPrivacy } = await import("@/lib/chat/advanced-privacy");

beforeEach(() => {
    stored = false;
    notices.length = 0;
    access = { spaceId: null, member: true, mayAdminister: false, archived: false };
});

describe("advanced chat privacy", () => {
    it("is off for a conversation nobody switched", async () => {
        expect(await isShielded("c1")).toBe(false);
    });

    it("lets any member of a direct message or group turn it on, and says so", async () => {
        await setAdvancedPrivacy({ id: "grace" }, "c1", true);
        expect(await isShielded("c1")).toBe(true);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("turned on advanced chat privacy");
    });

    it("writes nothing when it is already that way", async () => {
        await setAdvancedPrivacy({ id: "grace" }, "c1", false);
        expect(notices).toHaveLength(0);
    });

    it("leaves a space channel to whoever runs it", async () => {
        access = { spaceId: "s1", member: true, mayAdminister: false, archived: false };
        await expect(setAdvancedPrivacy({ id: "grace" }, "c1", true)).rejects.toMatchObject({
            text: { key: "errors.channelChangeNotAllowed" }
        });
        expect(stored).toBe(false);
        access = { spaceId: "s1", member: false, mayAdminister: true, archived: false };
        await setAdvancedPrivacy({ id: "ada" }, "c1", true);
        expect(stored).toBe(true);
    });

    it("refuses somebody who cannot reach the conversation", async () => {
        access = null;
        await expect(setAdvancedPrivacy({ id: "eve" }, "c1", true)).rejects.toBeTruthy();
        expect(stored).toBe(false);
    });
});
