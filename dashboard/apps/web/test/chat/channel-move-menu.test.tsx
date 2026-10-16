// @vitest-environment jsdom

/**
 * Moving a channel from its menu: under another heading, or to the top or the
 * bottom of its own. The same write the drag makes, drawn before the answer and
 * put back on a refusal, and only for whoever may arrange the space.
 */

import { MessagesWrapper, withMessages } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as move from "@/app/(app)/chat/channel-move";

let access: "member" | "admin" = "admin";
let visibility: "private" | "public" = "private";
const called: string[] = [];
let refuse = "";
let refreshes = 0;

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
    reorderChannelsAction: async (input: { categoryId: string | null; channelIds: string[] }) => {
        called.push(`reorder:${input.categoryId ?? "none"}:${input.channelIds.join(",")}`);
        return refuse ? { error: refuse } : {};
    },
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
    mayChangePrivacy: access !== "member",
    mayModerate: access !== "member",
    mayPicture: false,
    mayPin: false,
    ownerId: null,
    membersMayEdit: false,
    membersMayInvite: true,
    mayInvite: true,
    membersMayMention: true,
    mayMentionRoom: true,
    slowmode: 0,
    userLimit: 0,
    contentMode: "default",
    ageConfirmed: true,
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
        refresh: () => {
            refreshes += 1;
        },
        loaded: true,
        blocked: new Set<string>(),
        friends: new Set<string>()
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
    refuse = "";
    refreshes = 0;
    chatState = buildChat();
});

afterEach(cleanup);
/** What the Move to submenu offers, opened the way the keyboard opens it. */
function openMove(name: string): void {
    fireEvent.contextMenu(screen.getByText(name));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move to" }), { key: "ArrowRight" });
}

const option = (name: string) => screen.getByRole("menuitem", { name });

describe("where a channel goes, worked out", () => {
    const rail = [
        { id: "a", categoryId: null },
        { id: "b", categoryId: "talk" },
        { id: "c", categoryId: "talk" },
        { id: "d", categoryId: "talk" },
        { id: "e", categoryId: "games" }
    ];

    it("puts it first or last under its own heading", () => {
        expect(move.channelMoveOrder(rail, "d", { to: "first" })).toEqual({
            categoryId: "talk",
            channelIds: ["d", "b", "c"]
        });
        expect(move.channelMoveOrder(rail, "b", { to: "last" })).toEqual({
            categoryId: "talk",
            channelIds: ["c", "d", "b"]
        });
    });

    it("puts it at the end of another heading, or under none", () => {
        expect(move.channelMoveOrder(rail, "c", { to: "category", categoryId: "games" })).toEqual({
            categoryId: "games",
            channelIds: ["e", "c"]
        });
        expect(move.channelMoveOrder(rail, "c", { to: "category", categoryId: null })).toEqual({
            categoryId: null,
            channelIds: ["a", "c"]
        });
    });

    it("asks for nothing when it is already there", () => {
        expect(move.channelMoveOrder(rail, "b", { to: "first" })).toBeNull();
        expect(move.channelMoveOrder(rail, "d", { to: "last" })).toBeNull();
        expect(move.channelMoveOrder(rail, "e", { to: "first" })).toBeNull();
        expect(move.channelMoveOrder(rail, "c", { to: "category", categoryId: "talk" })).toBeNull();
    });

    it("knows when a list already carries the order", () => {
        const order = move.channelMoveOrder(rail, "b", { to: "last" })!;
        expect(move.reflectsChannelOrder(rail, order)).toBe(false);
        expect(move.reflectsChannelOrder(move.withChannelOrder(rail, order), order)).toBe(true);
    });

    it("draws the new order before it is stored", () => {
        const order = move.channelMoveOrder(rail, "c", { to: "category", categoryId: "games" })!;
        const drawn = move.withChannelOrder(rail, order);
        expect(
            drawn.filter((entry) => entry.categoryId === "games").map((entry) => entry.id)
        ).toEqual(["e", "c"]);
        expect(
            drawn.filter((entry) => entry.categoryId === "talk").map((entry) => entry.id)
        ).toEqual(["b", "d"]);
    });
});

describe("Move to on a channel's menu", () => {
    it("is not offered to a member, who may not arrange the space", () => {
        access = "member";
        chatState = buildChat();
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(screen.getByText("general"));
        expect(items()).not.toContain("Move to");
    });

    it("switches off the place the channel already has", () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        openMove("general");
        expect(option("First in category").getAttribute("aria-disabled")).toBe("true");
        expect(option("Last in category").getAttribute("aria-disabled")).toBeNull();
        fireEvent.keyDown(option("Category"), { key: "ArrowRight" });
        expect(option("Talk").getAttribute("aria-disabled")).toBe("true");
        expect(option("No category").getAttribute("aria-disabled")).toBeNull();
    });

    it("sends the heading's new order through the reorder the drag uses, and draws it at once", async () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        openMove("general");
        fireEvent.click(option("Last in category"));
        expect(called).toEqual(["reorder:category-1:c2,c1"]);
        const rows = screen.getAllByRole("link").map((link) => link.textContent ?? "");
        expect(rows.findIndex((text) => text.includes("random"))).toBeLessThan(
            rows.findIndex((text) => text.includes("general"))
        );
    });

    it("keeps the new order drawn through a list that does not carry it yet", async () => {
        const { rerender } = render(<ChatSidebar />, { wrapper: MessagesWrapper });
        openMove("general");
        fireEvent.click(option("Last in category"));
        await vi.waitFor(() => expect(refreshes).toBe(1));
        const order = () => {
            const rows = screen.getAllByRole("link").map((link) => link.textContent ?? "");
            return rows.findIndex((text) => text.includes("random")) <
                rows.findIndex((text) => text.includes("general"))
                ? "moved"
                : "old";
        };
        chatState = {
            ...chatState,
            channels: [channel("c1", "general", 0), channel("c2", "random", 0)]
        };
        rerender(<ChatSidebar />);
        expect(order()).toBe("moved");
        chatState = {
            ...chatState,
            channels: [channel("c2", "random", 0), channel("c1", "general", 0)]
        };
        rerender(<ChatSidebar />);
        expect(order()).toBe("moved");
    });

    it("offers no Category list in a space with no headings", () => {
        chatState = {
            ...buildChat(),
            categories: [],
            channels: [channel("c1", "general", 3), channel("c2", "random", 0)].map((entry) => ({
                ...entry,
                categoryId: null
            }))
        };
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        openMove("general");
        expect(screen.queryByRole("menuitem", { name: "Category" })).toBeNull();
        expect(option("Last in category")).toBeTruthy();
    });

    it("moves it under no heading", () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        openMove("random");
        fireEvent.keyDown(option("Category"), { key: "ArrowRight" });
        fireEvent.click(option("No category"));
        expect(called).toEqual(["reorder:none:c2"]);
    });

    it("puts the order back when the server refuses it", async () => {
        refuse = "Not allowed.";
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        openMove("general");
        fireEvent.click(option("Last in category"));
        await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Not allowed."));
        const rows = screen.getAllByRole("link").map((link) => link.textContent ?? "");
        expect(rows.findIndex((text) => text.includes("general"))).toBeLessThan(
            rows.findIndex((text) => text.includes("random"))
        );
    });
});
