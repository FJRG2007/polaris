// @vitest-environment jsdom

/**
 * What each open message in a conversation offers on its own: its star, a
 * reaction, Reply, and the rest behind a menu - the row Gmail puts beside the
 * date of every message, aimed at that message rather than at the newest one.
 *
 * And the reactions themselves: one that answers a message in the thread is
 * drawn under that message as a chip, never as a card of its own holding one
 * character, and one this tab sends goes out as a reaction (Gmail's format,
 * through the queue, to everybody a reply to all would reach) with its chip
 * drawn at once.
 */

import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import { ThreadView } from "@/app/(app)/mail/thread-view";
import type { MailViewContext } from "@/app/(app)/mail/mail-view";
import type { MailMessageView, MailThreadView } from "@/lib/mailbox/views";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined })
}));

const ACCOUNT = "0190c1d2-0000-7000-8000-000000000001";

vi.mock("@/app/(app)/mail/mail-shell", () => ({
    useMail: () => ({
        refreshMailbox: () => undefined,
        reloadLists: () => undefined,
        openComposer: () => undefined,
        accounts: [{ id: ACCOUNT, address: "me@example.test" }],
        labels: [],
        accountColor: () => "",
        askFolderRole: () => undefined
    })
}));

const READABLE = vi.hoisted(() => ({
    html: "",
    text: "Hello",
    remoteAllowed: false,
    trackerVendors: [],
    unsubscribe: "",
    unsubscribeKind: "",
    unsubscribeSource: "",
    wantsReceipt: false
}));

vi.mock("@/app/(app)/mail/message-store", () => ({
    readMessage: async () => ({ readable: READABLE }),
    peekMessage: () => ({ readable: READABLE }),
    keptMessage: async () => null
}));

const acted: unknown[] = [];
vi.mock("@/app/(app)/mail/actions", () => ({
    actOnAction: async (input: unknown) => {
        acted.push(input);
        return {};
    },
    applyLabelAction: async () => ({}),
    setConversationStateAction: async () => ({})
}));

const queued: Record<string, unknown>[] = [];
vi.mock("@/app/(app)/mail/outbox", () => ({
    queueMessage: async (message: Record<string, unknown>) => {
        queued.push(message);
        return {
            draftId: "0190c1d2-0000-7000-8000-0000000000aa",
            sendAt: new Date().toISOString()
        };
    },
    undoSend: async () => ({ undone: true }),
    isRefused: (outcome: object) => "error" in outcome
}));

// Chat's picker reaches the signed-in session through its server actions. A
// button that picks one emoji is all this needs of it.
vi.mock("@/app/(app)/chat/emoji-picker", () => ({
    EmojiPicker: ({ label, onEmoji }: { label?: string; onEmoji: (emoji: string) => void }) => (
        <button type="button" aria-label={label} onClick={() => onEmoji("🎉")} />
    )
}));

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.scrollIntoView ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
});

beforeEach(() => {
    acted.length = 0;
    queued.length = 0;
});

afterEach(cleanup);

const CONTEXT: MailViewContext = {
    title: "Inbox",
    emptyTitle: "Nothing here",
    emptyBody: "",
    canArchive: true,
    permanentDelete: false,
    restorable: false,
    emptyRole: ""
};

const THREAD: MailThreadView = {
    id: "0190c1d2-0000-7000-8000-0000000000f0",
    accountId: ACCOUNT,
    subject: "The quarter",
    snippet: "",
    participants: [],
    messageCount: 2,
    unreadCount: 0,
    starred: false,
    important: false,
    pinned: false,
    muted: false,
    hasAttachments: false,
    size: 0,
    lastMessageAt: "2026-01-02T10:00:00.000Z",
    unsubscribe: "",
    unsubscribeKind: "",
    unsubscribeSource: "",
    labels: [],
    leadMessageId: "0190c1d2-0000-7000-8000-0000000000e1"
};

