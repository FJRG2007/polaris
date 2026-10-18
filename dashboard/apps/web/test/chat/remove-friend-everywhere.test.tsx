// @vitest-environment jsdom

/**
 * Every place that removes a friend asks first, in the app's own dialog.
 *
 * The report: removing a friend had no confirmation. Each entry point is drawn
 * here and pressed - the Friends screen's row, the profile page's menu, a
 * person's menu in a conversation, and the menu on the card a name opens - and
 * each must show the question and remove nobody until it is answered yes.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const removeFriendAction = vi.fn(async (_id: string) => ({}));
const stopBeingFriendsAction = vi.fn(async (_input: unknown) => ({}));
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
    useParams: () => ({}),
    usePathname: () => "/chat",
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("next/link", () => ({
    default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}));
vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({}),
    loadFriendsAction: async () => ({ items: [], cursor: null }),
    requestFriendAction: async () => ({}),
    loadFriendRequestsAction: async () => ({ requests: [] }),
    requestFriendByUsernameAction: async () => ({}),
    respondToRequestAction: async () => ({}),
    searchPeopleAction: async () => ({ people: [] }),
    removeFriendAction
}));
vi.mock("@/app/u/[username]/actions", () => ({
    askToBeFriendsAction: async () => ({}),
    followAction: async () => ({}),
    unfollowAction: async () => ({}),
    stopBeingFriendsAction
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    openDirectAction: async () => ({}),
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
vi.mock("@/components/notifications/notifications-provider", () => ({
    useNotificationFeed: () => ({ items: [] })
}));
vi.mock("@/components/avatar", () => ({ Avatar: () => null }));
vi.mock("@/components/person-name", () => ({
    PersonName: ({ name }: { name: string }) => <>{name}</>,
    PersonRow: ({ children }: { children: React.ReactNode }) => <li>{children}</li>
}));
// The card's own content is a profile read from the server; only its actions
// matter here.
vi.mock("@/app/(app)/chat/profile-details", () => ({
    ProfileDetails: ({ actions }: { actions: React.ReactNode }) => <div>{actions}</div>,
    useChatProfile: () => ({ profile: null, loading: false })
}));
vi.mock("@/app/(app)/chat/use-open-direct", () => ({
    useOpenDirect: () => ({ busy: false, open: () => undefined })
}));
vi.mock("@/app/(app)/chat/nickname-dialog", () => ({ NicknameDialog: () => null }));

const group = {
    id: "group-1",
    spaceId: null,
    categoryId: null,
    kind: "group",
    name: "Crew",
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
    mayChangePrivacy: false,
    mayModerate: false,
    mayPicture: false,
    mayPin: false,
    ownerId: "someone",
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

const chatState = {
    viewerId: "ada",
    may: { spaces: true, groups: true, attach: true, call: false, meetings: false },
    channels: [group],
    spaces: [],
    categories: [],
    activeSpaceId: null,
    setActiveSpaceId: () => undefined,
    refresh,
    loaded: true,
    blocked: new Set<string>(),
    friends: new Set<string>(["bob"])
};
vi.mock("@/app/(app)/chat/chat-context", () => ({ useChat: () => chatState }));

const { FriendsView } = await import("@/app/(app)/account/friends/friends-view");
const { ProfileActions } = await import("@/app/u/[username]/profile-actions");
const { MemberMenu } = await import("@/app/(app)/chat/member-menu");
const { PersonCardProvider } = await import("@/app/(app)/chat/person-card");
const { usePersonPress } = await import("@/components/person-press");

beforeEach(() => {
    removeFriendAction.mockClear();
    stopBeingFriendsAction.mockClear();
    refresh.mockClear();
});
afterEach(cleanup);

/** The question is on screen and nothing has been removed yet. */
async function expectAsked(question: string, removed: () => unknown[][]) {
    const dialog = await screen.findByRole("dialog", { name: question });
    expect(dialog).toBeTruthy();
    expect(removed()).toHaveLength(0);
}

