/**
 * The Chat quick switcher's answers, and who gets any.
 *
 * Every kind is answered from something already bounded to what the reader
 * reaches - the people they may message, their own rail, the messages in
 * conversations they are in - so what is pinned here is that nothing else leaks
 * in, that each kind lands where it should, and that the whole of it sits behind
 * the Chat grant.
 */

import type { SessionUser } from "@/lib/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listChannels = vi.fn();
const listSpaces = vi.fn();
const searchForConversation = vi.fn();
const searchMessages = vi.fn();
const userHasManage = vi.fn();
const searchMentions = vi.fn();

vi.mock("@/lib/chat/chat-service", () => ({ listChannels, listSpaces }));
vi.mock("@/lib/chat/access", () => ({ searchForConversation }));
vi.mock("@/lib/chat/search", () => ({ searchMessages }));
vi.mock("@/lib/session", () => ({ userHasManage }));
vi.mock("@/lib/rich-text/mention-service", () => ({ searchMentions }));
vi.mock("@/components/rich-text/excerpt", () => ({
    plainExcerpt: (text: string) => text.replace(/\*/g, "")
}));

const { lookup, canSearchScope } = await import("@/lib/search/lookup-service");

const user = { id: "0193b0f0-0000-7000-8000-000000000001", isAdmin: false } as SessionUser;

function channel(partial: Record<string, unknown>) {
    return {
        id: "c",
        spaceId: null,
        kind: "text",
        name: "",
        others: [],
        lastMessageAt: null,
        ...partial
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    userHasManage.mockResolvedValue(true);
    listSpaces.mockResolvedValue([{ id: "s1", name: "Studio" }]);
    listChannels.mockResolvedValue([
        channel({
            id: "dm-ana",
            kind: "dm",
            name: "Ana Ruiz",
            others: [{ id: "u-ana", name: "Ana Ruiz" }],
            lastMessageAt: "2026-09-01T10:00:00Z"
        }),
        channel({
            id: "grp",
            kind: "group",
            name: "Release crew",
            others: [{ id: "u-bo", name: "Bo" }],
            lastMessageAt: "2026-09-02T10:00:00Z"
        }),
        channel({ id: "general", kind: "text", name: "release-notes", spaceId: "s1" }),
        channel({ id: "lounge", kind: "voice", name: "Lounge", spaceId: "s1" })
    ]);
    searchForConversation.mockResolvedValue({
        people: [{ id: "u-ana", name: "Ana Ruiz" }],
        withheld: 0
    });
    searchMessages.mockResolvedValue([
        {
            channelId: "grp",
            channelName: "Release crew",
            inSpace: false,
            message: { id: "m1", body: "the **release** is out", authorName: "Bo" }
        }
    ]);
});

describe("who may search Chat", () => {
    it("is whoever holds the Chat grant, and nobody else is told anything", async () => {
        userHasManage.mockResolvedValue(false);
        for (const scope of ["chat", "contacts", "chats", "channels", "messages"] as const) {
            expect(await canSearchScope(user, scope)).toBe(false);
            expect(await lookup(user, { scope, query: "release" })).toEqual([]);
        }
        expect(userHasManage).toHaveBeenCalledWith(user, "chat.use");
        expect(listChannels).not.toHaveBeenCalled();
        expect(searchMessages).not.toHaveBeenCalled();
        expect(searchForConversation).not.toHaveBeenCalled();
    });
});

describe("one kind at a time", () => {
    it("finds people to message, and opens the conversation with them", async () => {
        const [hit] = await lookup(user, { scope: "contacts", query: "ana" });
        expect(searchForConversation).toHaveBeenCalledWith(user, "ana", expect.any(Number));
        expect(hit).toMatchObject({
            scope: "contacts",
            label: "Ana Ruiz",
            href: "/chat/with/u-ana"
        });
    });

    it("finds direct messages and groups by who is in them, newest first", async () => {
        const all = await lookup(user, { scope: "chats", query: "" });
        expect(all.map((hit) => hit.id)).toEqual(["grp", "dm-ana"]);
        const byMember = await lookup(user, { scope: "chats", query: "bo" });
        expect(byMember.map((hit) => hit.href)).toEqual(["/chat/c/grp"]);
    });

    it("finds channels in the reader's spaces, named with the space", async () => {
        const hits = await lookup(user, { scope: "channels", query: "lou" });
        expect(hits).toEqual([
            expect.objectContaining({
                id: "lounge",
                detail: "Voice - Studio",
                href: "/chat/c/lounge"
            })
        ]);
        // Every channel is not an answer to an empty box.
        expect(await lookup(user, { scope: "channels", query: "" })).toEqual([]);
    });

    it("finds messages and opens each at the line", async () => {
        const [hit] = await lookup(user, { scope: "messages", query: "release" });
        expect(searchMessages).toHaveBeenCalledWith(
            user,
            expect.objectContaining({ term: "release", channelId: null })
        );
        expect(hit).toMatchObject({
            label: "the release is out",
            detail: "Bo in Release crew",
            href: "/chat/c/grp/m1"
        });
    });
});

describe("all of Chat at once", () => {
    it("answers every kind, reading the rail once", async () => {
        const hits = await lookup(user, { scope: "chat", query: "release" });
        expect(new Set(hits.map((hit) => hit.scope))).toEqual(
            new Set(["contacts", "chats", "channels", "messages"])
        );
        expect(listChannels).toHaveBeenCalledTimes(1);
    });

    it("offers recent conversations and nothing else before anything is typed", async () => {
        const hits = await lookup(user, { scope: "chat", query: "" });
        expect(hits.every((hit) => hit.scope === "chats")).toBe(true);
        expect(searchMessages).not.toHaveBeenCalled();
        expect(searchForConversation).not.toHaveBeenCalled();
    });
});
