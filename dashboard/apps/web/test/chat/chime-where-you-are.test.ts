/**
 * A message in a conversation somebody is looking at does not chime anywhere,
 * and one that should chime does so in the window they are using.
 *
 * The desktop app and a browser share no storage, so neither can tell the other
 * "I am showing this". The server can: every window reports what it shows while
 * it is visible and focused (`notifications/presence`), the words of a toast are
 * asked of the server (`chat/toasts`), and the server says which kind of client
 * makes the sound (`notifications/live-clients`). This covers all three
 * together, with the database mocked the way the read-mark test does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    messages: [] as { id: string; createdAt: Date; authorId: string }[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannelMember: {
            findMany: async () => [{ channelId: "c1", locked: false, lastReadAt: null }]
        },
        chatMessage: {
            findMany: async () =>
                state.messages.map((message) => ({
                    ...message,
                    channelId: "c1",
                    body: `<p>${message.id}</p>`,
                    attachments: [],
                    channel: { id: "c1", name: "general", kind: "channel", spaceId: "s1", members: [] }
                }))
        },
        user: { findMany: async () => [{ id: "bob", name: "Bob" }] }
    }
}));
vi.mock("@/lib/chat/access", () => ({ reachableChannelIds: async () => new Set(["c1", "c2"]) }));
vi.mock("@/lib/chat/notify", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/notify")>("@/lib/chat/notify");
    return {
        ...actual,
        notifyLevels: async () => new Map([["c1", "all"]]),
        readerTeams: async () => new Set(),
        mentionsReader: () => false
    };
});
vi.mock("@/lib/chat/history-visibility", () => ({
    historyFloors: async () => new Map(),
    readableWhere: () => ({})
}));
vi.mock("@/lib/chat/age-gate", () => ({ ageClearedWhere: () => ({}) }));
vi.mock("@/lib/blocks", () => ({ blockedBy: async () => new Set() }));

const { messageToasts } = await import("@/lib/chat/toasts");
const presence = await import("@/lib/notifications/presence");
const live = await import("@/lib/notifications/live-clients");

const actor = { id: "alice" } as Parameters<typeof messageToasts>[0];
const WEB_TAB = "00000000-0000-4000-8000-000000000001";
const APP_WINDOW = "00000000-0000-4000-8000-000000000002";
const PHONE = "00000000-0000-4000-8000-000000000003";

async function announced(): Promise<string[]> {
    return (await messageToasts(actor, ["c1"])).map((toast) => toast.messageId);
}

beforeEach(() => {
    presence.resetPresence();
    live.resetLiveClients();
    state.messages = [{ id: "bob-says", createdAt: new Date(Date.now() - 1000), authorId: "bob" }];
    // Alice has the desktop app and a browser open, both with the sound on.
    live.openLiveClient("alice", "app", "desktop", true, Date.now() - 2000);
    live.openLiveClient("alice", "web", "browser", true, Date.now() - 1000);
});

describe("a conversation open in front of somebody", () => {
    it("viewing it in the browser silences the desktop app", async () => {
        presence.recordPresence("alice", WEB_TAB, "/chat/c/c1", Date.now(), null, "browser");
        // The app behind the browser asks for the words of the message: none.
        expect(await announced()).toEqual([]);
        // And for anything else, the browser is the one that sounds.
        expect(live.chimingKind("alice")).toBe("browser");
        expect(live.liveClientChimes("alice", "app")).toBe(false);
    });

    it("viewing it in the desktop app silences the browser", async () => {
        presence.recordPresence("alice", APP_WINDOW, "/chat/c/c1/m1", Date.now(), null, "desktop");
        expect(await announced()).toEqual([]);
        expect(live.chimingKind("alice")).toBe("desktop");
        expect(live.liveClientChimes("alice", "web")).toBe(false);
    });

    it("a conversation open on another device is covered by the same check", async () => {
        // A phone, or a page from before the client kind was reported.
        presence.recordPresence("alice", PHONE, "/chat/c/c1", Date.now());
        expect(await announced()).toEqual([]);
    });

    it("another conversation open does not silence this one", async () => {
        presence.recordPresence("alice", WEB_TAB, "/chat/c/c2", Date.now(), null, "browser");
        expect(await announced()).toEqual(["bob-says"]);
        // Nor does a conversation whose id merely starts the same way.
        presence.recordPresence("alice", WEB_TAB, "/chat/c/c10", Date.now(), null, "browser");
        expect(await announced()).toEqual(["bob-says"]);
    });

    it("still finds the message a notice already drawn announced", async () => {
        // Answering or marking read from a notice looks up its message, and the
        // conversation being open somewhere must not lose it.
        presence.recordPresence("alice", WEB_TAB, "/chat/c/c1", Date.now(), null, "browser");
        const found = await messageToasts(actor, ["c1"], { includeViewed: true });
        expect(found.map((toast) => toast.messageId)).toEqual(["bob-says"]);
    });

    it("does not silence somebody else", async () => {
        presence.recordPresence("carol", WEB_TAB, "/chat/c/c1", Date.now(), null, "browser");
        expect(await announced()).toEqual(["bob-says"]);
    });
});

describe("nobody viewing it", () => {
    it("is announced, and the focused window chimes", async () => {
        presence.recordPresence("alice", WEB_TAB, "/tasks", Date.now(), null, "browser");
        expect(await announced()).toEqual(["bob-says"]);
        expect(live.chimingKind("alice")).toBe("browser");
        expect(live.liveClientChimes("alice", "web")).toBe(true);
        expect(live.liveClientChimes("alice", "app")).toBe(false);
    });

    it("follows the person to the app when they switch to it", () => {
        presence.recordPresence("alice", WEB_TAB, "/tasks", Date.now() - 2000, null, "browser");
        presence.dropPresence("alice", WEB_TAB);
        presence.recordPresence("alice", APP_WINDOW, "/drive", Date.now(), null, "desktop");
        expect(live.chimingKind("alice")).toBe("desktop");
    });

    it("a blurred window does not count as viewing", async () => {
        presence.recordPresence("alice", WEB_TAB, "/chat/c/c1", Date.now(), null, "browser");
        // Blur or hidden withdraws the report (`presence-reporter`).
        presence.dropPresence("alice", WEB_TAB);
        expect(await announced()).toEqual(["bob-says"]);
        // With no window in front of anybody, the old rule: the app.
        expect(live.chimingKind("alice")).toBe("desktop");
    });

    it("a report that went quiet stops counting", async () => {
        const long = Date.now() - presence.PRESENCE_TTL_MS - 1000;
        presence.recordPresence("alice", WEB_TAB, "/chat/c/c1", long, null, "browser");
        expect(await announced()).toEqual(["bob-says"]);
        expect(live.chimingKind("alice")).toBe("desktop");
    });

    it("a focused browser idle for minutes still beats the app", () => {
        live.markLiveClientActive("alice", "web", live.BROWSER_IDLE_MS * 3);
        presence.recordPresence("alice", WEB_TAB, "/tasks", Date.now(), null, "browser");
        expect(live.chimingKind("alice")).toBe("browser");
    });

    it("a browser with the sound off is never elected for being in front", () => {
        live.resetLiveClients();
        live.openLiveClient("alice", "app", "desktop", true);
        live.openLiveClient("alice", "web", "browser", false);
        presence.recordPresence("alice", WEB_TAB, "/tasks", Date.now(), null, "browser");
        expect(live.chimingKind("alice")).toBe("desktop");
    });
});
