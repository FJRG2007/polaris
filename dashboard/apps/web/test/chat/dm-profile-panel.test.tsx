// @vitest-environment jsdom

/**
 * The column beside a one-to-one conversation, drawn as Discord draws it: no
 * "Profile" bar across the top, the friend request and the three dots on the
 * band, what the two of you have in common as counts that open, the bio cut to
 * a few lines with the rest one press away, when they joined, and the way to the
 * larger view.
 *
 * And the search panel the header's box opens, which searches for what was
 * typed there straight away.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { SearchPanel } from "@/app/(app)/chat/search-panel";
import { DirectProfile } from "@/app/(app)/chat/direct-profile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const PERSON = { id: "grace", name: "Grace Hopper" };

const CHANNEL = {
    id: "d1",
    name: "Grace Hopper",
    kind: "dm",
    spaceId: null,
    categoryId: null,
    archived: false,
    ownerId: null,
    unreadCount: 0,
    mayModerate: false,
    others: [PERSON]
};

let friendship = "none";
let searched: unknown[] = [];

const PROFILE = () => ({
    name: "Grace Hopper",
    fullName: "",
    username: "grace",
    description: "Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven",
    headline: "",
    pronouns: "",
    role: null,
    restricted: false,
    memberSince: "2021-03-04T12:00:00.000Z",
    friendship,
    mutual: {
        friends: { people: [{ id: "alan", name: "Alan Turing", username: "alan" }], total: 3 },
        spaces: { spaces: [{ id: "s1", name: "Compilers", color: "#336699" }], total: 1 }
    }
});

vi.mock("@/app/(app)/chat/chat-reads", () => ({
    chatProfile: async () => ({ profile: PROFILE() })
}));

vi.mock("@/app/(app)/chat/actions", () => ({
    askFriendAction: async () => ({}),
    profileAction: async () => ({ profile: PROFILE() }),
    openDirectAction: async () => ({ id: "d1" }),
    addSpaceMembersAction: async () => ({}),
    transferGroupAction: async () => ({}),
    timeOutMemberAction: async () => ({}),
    removeSpaceMemberAction: async () => ({}),
    removeChannelMemberAction: async () => ({}),
    searchPeopleAction: async () => [],
    searchMessagesAction: async (query: unknown) => {
        searched.push(query);
        return { hits: [] };
    }
}));

vi.mock("@/app/(app)/account/privacy/actions", () => ({
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({ reportPersonAction: async () => ({}) }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        viewerId: "ada",
        blocked: new Set<string>(),
        friends: new Set<string>(),
        spaces: [],
        channels: [CHANNEL],
        refresh: () => undefined,
        setActiveSpaceId: () => undefined
    })
}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));
vi.mock("@/app/(app)/chat/use-wide-screen", () => ({ useWideScreen: () => true }));

function panel() {
    return render(
        <DirectProfile
            person={PERSON}
            channel={CHANNEL as never}
            open
            onOpenChange={() => undefined}
            onMention={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
}

beforeEach(() => {
    friendship = "none";
    searched = [];
    // jsdom lays nothing out; a bio taller than its box is what a clamp sees.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get() {
            return 200;
        }
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get() {
            return 80;
        }
    });
});

afterEach(cleanup);

describe("the profile column", () => {
    it("has no title bar - the band is the top", async () => {
        panel();
        await screen.findByText("Grace Hopper");
        expect(screen.queryByText("Profile")).toBeNull();
    });

    it("puts the friend request and the three dots on the band", async () => {
        panel();
        expect(
            await screen.findByRole("button", { name: "Send Grace Hopper a friend request" })
        ).toBeDefined();
        expect(
            screen.getByRole("button", { name: "What you can do about Grace Hopper" })
        ).toBeDefined();
    });

    it("offers no request to a friend", async () => {
        friendship = "friends";
        panel();
        await screen.findByText("grace");
        expect(screen.queryByRole("button", { name: /friend request/ })).toBeNull();
    });

    it("shows what you have in common as counts that open into the list", async () => {
        panel();
        const friends = await screen.findByRole("button", { name: "3 friends in common" });
        expect(screen.getByRole("button", { name: "1 space in common" })).toBeDefined();
        expect(screen.queryByText("Alan Turing")).toBeNull();
        await userEvent.click(friends);
        expect(friends.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByText("Alan Turing").closest("a")?.getAttribute("href")).toBe("/u/alan");
        expect(screen.getByText("and 2 more")).toBeDefined();
    });

    it("cuts a long bio and opens the rest on request", async () => {
        panel();
        const more = await screen.findByRole("button", { name: "View full bio" });
        await userEvent.click(more);
        expect(screen.getByRole("button", { name: "Show less" })).toBeDefined();
    });

    it("says when they joined and offers the full profile", async () => {
        panel();
        expect(await screen.findByText("Member since")).toBeDefined();
        expect(screen.getByText("Mar 4, 2021")).toBeDefined();
        expect(screen.getByRole("button", { name: "View full profile" })).toBeDefined();
    });
});

const ROOM = "00000000-0000-4000-8000-0000000000d1";

describe("the search the header opens", () => {
    it("searches straight away for what was typed into the header", async () => {
        render(
            <SearchPanel
                channelId={ROOM}
                channelName="Grace Hopper"
                initialTerm="compiler"
                onClose={() => undefined}
                onOpen={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        expect((screen.getByDisplayValue("compiler") as HTMLInputElement).value).toBe("compiler");
        await waitFor(() => expect(searched).toHaveLength(1));
        expect(searched[0]).toMatchObject({ term: "compiler", channelId: ROOM });
    });

    it("asks nothing when opened without a term", async () => {
        render(
            <SearchPanel
                channelId={ROOM}
                channelName="Grace Hopper"
                onClose={() => undefined}
                onOpen={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(searched).toHaveLength(0);
    });
});
