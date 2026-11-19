/**
 * The phone app's notifications: one frame per new message, decided by the
 * same read the corner toast uses, and a ring only for whoever the ring names.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Change = Record<string, unknown>;
let listener: ((change: Change) => void) | null = null;
const toastCalls: string[][] = [];

vi.mock("@/lib/session", () => ({
    backgroundUser: async () => ({ id: "me", isAdmin: false }),
    sessionCan: async () => true
}));
vi.mock("@/lib/i18n/reader-words", () => ({
    readerWords: async (namespace: string) => (key: string, values?: Record<string, string>) =>
        `${namespace}.${key}${values ? `(${Object.values(values).join(",")})` : ""}`
}));
vi.mock("@/lib/chat/stream-scope", () => ({
    holdStreamScope: () => ({
        reachable: () => new Set(["c1"]),
        resolvedAt: () => Date.now(),
        invalidate: () => {},
        refresh: async () => {},
        release: () => {}
    })
}));
vi.mock("@/lib/chat/live", () => ({
    subscribeChatChanges: (next: (change: Change) => void) => {
        listener = next;
        return () => (listener = null);
    }
}));
vi.mock("@/lib/chat/toasts", () => ({
    messageToasts: async (_actor: unknown, channels: string[]) => {
        toastCalls.push(channels);
        return [
            {
                channelId: "c1",
                messageId: "m1",
                conversation: "general",
                inChannel: true,
                direct: false,
                authorId: "u2",
                authorName: "Ana",
                excerpt: "Lunch?",
                media: null,
                at: new Date().toISOString()
            }
        ];
    }
}));

const { GET } = await import("@/app/api/mobile/notices/route");

async function open() {
    const response = await GET();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // One read in flight at a time: a read that loses the race still resolves
    // later, with the bytes, and has to be the one that is awaited next.
    let pending: ReturnType<typeof reader.read> | null = null;
    const frames = async (wait = 600) => {
        const until = Date.now() + wait;
        while (Date.now() < until) {
            pending ??= reader.read();
            const next = await Promise.race([
                pending,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 50))
            ]);
            if (next) {
                pending = null;
                if (!next.done) text += decoder.decode(next.value);
            }
        }
        return text
            .split("\n\n")
            .filter((frame) => frame.startsWith("data: "))
            .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
    };
    return { response, frames, close: () => reader.cancel() };
}

beforeEach(() => {
    toastCalls.length = 0;
});
afterEach(() => {
    listener = null;
});

describe("the phone's notices", () => {
    it("streams a new message as the toast describes it", async () => {
        const stream = await open();
        expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
        listener!({ channelId: "c1", kind: "posted", actorId: "u2" });
        listener!({ channelId: "c1", kind: "posted", actorId: "u2" });
        const frames = await stream.frames();
        expect(toastCalls).toEqual([["c1"]]);
        expect(frames).toEqual([
            {
                kind: "message",
                channelId: "c1",
                tag: "chat:c1",
                title: "components.messageToasts.inChannel(Ana,general)",
                body: "Lunch?",
                path: "/chat/c/c1"
            }
        ]);
        await stream.close();
    });

    it("says nothing for an edit, its own message, or a conversation it is not in", async () => {
        const stream = await open();
        listener!({ channelId: "c1", kind: "posted", actorId: "u2", messageIds: ["m1"] });
        listener!({ channelId: "c1", kind: "posted", actorId: "me" });
        listener!({ channelId: "c9", kind: "posted", actorId: "u2" });
        expect(await stream.frames()).toEqual([]);
        expect(toastCalls).toEqual([]);
        await stream.close();
    });

    it("rings only for the people the ring names, and stops the ring when it ends", async () => {
        const stream = await open();
        const call = (state: string, audience?: string[]) =>
            listener!({ channelId: "c1", kind: "call", actorId: "u2", actorName: "Ana", audience, call: { meetingId: "x", state, count: 1 } });
        call("ringing", ["someone-else"]);
        call("ringing", ["me"]);
        call("ended");
        const frames = await stream.frames(200);
        expect(frames.map((frame) => [frame.kind, frame.title])).toEqual([
            ["call", "components.calls.calling(Ana)"],
            ["call-ended", ""]
        ]);
        await stream.close();
    });
});
