// @vitest-environment jsdom

/**
 * Pressing somebody opens a card about them.
 *
 * One card, whatever was pressed: the name on a message, the face beside it, an
 * @mention of them, their row in the roster. It shows what the server decided
 * this reader may be told and nothing else, it expands into a larger view, and
 * from there to their own page. Messaging them is a button on the card now,
 * where pressing a name used to go straight to the conversation.
 *
 * Outside the chat - a task's comments - nothing provides the card, and a
 * mention stays the label it always was rather than a button that goes nowhere.
 */

import userEvent from "@testing-library/user-event";
import { RichText } from "@/components/rich-text/rich-text";
import { MessageList } from "@/app/(app)/chat/message-list";
import { ChannelMembers } from "@/app/(app)/chat/members-panel";
import { PersonCardProvider } from "@/app/(app)/chat/person-card";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

const GRACE = "0193aaaa-0000-7000-8000-000000000001";
const ADA = "0193aaaa-0000-7000-8000-000000000002";

const CHANNEL = {
    id: "c1",
    spaceId: "s1",
    categoryId: null,
    kind: "text",
    name: "general",
    archived: false,
    ownerId: null,
    unread: 0,
    mayModerate: false,
    others: []
};

/** What the server answers for each person - already cut down to what this
 *  reader may see, which is the server's decision and not the card's. */
let profiles: Record<string, unknown> = {};
const opened: string[][] = [];
const pushed: string[] = [];

vi.mock("@/app/(app)/chat/actions", () => ({
    profileAction: async (_channelId: string, userId: string) => ({ profile: profiles[userId] }),
    openDirectAction: async ({ userIds }: { userIds: string[] }) => {
        opened.push(userIds);
        return { id: "d1" };
    },
    membersAction: async () => ({
        members: [
            { userId: GRACE, name: "Grace Hopper", role: "owner" },
            { userId: ADA, name: "Ada", role: "member" }
        ]
    }),
    listMembersAction: async () => ({
        members: [
            { userId: GRACE, name: "Grace Hopper", role: "owner" },
            { userId: ADA, name: "Ada", role: "member" }
        ]
    }),
    saveMediaAction: async () => ({}),
    unsaveMediaAction: async () => ({}),
    linkPreviewAction: async () => ({}),
    addSpaceMembersAction: async () => ({}),
    transferGroupAction: async () => ({}),
    timeOutMemberAction: async () => ({}),
    removeSpaceMemberAction: async () => ({}),
    removeChannelMemberAction: async () => ({})
}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({
    reportPersonAction: async () => ({})
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: (to: string) => pushed.push(to), refresh: () => undefined })
}));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        viewerId: ADA,
        blocked: new Set<string>(),
        spaces: [],
        channels: [CHANNEL],
        refresh: () => undefined
    })
}));
vi.mock("@/components/presence-store", () => ({
    usePresence: () => ({ status: "online", note: "Writing a compiler" })
}));
vi.mock("@/app/(app)/chat/use-wide-screen", () => ({ useWideScreen: () => true }));

/** The roster follows the conversation's live stream, which jsdom does not have. */
class QuietStream {
    addEventListener() {}
    removeEventListener() {}
    close() {}
}
vi.stubGlobal("EventSource", QuietStream);

beforeEach(() => {
    opened.length = 0;
    pushed.length = 0;
    profiles = {
        [GRACE]: {
            name: "Grace Hopper",
            fullName: "",
            username: "grace",
            description: "Compilers.",
            headline: "Rear admiral",
            pronouns: "she/her",
            mutual: { friends: { people: [], total: 0 }, spaces: { spaces: [], total: 0 } },
            role: "owner"
        },
        [ADA]: {
            name: "Ada",
            fullName: "Ada Lovelace",
            username: "ada",
            description: "",
            headline: "",
            pronouns: "",
            mutual: { friends: { people: [], total: 0 }, spaces: { spaces: [], total: 0 } },
            role: null
        }
    };
});
afterEach(cleanup);

function message(id: string, authorId: string, authorName: string, body = `message ${id}`) {
    return {
        id,
        channelId: "c1",
        authorId,
        authorName,
        kind: "text" as const,
        body,
        parentId: null,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [],
        quote: null,
        starred: false,
        references: [],
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000).toISOString()
    };
}

function conversation(body?: string) {
    return render(
        <PersonCardProvider channelId="c1" viewerId={ADA}>
            <MessageList
                messages={[message("m1", GRACE, "Grace Hopper", body), message("m2", ADA, "Ada")]}
                viewerId={ADA}
                canPost
                canModerate={false}
                onReact={() => undefined}
                onStar={() => undefined}
                onDelete={() => undefined}
            />
        </PersonCardProvider>
    );
}

