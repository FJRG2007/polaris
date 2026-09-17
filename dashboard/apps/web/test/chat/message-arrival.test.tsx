// @vitest-environment jsdom

/**
 * A message arriving while nobody is reading it.
 *
 * The conversation open in a tab used to be skipped outright: the address
 * matched, so no card, no chime and no notice - even when the tab was in the
 * background, the window minimised, or another program on top. Asserted here
 * from the decision itself and from the component that acts on it: a sound plays
 * whenever the reader is not actively in that conversation, and only the
 * attended conversation stays quiet.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    arrivalAlert,
    markSeenOnDevice,
    SEEN_WINDOW_MS,
    seenOnDevice,
    showsConversation
} from "@/lib/chat/message-alert";

const CHANNEL = "11111111-1111-4111-8111-111111111111";

// This runtime's jsdom leaves `localStorage` undefined, so the tabs share this.
const store = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear()
    }
});

let onFrame: ((frame: unknown, context: { owner: boolean }) => void) | null = null;
let pathname = "/deploy";
let watched = true;
let soundOn = true;
/** Held open by a test that needs the round trip to still be in flight; it
 *  always answers false, so the words come back either way. */
let inFlight: Promise<void> | null = null;
async function hold(): Promise<boolean> {
    if (inFlight) await inFlight;
    return false;
}
const shown: Array<{ key?: string }> = [];
const dismissed: string[] = [];
const closed: string[] = [];
const played: string[] = [];
const notices: Array<{ tag: string }> = [];

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => pathname
}));
vi.mock("@/components/session-scope", () => ({ useSessionScope: () => "scope" }));
vi.mock("@/components/avatar", () => ({ Avatar: () => null }));
vi.mock("@/components/toast-picture", () => ({ ToastPicture: () => null }));
vi.mock("@polaris/ui", () => ({
    useToast: () => ({
        show: (toast: { key?: string }) => shown.push(toast),
        dismiss: (key: string) => dismissed.push(key)
    })
}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: unknown, context: { owner: boolean }) => void) => {
        onFrame = handler;
    }
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    messageToastsAction: async (ids: string[]) => ({
        toasts: (await hold())
            ? []
            : ids.map((channelId) => ({
                  channelId,
                  messageId: "m-1",
                  conversation: "general",
                  inChannel: false,
                  authorId: "ada",
                  authorName: "Ada",
                  excerpt: "Hello",
                  media: null
              }))
    })
}));
vi.mock("@/lib/device-once", () => ({ claimForDevice: async () => true }));
vi.mock("@/lib/call-sounds", () => ({ playCallSound: (name: string) => played.push(name) }));
vi.mock("@/lib/notification-sound", () => ({ notificationSoundEnabled: () => soundOn }));
vi.mock("@/lib/desktop-notify", () => ({
    tabIsWatched: () => watched,
    closeDesktopNotice: (tag: string) => closed.push(tag),
    notifyDesktop: async (input: { tag: string }) => {
        notices.push(input);
        return null;
    }
}));

const { MessageToasts } = await import("@/components/message-toasts");

