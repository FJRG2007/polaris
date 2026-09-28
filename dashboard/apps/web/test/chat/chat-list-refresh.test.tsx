// @vitest-environment jsdom

/**
 * How the conversation list is asked for again.
 *
 * A browser runs server actions one at a time, so every request the rail makes
 * is a place in the queue a message being sent waits behind. What is pinned: a
 * full refresh is one request for the four lists rather than four; a part that
 * could not be read leaves what was on screen; and the conversations alone - what
 * a message arriving needs - are asked for once for a burst, a moment later.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let full = 0;
let channelsOnly = 0;
let lists: {
    channels: { id: string }[] | null;
    spaces: { id: string }[] | null;
    categories: { id: string }[] | null;
    blocked: string[] | null;
};

vi.mock("@/app/(app)/chat/actions", () => ({
    chatListsAction: async () => {
        full += 1;
        return lists;
    },
    listChannelsAction: async () => {
        channelsOnly += 1;
        return { channels: [{ id: "fresh" }] };
    },
    chatRulesAction: async () => ({ rules: null })
}));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({ callsUnavailableAction: async () => null }));

const { CHANNELS_SETTLE_MS, ChatProvider, useChat } = await import("@/app/(app)/chat/chat-context");

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
    lists = {
        channels: [{ id: "c1" }],
        spaces: [{ id: "s1" }],
        categories: [{ id: "k1" }],
        blocked: ["grace"]
    };
});

afterEach(cleanup);

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
});
