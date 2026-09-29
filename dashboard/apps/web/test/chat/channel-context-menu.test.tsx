// @vitest-environment jsdom

/**
 * Right-clicking a channel or a heading in the rail, as a reader sees it.
 *
 * Somebody who runs the space gets what Discord's menu offers - edit,
 * duplicate, create another under the same heading, delete - and a member gets
 * only what changes their own view. The heading has a menu of its own.
 */

import { MessagesWrapper, withMessages } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let access: "member" | "admin" = "admin";
let visibility: "private" | "public" = "private";
const called: string[] = [];

vi.mock("next/navigation", () => ({
    useParams: () => ({}),
    usePathname: () => "/chat",
    useRouter: () => ({ push: () => undefined })
}));
// Server actions the dialogs reach import the session; nothing here runs them.
vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    voicePresenceAction: async () => ({ inRoom: {} }),
    markChannelsReadAction: async (input: { channelIds: string[] }) => {
        called.push(`read:${input.channelIds.join(",")}`);
        return {};
    },
    markUnreadAction: async () => ({}),
    setPinnedAction: async () => ({}),
    listInvitesAction: async () => ({ invites: [] }),
    searchPeopleAction: async () => ({ people: [] })
}));

const channel = (id: string, name: string, unread: number) => ({
    id,
    spaceId: "space-1",
    categoryId: "category-1",
    kind: "text",
    name,
    topic: "",
    private: false,
    archived: false,
    lastMessageAt: null,
    unread,
    muted: false,
    notifyLevel: "inherit",
    pinned: false,
    mutedUntil: null,
    mayAdminister: access !== "member",
    mayModerate: access !== "member",
    mayPicture: false,
    ownerId: null,
    membersMayEdit: false,
    membersMayInvite: true,
    mayInvite: true,
    membersMayMention: true,
    mayMentionRoom: true,
    slowmode: 0,
    userLimit: 0,
    others: [],
    gameLinks: []
});

// Built once per test, as the real context holds its lists: a new array on
// every render would be a new list of voice rooms to ask about on every render.
let chatState: Record<string, unknown> = {};
function buildChat(): Record<string, unknown> {
    return {
        viewerId: "ada",
        may: { spaces: true, groups: true, attach: true, call: false, meetings: false },
        channels: [channel("c1", "general", 3), channel("c2", "random", 0)],
        spaces: [
            {
                id: "space-1",
                name: "Crew",
                description: "",
                color: "",
                visibility,
                orgId: null,
                orgName: null,
                archived: false,
                access,
                notifyLevel: "all"
            }
        ],
        categories: [{ id: "category-1", spaceId: "space-1", name: "Talk" }],
        activeSpaceId: "space-1",
        setActiveSpaceId: () => undefined,
        refresh: () => undefined,
        loaded: true,
        blocked: new Set<string>()
    };
}

vi.mock("@/app/(app)/chat/chat-context", () => ({ useChat: () => chatState }));

const { ChatSidebar } = await import("@/app/(app)/chat/chat-sidebar");

function items(): string[] {
    return screen.getAllByRole("menuitem").map((item) => item.textContent?.trim() ?? "");
}

beforeEach(() => {
    access = "admin";
    visibility = "private";
    called.length = 0;
    chatState = buildChat();
});

afterEach(cleanup);

describe("right-clicking a channel", () => {
    it("offers an administrator the whole menu", () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(screen.getByText("general"));
        expect(items()).toEqual(
            expect.arrayContaining([
                "Mark as read",
                "Invite people",
                "Copy link",
                "Copy ID",
                "Edit channel",
                "Duplicate channel",
                "Create channel",
                "Delete channel"
            ])
        );
        expect(items()).not.toContain("Mark as unread");
    });

    it("offers a member of a private space only what changes their own view", () => {
        access = "member";
        chatState = buildChat();
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(screen.getByText("random"));
        const offered = items();
        expect(offered).toContain("Mark as unread");
        expect(offered).toContain("Copy link");
        for (const admin of ["Invite people", "Edit channel", "Duplicate channel", "Delete channel"]) {
            expect(offered).not.toContain(admin);
        }
    });

    it("lets a member of an open space invite people", () => {
        access = "member";
        visibility = "public";
        chatState = buildChat();
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(screen.getByText("random"));
        expect(items()).toContain("Invite people");
    });

    it("reads in Spanish", () => {
        render(withMessages(<ChatSidebar />, "es-ES"));
        fireEvent.contextMenu(screen.getByText("general"));
        expect(items()).toEqual(
            expect.arrayContaining(["Marcar leído", "Duplicar canal", "Eliminar canal"])
        );
    });
});

describe("right-clicking a heading", () => {
    it("marks what is unread under it as read, and offers an administrator its tools", async () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(screen.getByText("Talk"));
        expect(items()).toEqual(
            expect.arrayContaining([
                "Mark as read",
                "Collapse category",
                "Collapse all categories",
                "Expand all categories",
                "Create channel",
                "Edit category",
                "Delete category"
            ])
        );
        fireEvent.click(screen.getByRole("menuitem", { name: "Mark as read" }));
        await vi.waitFor(() => expect(called).toEqual(["read:c1"]));
    });

    it("folds the heading from its menu", () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(screen.getByText("Talk"));
        fireEvent.click(screen.getByRole("menuitem", { name: "Collapse category" }));
        expect(screen.queryByText("general")).toBeNull();
    });
});
