// @vitest-environment jsdom

/**
 * How the conversation list is asked for again.
 *
 * What is pinned: a full refresh is one request for the lists; a part that could
 * not be read leaves what was on screen; a read that fails is tried again rather
 * than leaving a skeleton or an empty rail; a session refused stops asking; a burst
 * of refreshes never cancels the read that is running; the conversations alone -
 * what a message arriving needs - are asked for once for a burst, a moment later;
 * and the copy this tab keeps draws the rail without passing for an answer.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let full = 0;
let channelsOnly = 0;
let failing = false;
let lists: {
    channels: { id: string }[] | null;
    spaces: { id: string }[] | null;
    categories: { id: string }[] | null;
    blocked: string[] | null;
};

const routerRefresh = vi.fn();
const router = { refresh: routerRefresh };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/(app)/chat/actions", () => ({
    listChannelsAction: async () => {
        channelsOnly += 1;
        return { channels: [{ id: "fresh" }] };
    },
    chatRulesAction: async () => ({ rules: null })
}));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({ callsUnavailableAction: async () => null }));

const { CHANNELS_SETTLE_MS, ChatProvider, useChat } = await import("@/app/(app)/chat/chat-context");
const { dropAllSnapshots, readSnapshot, writeSnapshot } = await import("@/lib/snapshot-cache");

type Chat = ReturnType<typeof useChat>;
let chat: Chat | null = null;

function Probe() {
    chat = useChat();
    return null;
}

const may = { spaces: true, groups: true, attach: true, call: false, meetings: false };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(): Promise<void> {
    render(
        <ChatProvider viewerId="ada" viewerName="Ada" orgId={null} orgName={null} may={may}>
            <Probe />
        </ChatProvider>
    );
    await act(() => wait(10));
}

beforeEach(() => {
    full = 0;
    channelsOnly = 0;
    chat = null;
    failing = false;
    routerRefresh.mockClear();
    sessionStorage.clear();
    vi.stubGlobal("fetch", async (_url: string) => {
        full += 1;
        if (failing) return new Response("{}", { status: 503 });
        return new Response(JSON.stringify(lists));
    });
    lists = {
        channels: [{ id: "c1" }],
        spaces: [{ id: "s1" }],
        categories: [{ id: "k1" }],
        blocked: ["grace"]
    };
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the conversation list, asked for again", () => {
    it("is one request for everything the context holds", async () => {
        await mount();
        expect(full).toBe(1);
        expect(chat?.loaded).toBe(true);
        expect(chat?.channels.map((entry) => entry.id)).toEqual(["c1"]);
        expect(chat?.spaces.map((entry) => entry.id)).toEqual(["s1"]);
        expect(chat?.categories.map((entry) => entry.id)).toEqual(["k1"]);
        expect(chat?.blocked.has("grace")).toBe(true);
    });

    it("keeps what it had for a part that could not be read", async () => {
        await mount();
        lists = { channels: [{ id: "c2" }], spaces: null, categories: null, blocked: null };
        await act(async () => {
            chat?.refresh();
            await wait(10);
        });
        expect(chat?.channels.map((entry) => entry.id)).toEqual(["c2"]);
        expect(chat?.spaces.map((entry) => entry.id)).toEqual(["s1"]);
        expect(chat?.categories.map((entry) => entry.id)).toEqual(["k1"]);
        expect(chat?.blocked.has("grace")).toBe(true);
    });

    it("says so and tries again when the first read fails, instead of an empty rail", async () => {
        failing = true;
        await mount();
        expect(chat?.loaded).toBe(false);
        expect(chat?.loadFailed).toBe(true);
        failing = false;
        await act(() => wait(2050));
        expect(full).toBe(2);
        expect(chat?.loaded).toBe(true);
        expect(chat?.loadFailed).toBe(false);
        expect(chat?.channels.map((entry) => entry.id)).toEqual(["c1"]);
    });

    it("gives up on a read that never answers and tries again", async () => {
        const never = new AbortController();
        const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(never.signal);
        vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
            full += 1;
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        });
        await mount();
        expect(full).toBe(1);
        expect(chat?.loaded).toBe(false);
        expect(chat?.loadFailed).toBe(false);
        await act(async () => {
            never.abort();
            await wait(10);
        });
        expect(chat?.loaded).toBe(false);
        expect(chat?.loadFailed).toBe(true);
        timeout.mockRestore();
    });

    it("asks for the conversations alone once for a burst, a moment later", async () => {
        await mount();
        await act(async () => {
            chat?.refreshChannels();
            chat?.refreshChannels();
            chat?.refreshChannels();
            await wait(10);
        });
        // Nothing yet: the burst is still being gathered.
        expect(channelsOnly).toBe(0);
        await act(() => wait(CHANNELS_SETTLE_MS + 20));
        expect(channelsOnly).toBe(1);
        // And only the conversations: the spaces, headings and blocks were not
        // asked for again.
        expect(full).toBe(1);
        expect(chat?.channels.map((entry) => entry.id)).toEqual(["fresh"]);
    });

    it.each([401, 403])("stops asking and lets the server decide on a %i", async (status) => {
        vi.stubGlobal("fetch", async () => {
            full += 1;
            return new Response("{}", { status });
        });
        await mount();
        expect(full).toBe(1);
        expect(routerRefresh).toHaveBeenCalledOnce();
        expect(chat?.loaded).toBe(false);
        expect(chat?.loadFailed).toBe(true);
        await act(() => wait(2050));
        expect(full).toBe(1);
    });

    it("lets a running read land and asks once more for a burst of changes", async () => {
        const answers: ((response: Response) => void)[] = [];
        vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
            full += 1;
            return new Promise<Response>((resolve, reject) => {
                answers.push(resolve);
                init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        });
        await mount();
        await act(async () => {
            chat?.refresh();
            chat?.refresh();
            chat?.refresh();
            await wait(10);
        });
        expect(full).toBe(1);
        await act(async () => {
            answers[0]?.(new Response(JSON.stringify(lists)));
            await wait(10);
        });
        expect(chat?.loaded).toBe(true);
        expect(full).toBe(2);
        await act(async () => {
            answers[1]?.(new Response(JSON.stringify(lists)));
            await wait(10);
        });
        expect(full).toBe(2);
        await act(async () => {
            chat?.refresh();
            await wait(10);
        });
        expect(full).toBe(3);
    });

    it("tries at once when asked during the wait after a failure", async () => {
        failing = true;
        await mount();
        failing = false;
        await act(async () => {
            chat?.refresh();
            await wait(10);
        });
        expect(full).toBe(2);
        expect(chat?.loaded).toBe(true);
    });
});

describe("the list this tab kept", () => {
    const key = "chat.lists.ada";
    const kept = { channels: [{ id: "old" }], spaces: [{ id: "s0" }], categories: [] };
    const maxAge = 3_600_000;

    it("draws at once, without passing for the server's answer", async () => {
        writeSnapshot(key, kept);
        vi.stubGlobal("fetch", () => new Promise(() => undefined));
        await mount();
        expect(chat?.kept).toBe(true);
        expect(chat?.loaded).toBe(false);
        expect(chat?.channels.map((entry) => entry.id)).toEqual(["old"]);
    });

    it("is another account's to not see", async () => {
        writeSnapshot("chat.lists.grace", kept);
        vi.stubGlobal("fetch", () => new Promise(() => undefined));
        await mount();
        expect(chat?.kept).toBe(false);
        expect(chat?.channels).toEqual([]);
    });

    it("is replaced by the answer and goes with a sign-out", async () => {
        await mount();
        expect(
            readSnapshot<typeof kept>(key, maxAge)?.value.channels.map((entry) => entry.id)
        ).toEqual(["c1"]);
        dropAllSnapshots();
        expect(readSnapshot(key, maxAge)).toBeNull();
    });

    it("follows the conversations when only they are asked for", async () => {
        await mount();
        await act(async () => {
            chat?.refreshChannels();
            await wait(CHANNELS_SETTLE_MS + 20);
        });
        const value = readSnapshot<typeof kept>(key, maxAge)?.value;
        expect(value?.channels.map((entry) => entry.id)).toEqual(["fresh"]);
        expect(value?.spaces.map((entry) => entry.id)).toEqual(["s1"]);
    });
});
