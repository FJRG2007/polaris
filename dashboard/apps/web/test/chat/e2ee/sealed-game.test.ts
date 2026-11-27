/**
 * The game bridge in a sealed conversation: it opens a message only while a
 * game shows the conversation and sealed chat is on, joins the group before it
 * reads, hands back only what parses as sealed content, and follows a link:
 * joined where a sealed conversation is now shown, forgotten where none is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    served: true,
    shown: true,
    sealed: true,
    rows: [] as { id: string; opened: Uint8Array | null }[],
    calls: [] as string[],
    failJoin: false
}));

vi.mock("@/lib/chat/e2ee/flag", () => ({ sealedChatServed: () => state.served }));
vi.mock("@/lib/chat/e2ee/sealed-conversation", () => ({ conversationSealed: async () => state.sealed }));
vi.mock("@/lib/chat/service-members", () => ({
    serviceReaches: async (kind: string, channelId: string) => {
        state.calls.push(`reaches:${kind}:${channelId}`);
        return state.shown;
    }
}));
vi.mock("@/lib/chat/e2ee/service-device", () => ({
    withServiceDevice: async <T,>(kind: string, owner: string, work: (device: unknown) => Promise<T>) => {
        state.calls.push(`device:${kind}:${owner}`);
        return work({
            ensureGroup: async (channelId: string) => {
                state.calls.push(`join:${channelId}`);
                if (state.failJoin) throw new Error("no group");
            },
            readSealed: async (channelId: string, ids: string[]) => {
                state.calls.push(`read:${channelId}:${ids.join(",")}`);
                return state.rows;
            }
        });
    },
    forgetServiceDevice: async (kind: string, owner: string) => {
        state.calls.push(`forget:${kind}:${owner}`);
    }
}));

const { encodeSealedContent } = await import("@/lib/chat/e2ee/sealed-chat");
const { openForGame, syncGameBridge } = await import("@/lib/chat/e2ee/sealed-game");

const CHANNEL = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
    state.served = true;
    state.shown = true;
    state.sealed = true;
    state.rows = [];
    state.calls = [];
    state.failJoin = false;
});

describe("opening a message for a game", () => {
    it("joins the group, then opens the message as the bridge's own device", async () => {
        state.rows = [{ id: "m1", opened: encodeSealedContent({ body: "raid at eight" }) }];
        expect(await openForGame(CHANNEL, "m1")).toMatchObject({ body: "raid at eight" });
        expect(state.calls).toEqual([`reaches:game:${CHANNEL}`, `device:game:${CHANNEL}`, `join:${CHANNEL}`, `read:${CHANNEL}:m1`]);
    });

    it("answers null for a message it cannot open or that is not sealed content", async () => {
        state.rows = [{ id: "m1", opened: null }];
        expect(await openForGame(CHANNEL, "m1")).toBeNull();
        state.rows = [{ id: "m1", opened: new TextEncoder().encode("{\"v\":9}") }];
        expect(await openForGame(CHANNEL, "m1")).toBeNull();
        state.rows = [{ id: "other", opened: encodeSealedContent({ body: "not this one" }) }];
        expect(await openForGame(CHANNEL, "m1")).toBeNull();
    });

    it("never opens a device where no game shows the conversation, or with sealed chat off", async () => {
        state.shown = false;
        expect(await openForGame(CHANNEL, "m1")).toBeNull();
        state.shown = true;
        state.served = false;
        expect(await openForGame(CHANNEL, "m1")).toBeNull();
        expect(state.calls.some((call) => call.startsWith("device:"))).toBe(false);
    });
});

describe("following a conversation's link", () => {
    it("joins a sealed conversation a game now shows", async () => {
        await syncGameBridge(CHANNEL);
        expect(state.calls).toEqual([`reaches:game:${CHANNEL}`, `device:game:${CHANNEL}`, `join:${CHANNEL}`]);
    });

    it("leaves a plain conversation alone: there is no group to join", async () => {
        state.sealed = false;
        await syncGameBridge(CHANNEL);
        expect(state.calls).toEqual([`reaches:game:${CHANNEL}`]);
    });

    it("forgets the device of a conversation no game shows any more", async () => {
        state.shown = false;
        await syncGameBridge(CHANNEL);
        expect(state.calls).toEqual([`reaches:game:${CHANNEL}`, `forget:game:${CHANNEL}`]);
    });

    it("never throws, and does nothing with sealed chat off", async () => {
        state.failJoin = true;
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(syncGameBridge(CHANNEL)).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
        state.calls = [];
        state.served = false;
        await syncGameBridge(CHANNEL);
        expect(state.calls).toEqual([]);
    });
});
