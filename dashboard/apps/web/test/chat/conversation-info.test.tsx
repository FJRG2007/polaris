// @vitest-environment jsdom

/**
 * A conversation's info, WhatsApp's "contact info": one row per setting with its
 * value on the right, a chooser that takes the page's place for a setting with
 * several answers, the switches drawn before the server answers and put back
 * with a note when it refuses, and what cannot be undone last, in red, only
 * where the reader may do it.
 *
 * On a computer the same page opens beside the chat from the header.
 */

import { useState } from "react";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { ChannelHeader } from "@/app/(app)/chat/channel-header";
import { ConversationInfo } from "@/app/(app)/chat/conversation-info";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

const PERSON = { id: "grace", name: "Grace Hopper" };

const DIRECT = {
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
    pinned: false,
    muted: false,
    muteMentions: false,
    gameLinks: [],
    notifyLevel: "all",
    mutedUntil: null,
    others: [PERSON]
};

const GROUP = {
    ...DIRECT,
    id: "g1",
    name: "Compilers",
    kind: "group",
    ownerId: "grace",
    others: [PERSON, { id: "alan", name: "Alan Turing" }]
};

const patches: { id: string; patch: Record<string, unknown> }[] = [];
const undone: string[] = [];
const shown: { title: string; body?: string }[] = [];
let muteCalls: unknown[][] = [];
let muteAnswer: { error?: string } = {};
let mediaPages: unknown[] = [];
let mediaAnswer: { items: unknown[]; next: string | null } = { items: [], next: null };

vi.mock("@/app/(app)/chat/actions", () => ({
    setMutedAction: async (...args: unknown[]) => {
        muteCalls.push(args);
        return muteAnswer;
    },
    setMuteMentionsAction: async () => ({}),
    setChannelNotifyAction: async () => ({}),
    setPinnedAction: async () => ({}),
    groupFromDirectAction: async () => ({ id: "group-9" }),
    addChannelMembersAction: async () => ({}),
    searchPeopleAction: async () => [],
    searchGroupPeopleAction: async () => [],
    askFriendAction: async () => ({}),
    leaveChannelAction: async () => ({}),
    updateChannelAction: async () => ({}),
    deleteChannelAction: async () => ({}),
    renameGroupAction: async () => ({}),
    listSharedMediaAction: async (input: unknown) => {
        mediaPages.push(input);
        return mediaAnswer;
    }
}));

vi.mock("@/app/(app)/account/privacy/actions", () => ({
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));

vi.mock("@polaris/ui", async (original) => ({
    ...(await original<typeof import("@polaris/ui")>()),
    useToast: () => ({
        show: (toast: { title: string; body?: string }) => shown.push(toast),
        dismiss: () => undefined
    })
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        viewerId: "ada",
        viewerName: "Ada Lovelace",
        may: { call: true, groups: true, spaces: true, attach: true, meetings: true },
        callsOff: null,
        callsOutside: null,
        blocked: new Set<string>(),
        friends: new Set<string>(),
        channels: [DIRECT],
        spaces: [],
        refresh: () => undefined,
        // The list's optimistic write: what was drawn, the call, and what was
        // taken back on a refusal (the list itself is covered on its own).
        change: async (
            drawn: Record<string, Record<string, unknown>>,
            call: () => Promise<{ error?: string }>
        ) => {
            for (const [id, patch] of Object.entries(drawn)) patches.push({ id, patch });
            const result = await call();
            if (!result?.error) return null;
            undone.push(...Object.keys(drawn));
            return result.error;
        }
    })
}));

vi.mock("@/components/activity-card", () => ({ ActivityLine: () => null }));
vi.mock("@/app/(app)/chat/report-dialog", () => ({ ReportDialog: () => null }));
vi.mock("@/app/(app)/chat/game-link-badge", () => ({ GameLinkChips: () => null }));

function info(channel: typeof DIRECT, entries: Record<string, unknown> = {}) {
    render(
        <ConversationInfo
            channel={channel as never}
            open
            onOpenChange={() => undefined}
            layout="panel"
            entries={entries}
        />,
        { wrapper: MessagesWrapper }
    );
}

beforeEach(() => {
    patches.length = 0;
    undone.length = 0;
    shown.length = 0;
    muteCalls = [];
    muteAnswer = {};
    mediaPages = [];
    mediaAnswer = { items: [], next: null };
});

afterEach(cleanup);

