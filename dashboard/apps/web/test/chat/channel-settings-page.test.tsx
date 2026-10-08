// @vitest-environment jsdom

/**
 * A channel's settings page, as the person running the channel sees it.
 *
 * The section list Discord's has, the draft that collects under an unsaved bar
 * and is saved in one call, Esc back to the channel (held while changes are
 * unsaved), Delete behind a confirmation, and nothing at all for somebody who
 * may not change the channel.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pushed: string[] = [];
const called: Array<{ name: string; input: unknown }> = [];
let pathname = "/chat/c/c1/settings/overview";
let mayAdminister = true;
let kind = "text";

vi.mock("next/navigation", () => ({
    usePathname: () => pathname,
    useRouter: () => ({ push: (href: string) => pushed.push(href), refresh: () => undefined })
}));
vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));
vi.mock("@/app/(app)/chat/actions", () => ({
    updateChannelAction: async (input: unknown) => {
        called.push({ name: "update", input });
        return {};
    },
    deleteChannelAction: async (input: unknown) => {
        called.push({ name: "delete", input });
        return {};
    },
    listMembersAction: async () => ({
        members: [
            { userId: "ada", name: "Ada", role: "admin" },
            { userId: "grace", name: "Grace", role: "member" }
        ]
    }),
    removeChannelMemberAction: async (channelId: string, userId: string) => {
        called.push({ name: "remove", input: { channelId, userId } });
        return {};
    },
    listInvitesAction: async () => ({ invites: [] }),
    listWebhooksAction: async () => ({ webhooks: [] }),
    searchPeopleAction: async () => ({ people: [] })
}));

const channel = () => ({
    id: "c1",
    spaceId: "space-1",
    categoryId: null,
    kind,
    name: "general",
    topic: "Talk",
    private: false,
    archived: false,
    lastMessageAt: null,
    unread: 0,
    muted: false,
    notifyLevel: "inherit",
    pinned: false,
    mutedUntil: null,
    mayAdminister,
    mayModerate: mayAdminister,
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
    blocked: false,
    gameLinks: []
});

let chatState: Record<string, unknown> = {};
vi.mock("@/app/(app)/chat/chat-context", () => ({ useChat: () => chatState }));

const { ChannelSettings } = await import("@/app/(app)/chat/channel-settings");

beforeEach(() => {
    pushed.length = 0;
    called.length = 0;
    pathname = "/chat/c/c1/settings/overview";
    mayAdminister = true;
    kind = "text";
    chatState = {
        viewerId: "ada",
        channels: [channel()],
        spaces: [],
        loaded: true,
        refresh: () => undefined
    };
});

afterEach(cleanup);

function show() {
    return render(<ChannelSettings channelId="c1" />, { wrapper: MessagesWrapper });
}

describe("the page", () => {
    it("lists Discord's sections, and Delete apart from them", () => {
        show();
        const nav = screen.getByRole("navigation");
        const links = Array.from(nav.querySelectorAll("a")).map((link) => [
            link.textContent?.trim(),
            link.getAttribute("href")
        ]);
        expect(links).toEqual([
            ["Overview", "/chat/c/c1/settings/overview"],
            ["Permissions", "/chat/c/c1/settings/permissions"],
            ["Invite links", "/chat/c/c1/settings/invites"],
            ["Integrations", "/chat/c/c1/settings/integrations"]
        ]);
        expect(screen.getByRole("button", { name: "Delete channel" })).toBeTruthy();
        expect(screen.getByText("Text channel")).toBeTruthy();
    });

    it("shows nothing but a refusal to somebody who may not change it", () => {
        mayAdminister = false;
        chatState = { ...chatState, channels: [channel()] };
        show();
        expect(screen.getByText("You cannot change this channel")).toBeTruthy();
        expect(screen.queryByRole("navigation")).toBeNull();
    });

    it("offers the user limit on a voice channel only", () => {
        show();
        expect(screen.queryByText("User limit")).toBeNull();
        cleanup();
        kind = "voice";
        chatState = { ...chatState, channels: [channel()] };
        show();
        expect(screen.getByText("User limit")).toBeTruthy();
        expect(screen.getByText("Voice channel")).toBeTruthy();
    });
});

describe("the draft", () => {
    it("collects edits under the unsaved bar and saves them in one call", async () => {
        show();
        expect(screen.queryByRole("status")).toBeNull();
        fireEvent.change(screen.getByLabelText("Channel topic"), {
            target: { value: "Release talk" }
        });
        expect(screen.getByRole("status").textContent).toContain("You have unsaved changes");
        fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(called).toHaveLength(1));
        expect(called[0]).toEqual({
            name: "update",
            input: {
                channelId: "c1",
                name: "general",
                topic: "Release talk",
                slowmode: 0,
                contentMode: "default",
                private: false
            }
        });
        await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    });

    it("puts everything back on Reset", () => {
        show();
        fireEvent.change(screen.getByLabelText("Channel topic"), { target: { value: "x" } });
        fireEvent.click(screen.getByRole("button", { name: "Reset" }));
        expect(screen.queryByRole("status")).toBeNull();
        expect((screen.getByLabelText("Channel topic") as HTMLTextAreaElement).value).toBe("Talk");
    });

    it("holds the save on a topic past Discord's length", () => {
        show();
        fireEvent.change(screen.getByLabelText("Channel topic"), {
            target: { value: "x".repeat(1025) }
        });
        expect(
            (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled
        ).toBe(true);
    });
});

describe("Esc", () => {
    it("goes back to the channel", () => {
        show();
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(pushed).toEqual(["/chat/c/c1"]);
    });

    it("stays while changes are unsaved", () => {
        show();
        fireEvent.change(screen.getByLabelText("Channel topic"), { target: { value: "x" } });
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(pushed).toEqual([]);
    });
});

describe("permissions", () => {
    it("lists who is in a private channel and takes somebody out, never yourself", async () => {
        pathname = "/chat/c/c1/settings/permissions";
        chatState = { ...chatState, channels: [{ ...channel(), private: true }] };
        show();
        await screen.findByText("Grace");
        expect(screen.queryByRole("button", { name: "Remove Ada" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Remove Grace" }));
        await waitFor(() =>
            expect(called).toContainEqual({
                name: "remove",
                input: { channelId: "c1", userId: "grace" }
            })
        );
        expect(screen.queryByText("Grace")).toBeNull();
    });

    it("makes the private switch part of the draft", async () => {
        pathname = "/chat/c/c1/settings/permissions";
        show();
        fireEvent.click(screen.getByRole("switch", { name: "Private channel" }));
        fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(called).toHaveLength(1));
        expect(called[0]?.input).toMatchObject({ private: true });
    });
});

describe("invite links on a private channel", () => {
    it("says why there are none, and where people are let in instead", () => {
        pathname = "/chat/c/c1/settings/invites";
        chatState = { ...chatState, channels: [{ ...channel(), private: true }] };
        show();
        expect(screen.getByRole("link", { name: "Open Permissions" }).getAttribute("href")).toBe(
            "/chat/c/c1/settings/permissions"
        );
    });
});
