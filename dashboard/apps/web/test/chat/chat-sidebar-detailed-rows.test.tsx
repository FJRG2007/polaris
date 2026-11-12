// @vitest-environment jsdom

/**
 * The conversation list dragged wide, as a reader sees it: from DETAILED_FROM
 * up the rows are a messenger's - the last message, who said it in a group,
 * when, and the ticks on the reader's own - and below it they stay compact.
 */

import { MessagesWrapper } from "../setup/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
    useParams: () => ({}),
    usePathname: () => "/chat",
    useRouter: () => ({ push: () => undefined })
}));
vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/chat/lock-actions", () => ({
    lockStateAction: async () => ({ hasCode: false, hideLocked: false })
}));
vi.mock("@/components/step-up-dialog", () => ({ StepUpDialog: () => null }));
vi.mock("@/app/(app)/chat/actions", () => ({
    voicePresenceAction: async () => ({ inRoom: {} }),
    searchPeopleAction: async () => ({ people: [] }),
    listInvitesAction: async () => ({ invites: [] })
}));

let chatState: Record<string, unknown> = {};
vi.mock("@/app/(app)/chat/chat-context", () => ({ useChat: () => chatState }));

/** A ResizeObserver that reports whatever width the test sets. */
let width = 0;
const watching = new Set<(entries: { contentRect: { width: number } }[]) => void>();
class FakeResizeObserver {
    constructor(private readonly report: (entries: { contentRect: { width: number } }[]) => void) {}
    observe() {
        watching.add(this.report);
        this.report([{ contentRect: { width } }]);
    }
    disconnect() {
        watching.delete(this.report);
    }
    unobserve() {}
}
function dragTo(next: number) {
    width = next;
    act(() => {
        for (const report of watching) report([{ contentRect: { width } }]);
    });
}

const { ChatSidebar } = await import("@/app/(app)/chat/chat-sidebar");
const { DETAILED_FROM } = await import("@/app/(app)/chat/list-view");

const at = new Date().toISOString();
const last = (authorId: string, body: string, ticks: { delivered: boolean; read: boolean }) => ({
    authorId,
    kind: "text",
    body,
    at,
    receipts: true,
    deleted: false,
    ...ticks
});
const conversation = (
    id: string,
    kind: "dm" | "group",
    name: string,
    others: { id: string; name: string }[],
    lastMessage: ReturnType<typeof last>
) => ({
    id,
    spaceId: null,
    categoryId: null,
    kind,
    name,
    topic: "",
    private: true,
    archived: false,
    lastMessageAt: at,
    unread: 0,
    muted: false,
    notifyLevel: "inherit",
    pinned: false,
    locked: false,
    hidden: false,
    mutedUntil: null,
    mayAdminister: false,
    mayChangePrivacy: false,
    mayModerate: false,
    mayPicture: false,
    mayPin: false,
    ownerId: null,
    membersMayEdit: true,
    membersMayInvite: true,
    mayInvite: true,
    membersMayMention: true,
    mayMentionRoom: true,
    slowmode: 0,
    userLimit: 0,
    contentMode: "default",
    ageConfirmed: true,
    others,
    gameLinks: [],
    last: lastMessage
});

beforeEach(() => {
    width = 0;
    watching.clear();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    chatState = {
        viewerId: "ada",
        may: { spaces: true, groups: true, attach: true, call: false, meetings: false },
        channels: [
            conversation("dm-1", "dm", "Grace", [{ id: "grace", name: "Grace" }], {
                ...last("ada", "See you at nine", { delivered: true, read: true })
            }),
            conversation(
                "group-1",
                "group",
                "Lab",
                [
                    { id: "grace", name: "Grace" },
                    { id: "linus", name: "Linus" }
                ],
                last("linus", "Build is green", { delivered: false, read: false })
            )
        ],
        spaces: [],
        categories: [],
        activeSpaceId: null,
        setActiveSpaceId: () => undefined,
        refresh: () => undefined,
        loaded: true,
        kept: false,
        loadFailed: false,
        blocked: new Set<string>(),
        friends: new Set<string>()
    };
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the conversation list dragged wide", () => {
    it("stays compact while it is narrow", () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        dragTo(DETAILED_FROM - 1);
        expect(screen.queryByText("See you at nine")).toBeNull();
        expect(screen.queryByLabelText("Read")).toBeNull();
    });

    it("shows the last message, its time and the ticks once it is wide", () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        dragTo(DETAILED_FROM);
        // A one-to-one: the line itself, with the read ticks on the reader's own.
        expect(screen.getByText("See you at nine")).toBeTruthy();
        expect(screen.getByLabelText("Read")).toBeTruthy();
        // A group: who said it, and no ticks on somebody else's message.
        expect(screen.getByText("Linus: Build is green")).toBeTruthy();
        expect(document.querySelectorAll("time")).toHaveLength(2);
    });

    it("keeps the detailed rows when its scrollbar takes a few pixels", () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        dragTo(DETAILED_FROM + 2);
        expect(screen.getByText("See you at nine")).toBeTruthy();
        dragTo(DETAILED_FROM - 8);
        expect(screen.getByText("See you at nine")).toBeTruthy();
    });

    it("goes back to compact when it is narrowed again", () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        dragTo(DETAILED_FROM + 40);
        expect(screen.getByText("See you at nine")).toBeTruthy();
        dragTo(DETAILED_FROM - 40);
        expect(screen.queryByText("See you at nine")).toBeNull();
    });
});
