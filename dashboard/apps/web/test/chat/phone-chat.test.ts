/**
 * Chat on a phone: which bottom tab is open, what each tab counts as waiting,
 * and what a list row or a long-press peek says a message was.
 */

import { describe, expect, it } from "vitest";
import type { ChatMessageView } from "@/lib/chat/messages";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { PEEK_LIMIT, peekLines, phoneChatTab, phoneTabBadges, previewText } from "@/app/(app)/chat/phone-chat";

const t = (key: string): string => `[${key}]`;

function channel(fields: Partial<ChatChannelView>): ChatChannelView {
    return { id: "c", spaceId: null, unread: 0, muted: false, ...fields } as ChatChannelView;
}

function message(fields: Partial<ChatMessageView>): ChatMessageView {
    return {
        id: "m",
        authorId: "other",
        authorName: "Aurora",
        kind: "text",
        body: "hello",
        parentId: null,
        deleted: false,
        createdAt: "2026-11-19T10:00:00.000Z",
        ...fields
    } as ChatMessageView;
}

describe("phoneChatTab", () => {
    it("is Calls on the meetings list only", () => {
        expect(phoneChatTab("/chat/meetings", null, false)).toBe("calls");
        expect(phoneChatTab("/chat/meetings", "space-1", true)).toBe("calls");
        expect(phoneChatTab("/chat/meetings/abc", null, false)).toBe("chats");
    });

    it("is Servers while a space is open, or when picked with none to open", () => {
        expect(phoneChatTab("/chat", "space-1", false)).toBe("servers");
        expect(phoneChatTab("/chat", null, true)).toBe("servers");
    });

    it("is Chats otherwise", () => {
        expect(phoneChatTab("/chat", null, false)).toBe("chats");
        expect(phoneChatTab("/chat/c/abc", null, false)).toBe("chats");
    });
});

describe("phoneTabBadges", () => {
    it("splits unread between direct chats and servers, skipping muted ones", () => {
        expect(
            phoneTabBadges([
                channel({ id: "a", unread: 2 }),
                channel({ id: "b", unread: 3, muted: true }),
                channel({ id: "c", spaceId: "s", unread: 4 }),
                channel({ id: "d", spaceId: "s", unread: 1, muted: true }),
                channel({ id: "e", unread: 0 })
            ])
        ).toEqual({ chats: 2, servers: 4 });
    });

    it("is zero for an empty list", () => {
        expect(phoneTabBadges([])).toEqual({ chats: 0, servers: 0 });
    });
});

describe("previewText", () => {
    it("names deleted, call and poll messages, and says nothing for a system line", () => {
        expect(previewText({ deleted: true, kind: "text", body: "x" }, t)).toBe("[listView.deleted]");
        expect(previewText({ deleted: false, kind: "call", body: "" }, t)).toBe("[listView.call]");
        expect(previewText({ deleted: false, kind: "poll", body: "" }, t)).toBe("[listView.poll]");
        expect(previewText({ deleted: false, kind: "system", body: "joined" }, t)).toBe("");
    });

    it("collapses whitespace, and reads an empty body as an attachment", () => {
        expect(previewText({ deleted: false, kind: "text", body: " a\n\n b  c " }, t)).toBe("a b c");
        expect(previewText({ deleted: false, kind: "text", body: "  " }, t)).toBe("[listView.attachment]");
    });
});

describe("peekLines", () => {
    it("keeps the newest top-level lines, oldest first, and marks the viewer's own", () => {
        const lines = peekLines(
            [
                message({ id: "1", body: "first" }),
                message({ id: "2", body: "a reply", parentId: "1" }),
                message({ id: "3", kind: "system", body: "joined" }),
                message({ id: "4", authorId: "me", body: "mine" })
            ],
            "me",
            t
        );
        expect(lines.map((line) => [line.id, line.mine, line.text])).toEqual([
            ["1", false, "first"],
            ["4", true, "mine"]
        ]);
    });

    it("shows plain text rather than the stored Markdown", () => {
        const [line] = peekLines([message({ body: "**bold** [site](https://example.com)" })], "me", t);
        expect(line!.text).not.toMatch(/[*[\]]/);
        expect(line!.text).toContain("bold");
    });

    it("stops at the limit, keeping the newest", () => {
        const many = Array.from({ length: PEEK_LIMIT + 5 }, (_, index) =>
            message({ id: String(index), body: `line ${index}` })
        );
        const lines = peekLines(many, "me", t);
        expect(lines).toHaveLength(PEEK_LIMIT);
        expect(lines.at(-1)!.id).toBe(String(PEEK_LIMIT + 4));
        expect(peekLines([], "me", t)).toEqual([]);
    });
});
