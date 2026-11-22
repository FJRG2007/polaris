// @vitest-environment jsdom
/**
 * What the chat rail asks the server for on its own, counted.
 *
 * The waiting message requests were asked for again on every address change,
 * so every conversation opened was one more server action. And every row was a
 * link the router fetched as soon as it was on screen, so a reload was a burst
 * of one request per visible conversation before anything was pressed: the
 * rows now fetch ahead on intent only.
 */

import { MessagesWrapper } from "../setup/i18n";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ path: "/chat", counted: 0, prefetched: [] as string[] }));

vi.mock("next/navigation", () => ({
    useParams: () => ({}),
    usePathname: () => nav.path,
    useRouter: () => ({
        push: () => undefined,
        prefetch: (href: string) => void nav.prefetched.push(href)
    })
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
    messageRequestCountAction: async () => {
        nav.counted += 1;
        return { count: 0 };
    },
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
    membersMaySend: true,
    maySend: true,
    advancedPrivacy: false,
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


async function settle(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
    nav.path = "/chat";
    nav.counted = 0;
    nav.prefetched = [];
});

describe("the message requests waiting", () => {
    it("are asked for once when the rail is up, not on every conversation opened", async () => {
        const view = render(<ChatSidebar />, { wrapper: MessagesWrapper });
        await settle();
        expect(nav.counted).toBe(1);
        for (const id of ["dm-1", "group-1", "dm-1", "group-1", "dm-1"]) {
            nav.path = `/chat/c/${id}`;
            view.rerender(<ChatSidebar />);
            await settle();
        }
        expect(nav.counted).toBe(1);
    });

    it("are asked for again on leaving the requests page", async () => {
        const view = render(<ChatSidebar />, { wrapper: MessagesWrapper });
        await settle();
        nav.path = "/chat/requests";
        view.rerender(<ChatSidebar />);
        await settle();
        expect(nav.counted).toBe(1);
        nav.path = "/chat/c/dm-1";
        view.rerender(<ChatSidebar />);
        await settle();
        expect(nav.counted).toBe(2);
    });
});

describe("the conversation rows", () => {
    it("fetch nothing ahead on sight, and the one under the pointer on intent", async () => {
        const view = render(<ChatSidebar />, { wrapper: MessagesWrapper });
        await settle();
        const rows = [...view.container.querySelectorAll<HTMLAnchorElement>('a[href^="/chat/c/"]')];
        expect(rows.length).toBeGreaterThan(1);
        expect(nav.prefetched).toEqual([]);
        fireEvent.pointerEnter(rows[0]!);
        fireEvent.focus(rows[1]!);
        expect(nav.prefetched).toEqual([rows[0]!.getAttribute("href"), rows[1]!.getAttribute("href")]);
    });
});