async function openCard(): Promise<HTMLElement> {
    return screen.findByRole("dialog");
}

describe("pressing a name on a message", () => {
    it("opens their card rather than going straight to a conversation", async () => {
        const user = userEvent.setup();
        conversation();
        await user.click(screen.getByRole("button", { name: "Grace Hopper" }));

        const card = await openCard();
        expect(await within(card).findByText("grace")).toBeDefined();
        expect(within(card).getByText("she/her")).toBeDefined();
        expect(within(card).getByText("Rear admiral")).toBeDefined();
        expect(within(card).getByText("Compilers.")).toBeDefined();
        expect(within(card).getByText("Writing a compiler")).toBeDefined();
        // What they are in this space, in words.
        expect(within(card).getByText("Space owner")).toBeDefined();
        expect(opened).toEqual([]);
    });

    it("messages them from the card", async () => {
        const user = userEvent.setup();
        conversation();
        await user.click(screen.getByRole("button", { name: "Grace Hopper" }));
        const card = await openCard();
        await user.click(within(card).getByRole("button", { name: /Message/ }));
        await waitFor(() => expect(opened).toEqual([[GRACE]]));
        expect(pushed).toEqual(["/chat/c/d1"]);
    });

    it("draws nothing for what the server did not hand over", async () => {
        // The name on the account came back empty - their setting, not this
        // card's - so there is no line for it at all.
        const user = userEvent.setup();
        conversation();
        await user.click(screen.getByRole("button", { name: "Grace Hopper" }));
        const card = await openCard();
        await within(card).findByText("grace");
        expect(within(card).queryByText("Grace Hopper", { selector: "p.truncate" })).toBeNull();
    });

    it("opens from the face as well as the name", async () => {
        const user = userEvent.setup();
        conversation();
        await user.click(screen.getByRole("button", { name: "View Grace Hopper's profile" }));
        const card = await openCard();
        expect(await within(card).findByText("grace")).toBeDefined();
    });

    it("opens your own, with the way to change it instead of a way to message yourself", async () => {
        const user = userEvent.setup();
        conversation();
        await user.click(screen.getByRole("button", { name: "Ada" }));
        const card = await openCard();
        expect(await within(card).findByText("Ada Lovelace")).toBeDefined();
        expect(within(card).getByRole("link", { name: /Edit profile/ }).getAttribute("href")).toBe("/account");
        expect(within(card).queryByRole("button", { name: /^Message$/ })).toBeNull();
    });
});

describe("the larger view", () => {
    it("expands from the card and leads to their own page", async () => {
        const user = userEvent.setup();
        conversation();
        await user.click(screen.getByRole("button", { name: "Grace Hopper" }));
        const card = await openCard();
        await user.click(within(card).getByRole("button", { name: "View full profile" }));

        const link = await screen.findByRole("link", { name: /Open profile page/ });
        expect(link.getAttribute("href")).toBe("/u/grace");
    });

    it("offers no page for somebody without an address", async () => {
        (profiles[GRACE] as { username: string }).username = "";
        const user = userEvent.setup();
        conversation();
        await user.click(screen.getByRole("button", { name: "Grace Hopper" }));
        const card = await openCard();
        await user.click(within(card).getByRole("button", { name: "View full profile" }));
        await screen.findByText("Compilers.");
        expect(screen.queryByRole("link", { name: /Open profile page/ })).toBeNull();
    });
});

describe("a mention", () => {
    it("opens the same card in the chat", async () => {
        const user = userEvent.setup();
        conversation(`ask [@Grace Hopper](polaris:user/${GRACE}) about it`);
        await user.click(screen.getByRole("button", { name: "@Grace Hopper" }));
        const card = await openCard();
        expect(await within(card).findByText("grace")).toBeDefined();
    });

    it("stays a label where nothing opens a card, as under a task", () => {
        render(<RichText value={`ask [@Grace Hopper](polaris:user/${GRACE}) about it`} />);
        expect(screen.queryByRole("button", { name: "@Grace Hopper" })).toBeNull();
        expect(screen.getByText("@Grace Hopper")).toBeDefined();
    });
});

describe("the roster", () => {
    it("opens the card for the person pressed", async () => {
        const user = userEvent.setup();
        render(
            <ChannelMembers
                channel={CHANNEL as never}
                open
                onOpenChange={() => undefined}
                onMention={() => undefined}
            />
        );
        await user.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
        const card = await openCard();
        expect(await within(card).findByText("grace")).toBeDefined();
        expect(opened).toEqual([]);
    });
});