function message(over: Partial<MailMessageView>): MailMessageView {
    return {
        id: "0190c1d2-0000-7000-8000-0000000000e1",
        accountId: ACCOUNT,
        folderId: "0190c1d2-0000-7000-8000-0000000000d1",
        folderRole: "inbox",
        messageId: "original@example.test",
        inReplyTo: "",
        reaction: "",
        subject: THREAD.subject,
        from: [{ name: "Ana", address: "ana@example.test" }],
        to: [{ name: "Me", address: "me@example.test" }],
        cc: [{ name: "Ben", address: "ben@example.test" }],
        replyTo: [],
        snippet: "Hello",
        sentAt: THREAD.lastMessageAt,
        seen: true,
        flagged: false,
        important: false,
        answered: false,
        wantsReceipt: false,
        listId: "",
        spamScore: null,
        spamReason: "",
        spamReasons: [],
        delivery: null,
        attachments: [],
        ...over
    };
}

const ORIGINAL = message({});
const BENS_REACTION = message({
    id: "0190c1d2-0000-7000-8000-0000000000e2",
    messageId: "reaction@example.test",
    inReplyTo: "original@example.test",
    reaction: "👍",
    snippet: "👍",
    from: [{ name: "Ben", address: "ben@example.test" }],
    sentAt: "2026-01-02T11:00:00.000Z"
});

function draw(messages: MailMessageView[]): void {
    render(
        <ToastProvider>
            <ThreadView thread={THREAD} messages={messages} context={CONTEXT} markRead="never" />
        </ToastProvider>,
        { wrapper: MessagesWrapper }
    );
}

describe("a reaction somebody sent", () => {
    it("is drawn under the message it answers, not as a message of its own", () => {
        draw([ORIGINAL, BENS_REACTION]);
        const chips = screen.getByRole("list", { name: "Reactions" });
        expect(chips.textContent).toContain("👍");
        expect(screen.getByRole("button", { name: "👍 from Ben" })).toBeTruthy();
        // One card: the original. Ben's reaction is not a second one.
        expect(screen.queryByText("Ben", { selector: "span.w-40" })).toBeNull();
    });

    it("stays a card when the message it answers is not in the thread", () => {
        draw([message({ ...BENS_REACTION, inReplyTo: "elsewhere@example.test" })]);
        expect(screen.queryByRole("list", { name: "Reactions" })).toBeNull();
    });
});

describe("the open message's own buttons", () => {
    it("are there beside the date: star, react, reply, and more", () => {
        draw([ORIGINAL]);
        expect(screen.getByRole("button", { name: "Star this message" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "React with an emoji" })).toBeTruthy();
        expect(screen.getAllByRole("button", { name: "Reply" }).length).toBeGreaterThan(0);
        expect(screen.getByRole("button", { name: "More for this message" })).toBeTruthy();
    });

    it("star only that message", async () => {
        draw([ORIGINAL]);
        fireEvent.click(screen.getByRole("button", { name: "Star this message" }));
        await waitFor(() => expect(acted).toHaveLength(1));
        expect(acted[0]).toEqual({ messageIds: [ORIGINAL.id], action: "star", scope: "message" });
        expect(screen.getByRole("button", { name: "Unstar this message" })).toBeTruthy();
    });

    it("send a reaction to everybody on the message, drawn at once", async () => {
        draw([ORIGINAL]);
        fireEvent.click(screen.getByRole("button", { name: "React with an emoji" }));
        await waitFor(() => expect(queued).toHaveLength(1));
        const sent = queued[0]!;
        expect(sent.reaction).toBe("🎉");
        expect(sent.body).toBe("🎉");
        expect(sent.inReplyToId).toBe(ORIGINAL.id);
        // Reply to all, without the reader's own address.
        const people = [
            ...(sent.to as { address: string }[]),
            ...(sent.cc as { address: string }[])
        ];
        expect(people.map((person) => person.address).sort()).toEqual([
            "ana@example.test",
            "ben@example.test"
        ]);
        expect(screen.getByRole("button", { name: "🎉 from You" })).toBeTruthy();
    });

    it("offer no reaction on a message to more people than Gmail allows", () => {
        const crowd = Array.from({ length: 21 }, (_, index) => ({
            name: "",
            address: `person${index}@example.test`
        }));
        draw([message({ to: crowd, cc: [] })]);
        expect(screen.queryByRole("button", { name: "React with an emoji" })).toBeNull();
    });
});