describe("the Friends screen", () => {
    const draw = () =>
        render(<FriendsView friends={[{ id: "bob", name: "Bob", contact: "@bob" }]} requests={[]} more={null} />, {
            wrapper: MessagesWrapper
        });

    it("asks before removing, and removes on yes", async () => {
        draw();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Stop being friends with Bob" }));
        });
        await expectAsked("Stop being friends with Bob?", () => removeFriendAction.mock.calls);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Stop being friends" }));
        });
        await waitFor(() => expect(removeFriendAction).toHaveBeenCalledWith("bob"));
    });

    it("removes nobody on cancel", async () => {
        draw();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Stop being friends with Bob" }));
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        });
        expect(removeFriendAction).not.toHaveBeenCalled();
    });
});

describe("the profile page", () => {
    const standing = {
        friendship: "friends",
        following: false,
        canMessage: true,
        blocked: false,
        canAskToBeFriends: false
    } as never;

    async function openMenu() {
        render(<ProfileActions personId="bob" name="Bob" standing={standing} />, { wrapper: MessagesWrapper });
        const more = screen.getByRole("button", { name: /Bob/ });
        fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: "mouse" });
        await act(async () => {
            fireEvent.click(await screen.findByRole("menuitem", { name: "Remove friend" }));
        });
    }

    it("asks before removing, and removes on yes", async () => {
        await openMenu();
        await expectAsked("Stop being friends with Bob?", () => stopBeingFriendsAction.mock.calls);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Stop being friends" }));
        });
        await waitFor(() => expect(stopBeingFriendsAction).toHaveBeenCalledWith({ personId: "bob" }));
    });

    it("removes nobody on cancel", async () => {
        await openMenu();
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        });
        expect(stopBeingFriendsAction).not.toHaveBeenCalled();
    });
});

describe("a person's menu in a conversation", () => {
    it("asks before removing, and removes on yes", async () => {
        render(
            <MessagesWrapper>
                <MemberMenu
                    member={{ userId: "bob", name: "Bob" }}
                    channel={group as never}
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
        await act(async () => {
            fireEvent.click(screen.getByRole("menuitem", { name: "Remove friend" }));
        });
        await expectAsked("Stop being friends with Bob?", () => removeFriendAction.mock.calls);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));
        });
        await waitFor(() => expect(removeFriendAction).toHaveBeenCalledWith("bob"));
    });
});

describe("the card a name opens", () => {
    function Name() {
        const press = usePersonPress();
        return (
            <button type="button" onClick={(event) => press?.({ id: "bob", name: "Bob" } as never, event.currentTarget)}>
                Bob name
            </button>
        );
    }

    async function openCardMenu() {
        render(
            <MessagesWrapper>
                <PersonCardProvider channelId="group-1" viewerId="ada">
                    <Name />
                </PersonCardProvider>
            </MessagesWrapper>
        );
        await act(async () => {
            fireEvent.click(screen.getByText("Bob name"));
        });
        const dialog = await screen.findByRole("dialog");
        const more = Array.from(dialog.querySelectorAll("button")).find(
            (button) => button.getAttribute("aria-haspopup") === "menu"
        );
        expect(more).toBeTruthy();
        fireEvent.pointerDown(more!, { button: 0, ctrlKey: false, pointerType: "mouse" });
        await act(async () => {
            fireEvent.click(await screen.findByRole("menuitem", { name: "Remove friend" }));
        });
    }

    it("asks before removing, and removes on yes", async () => {
        await openCardMenu();
        await expectAsked("Stop being friends with Bob?", () => removeFriendAction.mock.calls);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));
        });
        await waitFor(() => expect(removeFriendAction).toHaveBeenCalledWith("bob"));
    });

    it("removes nobody on cancel", async () => {
        await openCardMenu();
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        });
        expect(removeFriendAction).not.toHaveBeenCalled();
    });
});
