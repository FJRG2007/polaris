// @vitest-environment jsdom

/**
 * Copying the message being pointed at.
 *
 * Ctrl+C is the one shortcut in the row that takes a modifier, and a modifier is
 * where a shortcut stops being only about itself. AltGr is Ctrl+Alt on a Spanish,
 * German or Polish keyboard, so AltGr+C is somebody typing a character - claiming
 * it would swallow the letter and put a message on the clipboard instead. Ctrl
 * with Shift belongs to the browser.
 *
 * Proven through focus rather than hover, like the R shortcut next door: jsdom
 * does not track `:hover`, and the hook falls back to whatever has focus for
 * exactly that reason.
 */

import userEvent from "@testing-library/user-event";
import { cleanup, render } from "@testing-library/react";
import { MessageList } from "@/app/(app)/chat/message-list";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/app/(app)/account/report-actions", () => ({
    reportPersonAction: async () => ({})
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        blocked: new Set<string>(),
        channels: [
            {
                id: "c1",
                spaceId: null,
                categoryId: null,
                kind: "group",
                name: "A room",
                archived: false,
                ownerId: null,
                others: []
            }
        ],
        spaces: [],
        refresh: () => undefined
    })
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));

function message(id: string, authorId: string, body = `message ${id}`) {
    return {
        id,
        channelId: "c1",
        authorId,
        authorName: authorId,
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
        createdAt: new Date(1_700_000_000_000).toISOString()
    };
}

const written = vi.fn(async () => undefined);

beforeEach(() => {
    written.mockClear();
});

/** The clipboard, put back after `userEvent.setup()` - it installs one of its
 *  own, and what is being asserted is what the shortcut wrote. */
function watchClipboard() {
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: written }
    });
}

afterEach(cleanup);

function list() {
    return (
        <MessageList
            messages={[message("m1", "grace", "what it says")]}
            viewerId="ada"
            canPost
            canModerate={false}
            onReact={() => undefined}
            onStar={() => undefined}
            onReply={() => undefined}
            onForward={() => undefined}
            onEdit={() => undefined}
            onDelete={() => undefined}
        />
    );
}

describe("the Ctrl+C shortcut", () => {
    it("copies the message whose row has focus", async () => {
        const user = userEvent.setup();
        watchClipboard();
        render(list());

        await user.tab();
        await user.keyboard("{Control>}c{/Control}");

        expect(written).toHaveBeenCalledWith("what it says");
    });

    it("leaves AltGr alone, which is Ctrl+Alt on half the keyboards there are", async () => {
        const user = userEvent.setup();
        watchClipboard();
        render(list());

        await user.tab();
        await user.keyboard("{Control>}{Alt>}c{/Alt}{/Control}");

        expect(written).not.toHaveBeenCalled();
    });

    it("leaves Ctrl+Shift+C alone, which the browser has already claimed", async () => {
        const user = userEvent.setup();
        watchClipboard();
        render(list());

        await user.tab();
        await user.keyboard("{Control>}{Shift>}C{/Shift}{/Control}");

        expect(written).not.toHaveBeenCalled();
    });
});