/** A message lands in `CHANNEL`, and everything it sets off has run. */
async function arrive(owner = true): Promise<void> {
    render(<MessageToasts />);
    vi.useFakeTimers();
    act(() => onFrame?.({ kind: "posted", seq: 1, channels: [CHANNEL] }, { owner }));
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
    pathname = "/deploy";
    watched = true;
    soundOn = true;
    shown.length = 0;
    played.length = 0;
    notices.length = 0;
    dismissed.length = 0;
    closed.length = 0;
    inFlight = null;
    window.localStorage.clear();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("arrivalAlert", () => {
    it("stays quiet only for the conversation somebody is reading", () => {
        expect(arrivalAlert({ inThatChat: true, attended: true, soundOn: true })).toEqual({
            toast: false,
            sound: false,
            desktop: false
        });
    });

    it("sounds and raises a notice for the open conversation nobody is looking at", () => {
        expect(arrivalAlert({ inThatChat: true, attended: false, soundOn: true })).toEqual({
            toast: false,
            sound: true,
            desktop: true
        });
    });

    it("shows a card and sounds for another conversation on an attended tab", () => {
        expect(arrivalAlert({ inThatChat: false, attended: true, soundOn: true })).toEqual({
            toast: true,
            sound: true,
            desktop: false
        });
    });

    it("never sounds with sound switched off", () => {
        for (const inThatChat of [true, false]) {
            for (const attended of [true, false]) {
                expect(arrivalAlert({ inThatChat, attended, soundOn: false }).sound).toBe(false);
            }
        }
    });
});

describe("showsConversation", () => {
    it("matches the conversation and a message in it, and nothing else", () => {
        expect(showsConversation(`/chat/c/${CHANNEL}`, CHANNEL)).toBe(true);
        expect(showsConversation(`/chat/c/${CHANNEL}/m-1`, CHANNEL)).toBe(true);
        expect(showsConversation(`/chat/c/${CHANNEL}x`, CHANNEL)).toBe(false);
        expect(showsConversation("/chat", CHANNEL)).toBe(false);
    });
});

describe("a conversation read in another tab", () => {
    it("counts only for the same arrival, and never for the tab that said so", () => {
        markSeenOnDevice(CHANNEL, 10_000, "other-tab");
        expect(seenOnDevice(CHANNEL, 10_400, "this-tab")).toBe(true);
        // A later message is a new arrival, even though it was being read before.
        expect(seenOnDevice(CHANNEL, 10_000 + SEEN_WINDOW_MS + 1, "this-tab")).toBe(false);
        expect(seenOnDevice(CHANNEL, 10_400, "other-tab")).toBe(false);
    });
});

describe("a message arriving", () => {
    it("plays the sound when the reader is somewhere else in Polaris", async () => {
        await arrive();
        expect(played).toEqual(["message"]);
        expect(shown.map((toast) => toast.key)).toEqual([`message:${CHANNEL}`]);
        expect(notices).toEqual([]);
    });

    it("plays the sound and raises a notice for the open conversation in a tab nobody is looking at", async () => {
        pathname = `/chat/c/${CHANNEL}`;
        watched = false;
        await arrive();
        expect(played).toEqual(["message"]);
        expect(notices.map((notice) => notice.tag)).toEqual([`message:${CHANNEL}`]);
        // The line is already in that tab; a card on top of it would be a repeat.
        expect(shown).toEqual([]);
    });

    it("raises a notice from another page when the window is behind something else", async () => {
        watched = false;
        await arrive();
        expect(played).toEqual(["message"]);
        expect(shown).toHaveLength(1);
        expect(notices).toHaveLength(1);
    });

    it("says nothing about the conversation somebody is reading", async () => {
        pathname = `/chat/c/${CHANNEL}`;
        await arrive();
        expect(played).toEqual([]);
        expect(shown).toEqual([]);
        expect(notices).toEqual([]);
    });

    it("is silent when sound is switched off, and still shown", async () => {
        soundOn = false;
        await arrive();
        expect(played).toEqual([]);
        expect(shown).toHaveLength(1);
    });

    it("stays quiet in the tab holding the connection while another tab shows it", async () => {
        markSeenOnDevice(CHANNEL, Date.now(), "reading-tab");
        watched = false;
        await arrive();
        expect(played).toEqual([]);
        expect(notices).toEqual([]);
    });
});

describe("catching up in another window", () => {
    it("withdraws the notice and the card raised by the tab that announced it", async () => {
        watched = false;
        await arrive();
        expect(notices).toHaveLength(1);

        // The reader opened the conversation somewhere else; the read reaches
        // every tab of this account on the live channel.
        act(() =>
            onFrame?.({ kind: "read", channelId: CHANNEL, userId: "scope" }, { owner: true })
        );
        expect(closed).toEqual([`message:${CHANNEL}`]);
        expect(dismissed).toEqual([`message:${CHANNEL}`]);
    });

    it("says nothing about a conversation read while the words were being fetched", async () => {
        // The queue is emptied before the round trip, so the read frame has
        // nothing left to take out of it - and what comes back would be
        // announced for a conversation the reader has just opened elsewhere.
        let release: (() => void) | null = null;
        inFlight = new Promise<void>((resolve) => {
            release = resolve;
        });
        watched = false;
        render(<MessageToasts />);
        act(() => onFrame?.({ kind: "posted", seq: 1, channels: [CHANNEL] }, { owner: true }));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
        });
        act(() =>
            onFrame?.({ kind: "read", channelId: CHANNEL, userId: "scope" }, { owner: true })
        );
        release?.();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
        inFlight = null;

        expect(shown).toEqual([]);
        expect(played).toEqual([]);
        expect(notices).toEqual([]);
    });

    it("leaves them alone when the reader put the conversation back to unread", async () => {
        // The same frame carries both, because it is the same mark moving. A
        // conversation deliberately left unread must keep what announced it.
        watched = false;
        await arrive();
        act(() =>
            onFrame?.(
                { kind: "read", channelId: CHANNEL, userId: "scope", unread: true },
                { owner: true }
            )
        );
        expect(closed).toEqual([]);
        expect(dismissed).toEqual([]);
    });

    it("leaves them alone when it is the other side of the conversation catching up", async () => {
        watched = false;
        await arrive();
        act(() =>
            onFrame?.({ kind: "read", channelId: CHANNEL, userId: "grace" }, { owner: true })
        );
        expect(closed).toEqual([]);
        expect(dismissed).toEqual([]);
    });
});
