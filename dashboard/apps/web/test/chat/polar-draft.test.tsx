// @vitest-environment jsdom

/**
 * Polar's answer read as it is written: frames from the stream become a row at
 * the end of the conversation that grows, drawn as Polar's message (its name,
 * its AI tag, nothing to press), and the posted answer takes that row's place in
 * the same element - so nothing is drawn twice, blanks or jumps.
 */

import { act, useState } from "react";
import { MessagesWrapper } from "../setup/i18n";
import type { ChatMessageView } from "@/lib/chat/messages";
import { ShortcutsProvider, ToastProvider } from "@polaris/ui";
import { cleanup, render, screen } from "@testing-library/react";
import type { ChatFrame } from "@/app/(app)/chat/use-chat-stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const handlers = new Set<(frame: ChatFrame) => void>();
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: ChatFrame) => void) => {
        handlers.add(handler);
    }
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    deleteMessageAction: async () => ({}),
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
        channels: [],
        spaces: [],
        may: {},
        refresh: () => undefined
    })
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));

import { MessageList } from "@/app/(app)/chat/message-list";
import { usePolarDrafts } from "@/app/(app)/chat/polar-draft";
import { useChatStream } from "@/app/(app)/chat/use-chat-stream";

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
    cleanup();
    handlers.clear();
});

function message(id: string, extra: Partial<ChatMessageView> = {}): ChatMessageView {
    return {
        id,
        channelId: "c1",
        authorId: "ada",
        authorName: "Ada",
        kind: "text",
        body: `message ${id}`,
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
        createdAt: new Date(1_700_000_000_000).toISOString(),
        ...extra
    } as unknown as ChatMessageView;
}

let setStored: (messages: readonly ChatMessageView[]) => void = () => undefined;

function Conversation({ initial }: { initial: readonly ChatMessageView[] }) {
    const [stored, store] = useState(initial);
    setStored = store;
    const drafts = usePolarDrafts("c1", null, stored);
    useChatStream(drafts.onFrame);
    return (
        <MessageList
            messages={[...stored, ...drafts.rows]}
            viewerId="ada"
            canPost
            canModerate={false}
            onReact={() => undefined}
            onStar={() => undefined}
            onForward={() => undefined}
            onEdit={() => undefined}
            onDelete={() => undefined}
        />
    );
}

function draw(initial: readonly ChatMessageView[]) {
    return render(
        <ShortcutsProvider overrides={{}}>
            <ToastProvider>
                <Conversation initial={initial} />
            </ToastProvider>
        </ShortcutsProvider>,
        { wrapper: MessagesWrapper }
    );
}

function frame(text: string, extra: { messageId?: string; channelId?: string; parentId?: string | null } = {}) {
    act(() => {
        for (const handler of handlers)
            handler({ kind: "draft", channelId: "c1", key: "ask", parentId: null, text, ...extra } as ChatFrame);
    });
}

const asked = message("ask", { body: "@polar how many servers?" });

describe("Polar's answer as it is written", () => {
    it("grows at the end, drawn as Polar's message with the question quoted", () => {
        draw([asked]);
        frame("There are");
        frame("There are two servers.");
        const row = document.getElementById("message-polar-draft:ask")!;
        expect(row.getAttribute("aria-busy")).toBe("true");
        expect(row.textContent).toContain("There are two servers.");
        expect(row.textContent).toContain("Polar");
        expect(row.textContent).toContain("AI");
        expect(row.textContent).toContain("Ada");
        // Last in the conversation, and nothing on it to press.
        expect(document.querySelector("ol")!.lastElementChild).toBe(row);
        expect(row.querySelector('[aria-label="Add reaction"]')).toBeNull();
    });

    it("is taken back when Polar goes to its tools, and ignores other conversations", () => {
        draw([asked]);
        frame("Let me look");
        frame("");
        expect(document.getElementById("message-polar-draft:ask")).toBeNull();
        frame("elsewhere", { channelId: "c2" });
        frame("in a thread", { parentId: "t1" });
        expect(document.getElementById("message-polar-draft:ask")).toBeNull();
    });

    it("hands its element to the posted answer, without a moment of neither or both", () => {
        draw([asked]);
        frame("There are two servers.");
        const drafted = document.querySelector("ol")!.lastElementChild;
        // Posted: the draft holds the whole answer until the message is here.
        frame("There are two servers.", { messageId: "m2" });
        expect(document.getElementById("message-polar-draft:ask")).not.toBeNull();
        act(() =>
            setStored([
                asked,
                message("m2", {
                    authorId: null,
                    authorName: "Polar",
                    fromAgent: "polar",
                    body: "There are two servers."
                } as Partial<ChatMessageView>)
            ])
        );
        expect(document.getElementById("message-polar-draft:ask")).toBeNull();
        const landed = document.getElementById("message-m2")!;
        expect(landed).toBe(drafted);
        expect(screen.getAllByText("There are two servers.")).toHaveLength(1);
    });
});
