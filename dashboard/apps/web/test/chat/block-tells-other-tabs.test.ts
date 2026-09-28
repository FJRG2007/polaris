/**
 * Blocking somebody, as the reader's other screens learn of it.
 *
 * What is pinned: blocking or unblocking is announced to the reader's own
 * account, so a tab that did not do it stops offering Block for somebody already
 * blocked without waiting for a reload - and a refused block announces nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { publishChatChange, block, unblock } = vi.hoisted(() => ({
    publishChatChange: vi.fn(),
    block: vi.fn(async () => undefined),
    unblock: vi.fn(async () => undefined)
}));

class BlockError extends Error {}

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "reader" }) }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange }));
vi.mock("@/lib/blocks", () => ({ BlockError, block, unblock, listBlocked: async () => [] }));
vi.mock("@/lib/people-search", () => ({ findPeople: async () => [] }));
vi.mock("@/lib/presence-activity/live", () => ({ announceActivity: () => undefined }));
vi.mock("@/lib/presence-activity/settings", () => ({
    saveActivitySettings: async () => undefined
}));
vi.mock("@/lib/privacy-service", () => ({ PrivacyError: class extends Error {} }));
vi.mock("@/lib/friends-service", () => ({ FriendError: class extends Error {} }));

const { blockPersonAction, unblockPersonAction } = await import(
    "@/app/(app)/account/privacy/actions"
);

const OTHER = "0192f6a0-0000-7000-8000-0000000000cc";

beforeEach(() => {
    vi.clearAllMocks();
});

describe("a block, on the reader's other screens", () => {
    it("is announced to their own account when set and when lifted", async () => {
        expect(await blockPersonAction({ userId: OTHER })).toEqual({});
        expect(await unblockPersonAction({ userId: OTHER })).toEqual({});
        expect(publishChatChange).toHaveBeenCalledTimes(2);
        expect(publishChatChange).toHaveBeenCalledWith({
            kind: "channels",
            actorId: "reader",
            audience: ["reader"]
        });
    });

    it("announces nothing when the block is refused", async () => {
        block.mockRejectedValueOnce(new BlockError("That account is gone"));
        expect(await blockPersonAction({ userId: OTHER })).toEqual({
            error: "That account is gone"
        });
        expect(publishChatChange).not.toHaveBeenCalled();
    });
});
