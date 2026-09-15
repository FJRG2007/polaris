// @vitest-environment jsdom

/**
 * The line of people under the subject, read as a sentence.
 *
 * The comma between two recipients belongs to the chip that carries the address
 * - see `address-chip-separator`. That leaves the composition itself to be
 * pinned here: the comma before "copy to" is the same punctuation, and a message
 * delivered blind has no chip to carry one, so the words have to.
 */

import * as core from "@polaris/core";
import { ToastProvider } from "@polaris/ui";
import { ThreadView } from "@/app/(app)/mail/thread-view";
import { cleanup, render, screen } from "@testing-library/react";
import type { MailViewContext } from "@/app/(app)/mail/mail-view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MailMessageView, MailThreadView } from "@/lib/mailbox/views";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined })
}));

vi.mock("@/app/(app)/mail/mail-shell", () => ({
    useMail: () => ({
        refreshMailbox: () => undefined,
        reloadLists: () => undefined,
        openComposer: () => undefined,
        accounts: [],
        labels: [],
        accountColor: () => "",
        askFolderRole: () => undefined
    })
}));

vi.mock("@/app/(app)/mail/message-store", () => ({
    readMessage: async () => ({ readable: { html: "", text: "", remoteBlocked: 0 } })
}));

vi.mock("@/app/(app)/mail/actions", () => ({
    actOnAction: async () => ({}),
    applyLabelAction: async () => ({}),
    setConversationStateAction: async () => ({})
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
    accountId: "0190c1d2-0000-7000-8000-000000000001",
    subject: "The quarter",
    snippet: "",
    participants: [],
    messageCount: 1,
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

function message(
    to: readonly core.MailAddress[],
    cc: readonly core.MailAddress[]
): MailMessageView {
    return {
        id: "0190c1d2-0000-7000-8000-0000000000e1",
        accountId: THREAD.accountId,
        folderId: "0190c1d2-0000-7000-8000-0000000000d1",
        folderRole: "inbox",
        subject: THREAD.subject,
        from: [{ name: "Ana", address: "ana@example.test" }],
        to,
        cc,
        replyTo: [],
        snippet: "",
        sentAt: THREAD.lastMessageAt,
        seen: true,
        flagged: false,
        important: false,
        answered: false,
        wantsReceipt: false,
        listId: "",
        spamScore: null,
        spamReason: "",
        attachments: []
    };
}

/** The recipient line of the one open message, as somebody reads it. */
function line(to: readonly core.MailAddress[], cc: readonly core.MailAddress[]): string {
    render(
        <ToastProvider>
            <ThreadView
                thread={THREAD}
                messages={[message(to, cc)]}
                context={CONTEXT}
                markRead="never"
            />
        </ToastProvider>
    );
    const found = screen.getByText("to").parentElement;
    if (!found) throw new Error("The recipient line is not inside anything");
    return found.textContent ?? "";
}

/** Named with their own address, which is the chip that draws it once. */
const BEA = { name: "bea@example.test", address: "bea@example.test" };
const CARL = { name: "carl@example.test", address: "carl@example.test" };
const DORA = { name: "dora@example.test", address: "dora@example.test" };

describe("the recipient line", () => {
    it("separates two recipients with a comma and stops at the last", () => {
        expect(line([BEA, CARL], [])).toBe("tobea@example.test,carl@example.test");
    });

    it("keeps the comma before the copy list", () => {
        expect(line([BEA], [CARL])).toBe("tobea@example.test,copy tocarl@example.test");
    });

    it("keeps it for a message delivered blind, which has no chip to carry one", () => {
        // The To line is empty, so nothing in it holds the punctuation that
        // belongs between the two halves of the sentence.
        expect(line([], [CARL, DORA])).toBe(
            "toundisclosed recipients,copy tocarl@example.test,dora@example.test"
        );
    });

    it("leaves the words alone where there is no copy list", () => {
        expect(line([], [])).toBe("toundisclosed recipients");
    });
});
