// @vitest-environment jsdom

/**
 * A draft that was sent leaves the drafts screen without a reload.
 *
 * The queue deletes the draft on the server once the message goes and says so
 * on the live channel as a "sending" frame. The drafts screen was rendered once
 * from the page and never listened, so a sent message sat there as a draft until
 * somebody reloaded. It now asks for its own list again on that frame - one
 * query, not the router re-rendering the signed-in frame.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { MailDraftView } from "@/lib/mailbox/compose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const DRAFT: MailDraftView = {
    id: "draft-1",
    accountId: "account-1",
    identityId: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "Still writing this",
    body: "",
    inReplyToId: null,
    forward: false,
    sendAt: null,
    state: "draft",
    failure: "",
    willRetry: false,
    updatedAt: new Date().toISOString()
};

const fake = vi.hoisted(() => ({
    onFrame: null as ((frame: { kind: string; accountId: string }) => void) | null,
    listCalls: 0
}));

vi.mock("@/app/(app)/mail/mail-shell", () => ({
    useMail: () => ({ openComposer: () => undefined, reloadLists: () => undefined })
}));
vi.mock("@/app/(app)/mail/use-mail-stream", () => ({
    useMailStream: (onFrame: (frame: { kind: string; accountId: string }) => void) => {
        fake.onFrame = onFrame;
    }
}));
vi.mock("@/app/(app)/mail/refusal", () => ({ refusalOf: () => null }));
vi.mock("@/app/(app)/mail/actions", () => ({
    discardDraftAction: async () => ({}),
    retrySendAction: async () => ({}),
    listDraftsAction: async () => {
        fake.listCalls += 1;
        return [];
    }
}));
vi.mock("@/components/display-format", () => ({
    useDisplayFormat: () => ({ dateTime: (date: Date) => date.toISOString() })
}));
vi.mock("@polaris/ui", async (original) => {
    const real = await original<typeof import("@polaris/ui")>();
    return { ...real, useToast: () => ({ show: () => undefined }) };
});

const { DraftsView } = await import("@/app/(app)/mail/drafts/drafts-view");

afterEach(() => {
    cleanup();
    fake.onFrame = null;
    fake.listCalls = 0;
    vi.useRealTimers();
});

describe("a draft sent from the composer", () => {
    it("leaves the drafts list once the queue says it went, with no reload", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        render(<DraftsView drafts={[DRAFT]} />, { wrapper: MessagesWrapper });
        expect(screen.getByText("Still writing this")).toBeTruthy();

        expect(fake.onFrame).toBeTruthy();
        fake.onFrame!({ kind: "sending", accountId: "account-1" });

        // The settle window: a burst of frames asks the server only once.
        fake.onFrame!({ kind: "sending", accountId: "account-1" });
        await vi.advanceTimersByTimeAsync(300);
        await vi.advanceTimersByTimeAsync(0);

        expect(screen.queryByText("Still writing this")).toBeNull();
        expect(fake.listCalls).toBe(1);
    });

    it("ignores frames that are not about a message sending", () => {
        render(<DraftsView drafts={[DRAFT]} />, { wrapper: MessagesWrapper });
        fake.onFrame!({ kind: "mail", accountId: "account-1" });
        expect(screen.getByText("Still writing this")).toBeTruthy();
        expect(fake.listCalls).toBe(0);
    });
});

describe("the drafts screen's list action", () => {
    it("asks for this caller's drafts, one query", async () => {
        const actions = await import("@/app/(app)/mail/actions");
        await actions.listDraftsAction();
        expect(fake.listCalls).toBe(1);
    });
});

describe("the queue tells every tab a message left", () => {
    it("publishes a sending frame when a draft leaves the queue", async () => {
        const { readFile } = await import("node:fs/promises");
        const compose = await readFile("src/lib/mailbox/compose.ts", "utf8");
        expect(compose).toContain(
            'publishMail({ accountId: account.id, kind: "sending", actorId: account.userId });'
        );
    });
});
