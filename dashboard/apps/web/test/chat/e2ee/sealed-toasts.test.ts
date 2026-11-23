/**
 * A notice for a sealed message: its words are opened on this device, never
 * taken from the server; one behind the reader's chat lock stays as the server
 * redacted it, and one that does not open keeps the general line.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ configured: [] as string[], opened: new Map<string, string | null>(), asked: [] as string[], fail: false }));

vi.mock("@/lib/chat/e2ee/sealed-chat", () => ({
    configureSealedChat: (viewerId: string) => void state.configured.push(viewerId),
    openSealed: async (_channelId: string, ids: readonly string[]) => {
        state.asked.push(...ids);
        if (state.fail) throw new Error("unreachable");
        return new Map(ids.map((id) => [id, state.opened.has(id) ? { body: state.opened.get(id) } : null]));
    },
    sendSealedMessage: async () => "id"
}));

// The shell's server actions reach the session and the database; none of them is under test.
vi.mock("@/app/(app)/chat/actions", () => ({}));

const { withOpenedWords } = await import("@/components/message-toasts");
type MessageToast = import("@/lib/chat/toasts").MessageToast;

const toast = (messageId: string, extra: Partial<MessageToast> = {}) =>
    ({ channelId: "c1", messageId, conversation: "general", inChannel: true, direct: false, authorId: "a", authorName: "Ana", excerpt: "New message", media: null, ...extra }) as MessageToast;

beforeEach(() => {
    state.configured = [];
    state.asked = [];
    state.opened = new Map();
    state.fail = false;
});

describe("withOpenedWords", () => {
    it("leaves plain notices alone and turns nothing on", async () => {
        const plain = [toast("m1", { excerpt: "hello" })];
        expect(await withOpenedWords("v1", plain)).toBe(plain);
        expect(state.configured).toEqual([]);
    });

    it("opens a sealed notice's words on this device", async () => {
        state.opened.set("m1", "**see** you at noon");
        const [one] = await withOpenedWords("v1", [toast("m1", { sealed: true } as Partial<MessageToast>)]);
        expect(one?.excerpt).toBe("see you at noon");
        expect(state.configured).toEqual(["v1"]);
    });

    it("keeps the general line when it does not open, or opening fails", async () => {
        const [closed] = await withOpenedWords("v1", [toast("m1", { sealed: true } as Partial<MessageToast>)]);
        expect(closed?.excerpt).toBe("New message");
        state.fail = true;
        const [failed] = await withOpenedWords("v1", [toast("m2", { sealed: true } as Partial<MessageToast>)]);
        expect(failed?.excerpt).toBe("New message");
    });

    it("does not open one behind the reader's chat lock", async () => {
        state.opened.set("m1", "secret");
        const [locked] = await withOpenedWords("v1", [toast("m1", { sealed: true, locked: true } as Partial<MessageToast>)]);
        expect(locked?.excerpt).toBe("New message");
        expect(state.asked).toEqual([]);
    });

    it("opens nothing without a signed-in viewer", async () => {
        const sealed = [toast("m1", { sealed: true } as Partial<MessageToast>)];
        expect(await withOpenedWords("", sealed)).toBe(sealed);
        expect(state.asked).toEqual([]);
    });
});
