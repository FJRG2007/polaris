// @vitest-environment jsdom

/**
 * The people under the subject, as two labelled rows.
 *
 * It used to be one sentence - "to a, b, copy to c" - which read as prose and
 * needed punctuation between its two halves to make sense. Two rows with their
 * labels in a column is what a mail client does, and it is also what gives a long
 * list somewhere to be folded: a fold in the middle of a sentence is a sentence
 * that stops.
 *
 * So what is pinned here is the shape: each row labelled, commas only between the
 * addresses of one row and never trailing, a message delivered blind saying so
 * rather than showing a gap, and a list past a few people folded behind a count
 * that opens it.
 */

import * as core from "@polaris/core";
import { ToastProvider } from "@polaris/ui";
import { ThreadView } from "@/app/(app)/mail/thread-view";
import type { MailViewContext } from "@/app/(app)/mail/mail-view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MailMessageView, MailThreadView } from "@/lib/mailbox/views";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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

function draw(to: readonly core.MailAddress[], cc: readonly core.MailAddress[]): void {
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
}

/** One row of the header, read the way somebody reads it. */
function row(label: string): string {
    const found = screen.getByText(label).parentElement;
    if (!found) throw new Error(`The "${label}" row is not inside anything`);
    return found.textContent ?? "";
}

/** Named with their own address, which is the chip that draws it once. */
const BEA = { name: "bea@example.test", address: "bea@example.test" };
const CARL = { name: "carl@example.test", address: "carl@example.test" };
const DORA = { name: "dora@example.test", address: "dora@example.test" };
const ELI = { name: "eli@example.test", address: "eli@example.test" };
const FRAN = { name: "fran@example.test", address: "fran@example.test" };

describe("the row of people a message went to", () => {
    it("separates two recipients with a comma and stops at the last", () => {
        draw([BEA, CARL], []);
        expect(row("to")).toBe("tobea@example.test,carl@example.test");
    });

    it("says so when the message was delivered blind", () => {
        // The To line is empty because nobody was disclosed, which is a fact
        // about the message rather than something missing from it.
        draw([], [CARL]);
        expect(row("to")).toBe("toundisclosed recipients");
    });
});

describe("the copy list", () => {
    it("is a row of its own, labelled, rather than the tail of a sentence", () => {
        draw([BEA], [CARL]);
        expect(row("to")).toBe("tobea@example.test");
        expect(row("copy to")).toBe("copy tocarl@example.test");
    });

    it("is absent entirely when nobody was copied", () => {
        draw([BEA], []);
        expect(screen.queryByText("copy to")).toBeNull();
    });
});

describe("a list longer than the header should carry", () => {
    it("folds the rest behind a count", () => {
        draw([BEA, CARL, DORA, ELI, FRAN], []);
        const line = row("to");
        expect(line).toContain("+2 more");
        expect(line).not.toContain("eli@example.test");
    });

    it("opens it where somebody asks", () => {
        draw([BEA, CARL, DORA, ELI, FRAN], []);
        fireEvent.click(screen.getByText("+2 more"));
        const line = row("to");
        expect(line).toContain("eli@example.test");
        expect(line).toContain("fran@example.test");
        expect(line).not.toContain("more");
    });
});
