// @vitest-environment jsdom

/**
 * "Remove friend" wherever a person's menu is.
 *
 * The report: right-clicking a direct message offered Block, but no way to stop
 * being friends - that lived only on the Friends screen and the profile page.
 * The conversation row and every person's menu (the roster, a message's author,
 * their card) now offer it, only for somebody who is a friend, and only after
 * the app's own confirmation.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const removeFriendAction = vi.fn(async (_id: string) => ({}));
const refresh = vi.fn();

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
    unblockPersonAction: async () => ({}),
    removeFriendAction
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    voicePresenceAction: async () => ({ inRoom: {} }),
    markChannelsReadAction: async () => ({}),
    markUnreadAction: async () => ({}),
    setPinnedAction: async () => ({}),
    listInvitesAction: async () => ({ invites: [] }),
    searchPeopleAction: async () => ({ people: [] }),
    conversationsElsewhereAction: async () => ({ chats: [] })
}));
vi.mock("@/app/(app)/scope-actions", () => ({ setWorkspaceScopeAction: async () => ({}) }));
vi.mock("@/components/report-person-dialog", () => ({ ReportPersonDialog: () => null }));

const dm = {
    id: "dm-1",
    spaceId: null,
    categoryId: null,
    kind: "dm",
    name: "Bob",
    topic: "",
    private: true,
    archived: false,
    lastMessageAt: null,
    unread: 0,
    muted: false,
    notifyLevel: "all",
    pinned: false,
    mutedUntil: null,
    mayAdminister: false,
    mayModerate: false,
    mayPicture: false,
    ownerId: null,
    membersMayEdit: false,
    membersMayInvite: false,
    mayInvite: false,
    membersMayMention: true,
    mayMentionRoom: false,
    slowmode: 0,
    userLimit: 0,
    others: [{ id: "bob", name: "Bob" }],
    gameLinks: []
};

let friends = new Set<string>(["bob"]);
let chatState: Record<string, unknown> = {};
const buildChat = () => ({
    viewerId: "ada",
    may: { spaces: true, groups: true, attach: true, call: false, meetings: false },
    channels: [dm],
    spaces: [],
    categories: [],
    activeSpaceId: null,
    setActiveSpaceId: () => undefined,
    refresh,
    loaded: true,
    blocked: new Set<string>(),
    friends
});

vi.mock("@/app/(app)/chat/chat-context", () => ({ useChat: () => chatState }));

const { ChatSidebar } = await import("@/app/(app)/chat/chat-sidebar");
const { MemberMenu } = await import("@/app/(app)/chat/member-menu");

const items = (): string[] =>
    screen.getAllByRole("menuitem").map((item) => item.textContent?.trim() ?? "");

beforeEach(() => {
    friends = new Set(["bob"]);
    chatState = buildChat();
    removeFriendAction.mockClear();
    refresh.mockClear();
});
afterEach(cleanup);

describe("a direct message's menu", () => {
    it("offers Remove friend for a friend, and asks before doing it", async () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(screen.getAllByText("Bob")[0]!);
        expect(items()).toContain("Remove friend");

        await act(async () => {
            fireEvent.click(screen.getByRole("menuitem", { name: "Remove friend" }));
        });
        const dialog = await screen.findByRole("dialog");
        expect(dialog.textContent).toContain("Stop being friends with Bob?");
        expect(removeFriendAction).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));
        });
        await waitFor(() => expect(removeFriendAction).toHaveBeenCalledWith("bob"));
        expect(refresh).toHaveBeenCalled();
    });

    it("does nothing when the question is answered no", async () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(screen.getAllByText("Bob")[0]!);
        await act(async () => {
            fireEvent.click(screen.getByRole("menuitem", { name: "Remove friend" }));
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        });
        expect(removeFriendAction).not.toHaveBeenCalled();
    });

    it("does not offer it for somebody who is not a friend", () => {
        friends = new Set();
        chatState = buildChat();
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(screen.getAllByText("Bob")[0]!);
        expect(items()).not.toContain("Remove friend");
        expect(items()).toContain("Block");
    });
});

describe("a person's menu in a conversation", () => {
    function menuFor(userId: string) {
        render(
            <MessagesWrapper>
                <MemberMenu
                    member={{ userId, name: "Bob" }}
                    channel={{ ...dm, kind: "group", ownerId: "someone" } as never}
                    viewerId="ada"
                    onNickname={() => undefined}
                    onChanged={() => undefined}
                    onError={() => undefined}
                >
                    <button type="button">Bob row</button>
                </MemberMenu>
            </MessagesWrapper>
        );
        fireEvent.contextMenu(screen.getByText("Bob row"));
    }

    it("offers Remove friend for a friend", () => {
        menuFor("bob");
        expect(items()).toContain("Remove friend");
    });

    it("leaves it out for anybody else", () => {
        menuFor("carol");
        expect(items()).not.toContain("Remove friend");
    });
});
