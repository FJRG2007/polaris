// @vitest-environment jsdom

/**
 * The top of a one-to-one conversation, the way Discord draws it: the call,
 * what is pinned, more people and who this is as a row of icons, and a search
 * box typed into where it is.
 *
 * And "add people" there makes a new group rather than growing the
 * conversation - the dialog sends the people to `groupFromDirectAction` and
 * goes to the group it answers.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { ChannelHeader } from "@/app/(app)/chat/channel-header";
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
    private: true,
    ownerId: null,
    topic: "",
    unreadCount: 0,
    mayModerate: false,
    mayInvite: false,
    mayPicture: false,
    mayAdminister: false,
    blocked: false,
    gameLinks: [],
    notifyLevel: "all",
    mutedUntil: null,
    others: [PERSON]
};

const pushed: string[] = [];
let groupCalls: unknown[] = [];
let groups = true;

vi.mock("@/app/(app)/chat/actions", () => ({
    groupFromDirectAction: async (input: unknown) => {
        groupCalls.push(input);
        return { id: "group-9" };
    },
    addChannelMembersAction: async () => ({}),
    searchPeopleAction: async () => [],
    searchGroupPeopleAction: async () => [{ id: "alan", name: "Alan Turing", available: true }],
    askFriendAction: async () => ({}),
    setMutedAction: async () => ({}),
    setChannelNotifyAction: async () => ({}),
    leaveChannelAction: async () => ({}),
    updateChannelAction: async () => ({}),
    deleteChannelAction: async () => ({}),
    renameGroupAction: async () => ({})
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: (to: string) => pushed.push(to), refresh: () => undefined })
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        viewerId: "ada",
        may: { call: true, groups, spaces: true, attach: true, meetings: true },
        callsOff: null,
        blocked: new Set<string>(),
        friends: new Set<string>(),
        channels: [CHANNEL],
        spaces: [],
        refresh: () => undefined
    })
}));

vi.mock("@/components/activity-card", () => ({ ActivityLine: () => null }));
vi.mock("@/app/(app)/chat/game-link-badge", () => ({ GameLinkChips: () => null }));
// The picker is its own component with its own tests; here it is a button that
// picks one person, so what is asserted is what the dialog does with them.
vi.mock("@/app/(app)/chat/chat-people-picker", () => ({
    ChatPeoplePicker: ({
        onChange,
        exclude
    }: {
        onChange: (people: { id: string; name: string }[]) => void;
        exclude: readonly string[];
    }) => (
        <button
            type="button"
            data-exclude={exclude.join(",")}
            onClick={() => onChange([{ id: "alan", name: "Alan Turing" }])}
        >
            pick alan
        </button>
    )
}));

function header(onSearch = vi.fn()) {
    render(
        <ChannelHeader
            channel={CHANNEL as never}
            viewerId="ada"
            onChanged={() => undefined}
            call={null}
            onStartCall={() => undefined}
            onSearch={onSearch}
            onPins={() => undefined}
            onMembers={() => undefined}
            membersOpen
        />,
        { wrapper: MessagesWrapper }
    );
    return onSearch;
}

beforeEach(() => {
    pushed.length = 0;
    groupCalls = [];
    groups = true;
});

afterEach(cleanup);

describe("the row of icons", () => {
    it("has the call, the video call, the pins, add people and the profile switch", () => {
        header();
        for (const name of [
            "Start a call",
            "Start a video call",
            "Pinned messages",
            "Add people",
            "Profile"
        ]) {
            expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
        }
        // The profile button reads as a switch that is on.
        expect(screen.getByRole("button", { name: "Profile" }).getAttribute("aria-pressed")).toBe(
            "true"
        );
    });

    it("draws add people refused, with the reason, to an account that cannot start groups", () => {
        groups = false;
        header();
        const add = screen.getByRole("button", { name: "Add people" }) as HTMLButtonElement;
        expect(add.disabled).toBe(true);
        expect(add.title).toBe("Your account cannot start groups");
    });
});

describe("the search box", () => {
    it("is labelled with who the conversation is with", () => {
        header();
        expect(screen.getByPlaceholderText("Search Grace Hopper")).toBeDefined();
    });

    it("opens the search with what was typed when Enter is pressed", async () => {
        const onSearch = header();
        await userEvent.type(screen.getByPlaceholderText("Search Grace Hopper"), "compiler{Enter}");
        expect(onSearch).toHaveBeenCalledWith("compiler");
    });
});

describe("adding people", () => {
    it("starts a new group from the conversation and goes to it", async () => {
        header();
        await userEvent.click(screen.getByRole("button", { name: "Add people" }));
        expect(await screen.findByText(/This conversation stays as it is/)).toBeDefined();
        // The two people already talking are not offered.
        expect(screen.getByText("pick alan").getAttribute("data-exclude")).toBe("grace");
        await userEvent.click(screen.getByText("pick alan"));
        await userEvent.click(screen.getByRole("button", { name: "Create group" }));
        await waitFor(() => expect(pushed).toEqual(["/chat/c/group-9"]));
        expect(groupCalls).toEqual([{ channelId: "d1", userIds: ["alan"] }]);
    });
});
