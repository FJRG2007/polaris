// @vitest-environment jsdom

/**
 * Several messages in one conversation become one note that grows.
 *
 * What is pinned: each new message replaces the conversation's note with one that
 * counts it and keeps the latest lines; who said each line is named only where
 * more than one person is talking; a direct message says so as its "where"; and
 * once the note goes - or the conversation is read - the next one starts again.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CHANNEL = "11111111-1111-4111-8111-111111111111";

let onFrame: ((frame: unknown, context: { owner: boolean }) => void) | null = null;
let next: { id: string; author: string; text: string } = { id: "m-1", author: "Ada", text: "Hi" };
let direct = false;
let inChannel = true;

interface Shown {
    key?: string;
    onGone?: () => void;
    conversation?: {
        sender: string;
        where?: string;
        lines: Array<{ id: string; author?: string; text: string }>;
        count?: number;
        countLabel?: string;
    };
}
const shown: Shown[] = [];

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => "/deploy"
}));
vi.mock("@/components/session-scope", () => ({ useSessionScope: () => "scope" }));
vi.mock("@/components/avatar", () => ({ Avatar: () => null }));
vi.mock("@/components/toast-picture", () => ({ ToastPicture: () => null }));
vi.mock("@polaris/ui", () => ({
    useToast: () => ({
        show: (toast: Shown) => shown.push(toast),
        dismiss: () => undefined
    })
}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: unknown, context: { owner: boolean }) => void) => {
        onFrame = handler;
    }
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    setMutedAction: async () => ({}),
    replyFromNoticeAction: async () => ({ id: "r-1" }),
    messageToastsAction: async (ids: string[]) => ({
        toasts: ids.map((channelId) => ({
            channelId,
            messageId: next.id,
            conversation: "general",
            inChannel,
            direct,
            authorId: next.author.toLowerCase(),
            authorName: next.author,
            excerpt: next.text,
            media: null
        }))
    })
}));
vi.mock("@/lib/device-once", () => ({ claimForDevice: async () => false }));
vi.mock("@/lib/call-sounds", () => ({ playCallSound: () => undefined }));
vi.mock("@/lib/notification-sound", () => ({ notificationSoundEnabled: () => false }));
vi.mock("@/lib/desktop-notify", () => ({
    tabIsWatched: () => true,
    answerUnclaimedReplies: () => () => undefined,
    actOnUnclaimedNotices: () => () => undefined,
    closeDesktopNotice: () => undefined,
    notifyDesktop: async () => null,
    runNoticeAction: async () => true
}));

const { MessageToasts } = await import("@/components/message-toasts");

async function say(id: string, author: string, text: string): Promise<Shown> {
    next = { id, author, text };
    vi.useFakeTimers();
    act(() => onFrame?.({ kind: "posted", seq: 1, channels: [CHANNEL] }, { owner: true }));
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return shown.at(-1)!;
}

beforeEach(() => {
    shown.length = 0;
    direct = false;
    inChannel = true;
    window.localStorage?.clear?.();
    render(<MessageToasts />);
});

afterEach(() => {
    cleanup();
});

describe("a conversation's note", () => {
    it("counts each message and keeps the latest lines", async () => {
        const first = await say("m-1", "Ada", "one");
        expect(first.key).toBe(`message:${CHANNEL}`);
        expect(first.conversation).toMatchObject({
            sender: "Ada",
            where: "#general",
            count: 1,
            lines: [{ id: "m-1", text: "one", author: undefined }]
        });

        await say("m-2", "Ada", "two");
        await say("m-3", "Ada", "three");
        const fourth = await say("m-4", "Ada", "four");
        expect(fourth.key).toBe(first.key);
        expect(fourth.conversation?.count).toBe(4);
        expect(fourth.conversation?.countLabel).toBe("components.messageToasts.count");
        expect(fourth.conversation?.lines.map((line) => line.text)).toEqual([
            "two",
            "three",
            "four"
        ]);
    });

    it("names who said each line once more than one person is talking", async () => {
        await say("m-1", "Ada", "one");
        const second = await say("m-2", "Bruno", "two");
        expect(second.conversation?.sender).toBe("Bruno");
        expect(second.conversation?.lines.map((line) => line.author)).toEqual(["Ada", "Bruno"]);
    });

    it("says a direct message is one", async () => {
        direct = true;
        inChannel = false;
        const note = await say("m-1", "Ada", "one");
        expect(note.conversation?.where).toBe("components.messageToasts.direct");
    });

    it("starts again once the note has gone", async () => {
        await say("m-1", "Ada", "one");
        const second = await say("m-2", "Ada", "two");
        expect(second.conversation?.count).toBe(2);
        second.onGone?.();
        const third = await say("m-3", "Ada", "three");
        expect(third.conversation?.count).toBe(1);
        expect(third.conversation?.lines.map((line) => line.text)).toEqual(["three"]);
    });

    it("starts again once the conversation is read", async () => {
        await say("m-1", "Ada", "one");
        act(() =>
            onFrame?.({ kind: "read", channelId: CHANNEL, userId: "scope" }, { owner: true })
        );
        const after = await say("m-2", "Ada", "two");
        expect(after.conversation?.count).toBe(1);
    });
});