describe("the mute", () => {
    it("is one row with its value, and the durations are not rows of the page", () => {
        info(DIRECT);
        const row = screen.getByRole("button", { name: /Mute notifications/ });
        expect(row.textContent).toContain("Off");
        expect(screen.queryByText("For 8 hours")).toBeNull();
        expect(screen.queryByText("Until I turn it back on")).toBeNull();
        expect(screen.queryByRole("radio")).toBeNull();
    });

    it("opens a chooser in the page's place and applies the choice at once", async () => {
        info(DIRECT);
        await userEvent.click(screen.getByRole("button", { name: /Mute notifications/ }));

        const choices = screen.getByRole("radiogroup", { name: "Mute notifications" });
        expect(within(choices).getByRole("radio", { name: "Off" }).getAttribute("aria-checked")).toBe("true");
        // The page itself is gone while choosing: no second window over it.
        expect(screen.queryByRole("button", { name: /Mute notifications/ })).toBeNull();
        expect(screen.getByRole("switch", { name: "Mute mentions too" })).toBeTruthy();

        await userEvent.click(within(choices).getByRole("radio", { name: "For 8 hours" }));

        expect(patches[0]?.patch.muted).toBe(true);
        expect(typeof patches[0]?.patch.mutedUntil).toBe("string");
        await waitFor(() => expect(muteCalls).toEqual([["d1", 480]]));
        // Back on the page.
        expect(screen.getByRole("button", { name: /Mute notifications/ })).toBeTruthy();
    });

    it("puts the mute back and says so when the server refuses", async () => {
        muteAnswer = { error: "Not now" };
        info(DIRECT);
        await userEvent.click(screen.getByRole("button", { name: /Mute notifications/ }));
        await userEvent.click(screen.getByRole("radio", { name: "Until I turn it back on" }));

        await waitFor(() => expect(undone).toEqual(["d1"]));
        expect(patches[0]?.patch).toEqual({ muted: true, mutedUntil: null });
        expect(shown[0]?.body).toBe("Not now");
    });

    it("reads Always for a mute with no end", () => {
        info({ ...DIRECT, muted: true, mutedUntil: null });
        expect(screen.getByRole("button", { name: /Mute notifications/ }).textContent).toContain("Always");
    });
});

describe("the rest of the settings", () => {
    it("draws a pin switch at once", async () => {
        info(DIRECT);
        await userEvent.click(screen.getByRole("switch", { name: "Pin chat" }));
        expect(patches[0]?.patch).toEqual({ pinned: true });
    });

    it("offers what may interrupt as one row in a group, not in a direct message", async () => {
        info(DIRECT);
        expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
        cleanup();
        info(GROUP);
        await userEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
        await userEvent.click(screen.getByRole("radio", { name: "Only mentions" }));
        expect(patches[0]?.patch).toEqual({ notifyLevel: "mentions" });
    });
});

