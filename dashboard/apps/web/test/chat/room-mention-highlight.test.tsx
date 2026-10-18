// @vitest-environment jsdom

/**
 * `@everyone`, `@here` and a team mention mark the message for everybody they
 * reach, exactly the way a mention of the reader by name does.
 *
 * The report: a direct mention turned the message yellow and `@everyone` did
 * not. Every way a message reaches the screen - the first page of history, the
 * catch-up after a live frame, the re-read after somebody edits it, a thread -
 * is a server read that runs `decorateMessages`, which sets `mentionsYou` from
 * `mentionsReader` over the stored body; the screen then swaps the message in
 * whole. So this checks the bodies the composer actually stores (typed, or put
 * in by the @ picker), that a live edit replaces the mark rather than keeping
 * the old one, and that the list paints the room mention the same as the name.
 */

import { MessagesWrapper } from "../setup/i18n";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/(app)/chat/actions", () => ({
    saveMediaAction: async () => ({}),
    unsaveMediaAction: async () => ({}),
    linkPreviewAction: async () => ({}),
    openDirectAction: async () => ({ id: "d1" })
}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({ reportPersonAction: async () => ({}) }));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        blocked: new Set<string>(),
        friends: new Set<string>(),
        refresh: () => undefined,
        channels: [
            { id: "c1", spaceId: null, categoryId: null, kind: "group", name: "A room", archived: false, ownerId: null, others: [] }
        ],
        spaces: []
    })
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const { mentionsReader } = await import("@/lib/chat/notify");
const { docToMarkdown, REFERENCE } = await import("@/components/rich-text/markdown");
const { applyChanged } = await import("@/app/(app)/chat/message-changes");
const { MessageList } = await import("@/app/(app)/chat/message-list");

const READER = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";

/** A one-paragraph document, the way the composer holds it before sending. */
const paragraph = (...content: object[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
const text = (value: string) => ({ type: "text", text: value });
const reference = (kind: string, id: string, label: string) => ({ type: REFERENCE, attrs: { kind, id, label } });

describe("what the composer stores is read as reaching the reader", () => {
    const cases: [string, object][] = [
        ["@everyone typed", paragraph(text("deploy at five @everyone"))],
        ["@everyone from the @ picker", paragraph(text("@everyone "), text("deploy at five"))],
        ["@here typed", paragraph(text("@here anyone around?"))],
        ["@here from the @ picker", paragraph(text("@here "))],
        ["@all, the other spelling", paragraph(text("ping @all"))],
        ["@everyone in bold", paragraph({ type: "text", text: "@everyone", marks: [{ type: "bold" }] })],
        ["the reader's team", paragraph(text("cc "), reference("team", TEAM, "Ops"))],
        ["the reader by name", paragraph(text("hey "), reference("user", READER, "Ada"))]
    ];

    for (const [name, doc] of cases) {
        it(name, () => {
            const body = docToMarkdown(doc);
            expect(mentionsReader(body, READER, new Set([TEAM]))).toBe(true);
        });
    }

    it("not inside code, where somebody shows one without waking the room", () => {
        const body = docToMarkdown(paragraph({ type: "text", text: "@everyone", marks: [{ type: "code" }] }));
        expect(mentionsReader(body, READER)).toBe(false);
    });

    it("not a team the reader is not on", () => {
        const body = docToMarkdown(paragraph(reference("team", "33333333-3333-4333-8333-333333333333", "Other")));
        expect(mentionsReader(body, READER, new Set([TEAM]))).toBe(false);
    });
});

function message(id: string, body: string, mentionsYou: boolean) {
    return {
        id,
        channelId: "c1",
        authorId: "grace",
        authorName: "grace",
        kind: "text" as const,
        body,
        parentId: null,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [],
        quote: null,
        starred: false,
        references: [],
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        mentionsYou,
        createdAt: new Date(1_700_000_000_000).toISOString()
    };
}

describe("the one who sent it", () => {
    // Discord marks your own `@everyone` too: you are in the room it reaches.
    it("is reached by their own @everyone, @here and team", () => {
        expect(mentionsReader(docToMarkdown(paragraph(text("@everyone go"))), READER, undefined, true)).toBe(true);
        expect(mentionsReader(docToMarkdown(paragraph(text("@here go"))), READER, undefined, true)).toBe(true);
        const team = docToMarkdown(paragraph(reference("team", TEAM, "Ops")));
        expect(mentionsReader(team, READER, new Set([TEAM]), true)).toBe(true);
    });

    it("is not named by naming themselves", () => {
        const body = docToMarkdown(paragraph(reference("user", READER, "Ada")));
        expect(mentionsReader(body, READER, undefined, true)).toBe(false);
    });

    it("sees their own @everyone marked while it is still sending", async () => {
        const { draftMessage } = await import("@/app/(app)/chat/draft-message");
        const facts = { id: "d", channelId: "c1", authorId: READER, authorName: "Ada", createdAt: new Date().toISOString() };
        expect(draftMessage({ ...facts, body: "@everyone go" } as never).mentionsYou).toBe(true);
        expect(draftMessage({ ...facts, body: "just me" } as never).mentionsYou).toBe(false);
    });
});

describe("an edit that arrives live", () => {
    it("takes the mark the re-read came back with", () => {
        const before = [message("m1", "deploy at five", false)];
        const after = applyChanged(before as never, ["m1"], [message("m1", "deploy at five @everyone", true)] as never);
        expect(after[0]?.mentionsYou).toBe(true);
        const undone = applyChanged(after, ["m1"], [message("m1", "deploy at five", false)] as never);
        expect(undone[0]?.mentionsYou).toBe(false);
    });
});

describe("the list", () => {
    afterEach(cleanup);

    const rowClass = (id: string, container: HTMLElement) =>
        container.querySelector(`#message-${id}`)?.className ?? "";

    it("marks a room mention exactly like a mention by name", () => {
        const { container } = render(
            <MessageList
                messages={[
                    message("named", "[@Ada](polaris:user/11111111-1111-4111-8111-111111111111) look", true),
                    message("room", "@everyone look", true),
                    message("here", "@here look", true),
                    message("plain", "nothing for you", false)
                ] as never}
                viewerId={READER}
                canPost
                canModerate={false}
                onReact={() => undefined}
                onStar={() => undefined}
                onDelete={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        const named = rowClass("named", container);
        expect(named).toContain("bg-warning-soft");
        expect(named).toContain("border-warning");
        expect(rowClass("room", container)).toBe(named);
        expect(rowClass("here", container)).toBe(named);
        expect(rowClass("plain", container)).not.toContain("bg-warning-soft");
    });
});