describe("what cannot be undone", () => {
    it("comes last, in red", () => {
        info(DIRECT, { onReport: () => undefined, onDeleteChat: () => undefined });
        const sections = document.querySelectorAll("section[class*='border-t']");
        const last = sections[sections.length - 1] as HTMLElement;
        expect(last.dataset.infoGroup).toBe("danger");
        const rows = within(last).getAllByRole("button").map((row) => row.textContent);
        expect(rows).toEqual(["Block Grace Hopper", "Report conversation", "Delete chat"]);
        for (const row of within(last).getAllByRole("button")) expect(row.dataset.danger).toBe("true");
    });

    it("offers only what the reader may do", () => {
        // A group member who does not run it: leaving, not deleting, and no
        // block, which is about one person.
        info(GROUP, { onLeave: () => undefined });
        expect(screen.getByRole("button", { name: "Leave this group" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /^Block/ })).toBeNull();
        expect(screen.queryByRole("button", { name: "Delete channel" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Delete chat" })).toBeNull();
    });

    it("never offers to block yourself", () => {
        info({ ...DIRECT, others: [{ id: "ada", name: "Ada Lovelace" }], name: "Ada Lovelace" });
        expect(screen.queryByRole("button", { name: /^Block/ })).toBeNull();
    });
});

const RULES = {
    mode: "agreement",
    mayChange: true,
    proposes: true,
    vanishAfter: 0,
    deleteForAll: false,
    linkPreviews: true,
    receipts: "on",
    typing: "on",
    proposal: null
};

function tile(id: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        messageId: `m-${id}`,
        forwardable: true,
        name: `${id}.jpg`,
        video: false,
        durationMs: null,
        hasPoster: false,
        thumbhash: null,
        sentAt: "2026-11-02T10:00:00.000Z",
        ...extra
    };
}

describe("what was shared", () => {
    it("draws the pictures and videos as square tiles, a video marked with its length", async () => {
        mediaAnswer = {
            items: [tile("a"), tile("b", { video: true, durationMs: 75_000, hasPoster: true })],
            next: null
        };
        info(DIRECT);
        const picture = await screen.findByRole("button", { name: "a.jpg" });
        expect(picture.className).toContain("aspect-square");
        expect(picture.querySelector("img")?.getAttribute("loading")).toBe("lazy");
        expect(picture.querySelector("img")?.className).toContain("object-cover");
        const video = screen.getByRole("button", { name: /b\.jpg/ });
        expect(video.querySelector("img")?.getAttribute("src")).toContain("?poster=1");
        expect(video.textContent).toMatch(/1:15/);
        expect(mediaPages).toEqual([{ channelId: "d1", before: null }]);
    });

    it("leaves the section out when nothing was shared", async () => {
        info(DIRECT);
        await waitFor(() => expect(mediaPages).toHaveLength(1));
        expect(screen.queryByText("Photos and videos")).toBeNull();
    });

    it("opens the whole gallery in the page's place, under a heading per month", async () => {
        mediaAnswer = { items: [tile("a")], next: null };
        info(DIRECT);
        await userEvent.click(await screen.findByRole("button", { name: "See all" }));
        expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
        expect(screen.getByText(/November 2026/i)).toBeTruthy();
        expect(screen.getByRole("button", { name: "a.jpg" })).toBeTruthy();
    });
});

describe("the conversation's rules", () => {
    it("turns link previews off from a switch on the page", async () => {
        const previews: boolean[] = [];
        info(DIRECT, {
            vanish: { rules: RULES, onTimer: () => undefined, onLinkPreviews: (on: boolean) => previews.push(on) }
        });
        const toggle = screen.getByRole("switch", { name: "Link previews" });
        await userEvent.click(toggle);
        expect(previews).toEqual([false]);
    });

    it("offers deleting for everybody beside the timer, where it is agreed", async () => {
        const allowed: boolean[] = [];
        info(DIRECT, {
            vanish: { rules: RULES, onTimer: () => undefined, onAllowDelete: (on: boolean) => allowed.push(on) }
        });
        await userEvent.click(screen.getByRole("button", { name: /Disappearing messages/ }));
        await userEvent.click(screen.getByRole("switch", { name: "Allow deleting the chat for everyone" }));
        expect(allowed).toEqual([true]);
    });
});

describe("on a computer", () => {
    function Conversation() {
        const [open, setOpen] = useState(false);
        const [slot, setSlot] = useState<HTMLElement | null>(null);
        return (
            <div>
                <ChannelHeader
                    channel={DIRECT as never}
                    viewerId="ada"
                    onChanged={() => undefined}
                    call={null}
                    onStartCall={() => undefined}
                    onSearch={() => undefined}
                    onMembers={() => undefined}
                    info={{ open, onOpenChange: setOpen, slot }}
                />
                {open ? <div data-testid="side" ref={setSlot} /> : null}
            </div>
        );
    }

    it("opens the info beside the chat from the name at the top, and closes it", async () => {
        render(<Conversation />, { wrapper: MessagesWrapper });
        expect(screen.queryByTestId("side")).toBeNull();

        await userEvent.click(screen.getByRole("button", { name: "Info for Grace Hopper" }));

        const side = await screen.findByTestId("side");
        await waitFor(() => expect(side.querySelector("[data-info-layout='panel']")).not.toBeNull());
        expect(within(side).getByRole("button", { name: /Mute notifications/ })).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();

        await userEvent.click(within(side).getByRole("button", { name: "Close details" }));
        expect(screen.queryByTestId("side")).toBeNull();
    });

    it("opens the details from the conversation's menu, which holds none of its rules", async () => {
        render(<Conversation />, { wrapper: MessagesWrapper });
        await userEvent.click(screen.getByRole("button", { name: "More for this conversation" }));
        const menu = await screen.findByRole("menu");
        expect(within(menu).queryByText("Read receipts")).toBeNull();
        expect(within(menu).queryByText("Delete chat")).toBeNull();
        await userEvent.click(within(menu).getByRole("menuitem", { name: "Details" }));
        const side = await screen.findByTestId("side");
        await waitFor(() => expect(side.querySelector("[data-info-layout='panel']")).not.toBeNull());
    });
});
