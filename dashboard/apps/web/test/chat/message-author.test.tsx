// @vitest-environment jsdom

/**
 * The writer's name, in the middle of what they wrote.
 *
 * It used to be a label, which left the roster as the only place to reach
 * anything about a person - a column somebody has to open first, and in a busy
 * channel the person worth muting is the one on screen rather than the one being
 * scrolled to in a list of two hundred. So the name is pressable now, and the
 * right-click on it asks about the person rather than about the message.
 *
 * Your own name is left as a label. Everything the menu offers reads oddly aimed
 * at yourself, and there is no conversation to open with you.
 */

import userEvent from "@testing-library/user-event";
import { MessageList } from "@/app/(app)/chat/message-list";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const opened: string[][] = [];

vi.mock("@/app/(app)/chat/actions", () => ({
    saveMediaAction: async () => ({}),
    unsaveMediaAction: async () => ({}),
    linkPreviewAction: async () => ({}),
    openDirectAction: async ({ userIds }: { userIds: string[] }) => {
        opened.push(userIds);
        return { id: "d1" };
    }
}));

vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({
    reportPersonAction: async () => ({})
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        blocked: new Set<string>(),
        refresh: () => undefined,
        channels: [
            {
                id: "c1",
                spaceId: null,
                categoryId: null,
                kind: "group",
                name: "A room",
                archived: false,
                ownerId: null,
                others: []
            }
        ],
        spaces: [],
        refresh: () => undefined
    })
}));

const pushed: string[] = [];
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: (to: string) => pushed.push(to), refresh: () => undefined })
}));

function message(id: string, authorId: string) {
    return {
        id,
        channelId: "c1",
        authorId,
        authorName: authorId,
        kind: "text" as const,
        body: `message ${id}`,
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

function list() {
    return render(
        <MessageList
            messages={[message("m1", "grace"), message("m2", "ada")]}
            viewerId="ada"
            canPost
            canModerate={false}
            onReact={() => undefined}
            onStar={() => undefined}
            onDelete={() => undefined}
        />
    );
}

afterEach(cleanup);

describe("somebody else's name", () => {
    it("is pressable", () => {
        list();
        expect(screen.getByRole("button", { name: "grace" })).toBeDefined();
    });

    it("opens the conversation with them, which is what pressing a name does in the roster", async () => {
        const user = userEvent.setup();
        list();
        opened.length = 0;
        pushed.length = 0;
        await user.click(screen.getByRole("button", { name: "grace" }));
        expect(opened).toEqual([["grace"]]);
        expect(pushed).toEqual(["/chat/c/d1"]);
    });
});

describe("right-clicking somebody's name", () => {
    it("asks about the person, not about the message under it", async () => {
        // The name sits inside the message's own context menu, so two menus are
        // listening for the same right-click and only one of them is about a
        // person. This pins which one answers.
        //
        // It does not discriminate the fix that makes the inner menu stop the
        // event: jsdom resolves the nesting the right way on its own, and it
        // passed before that was added. What it does catch is the name losing
        // its menu altogether, which is the way this actually breaks.
        const user = userEvent.setup();
        list();
        await user.pointer({ target: screen.getByRole("button", { name: "grace" }), keys: "[MouseRight]" });

        expect(screen.queryByText("Report this account")).not.toBeNull();
        // And the message menu is not the one that opened. Told apart by the item
        // only its menu has: both now offer reporting the account, which is the
        // point of the change that put it on the message menu as well.
        expect(screen.queryByText("Report this message")).toBeNull();
    });
});

describe("right-clicking the message itself", () => {
    it("offers both reports, because the account is the more common one", async () => {
        // A single message is rarely the problem by itself: somebody who has
        // decided to report is usually reporting a person. That was only on the
        // name's own menu - a smaller target, and absent entirely on a run of
        // messages from the same person, which is most of a conversation.
        const user = userEvent.setup();
        list();
        await user.pointer({ target: screen.getByText("message m1"), keys: "[MouseRight]" });

        expect(screen.queryByText("Report this message")).not.toBeNull();
        expect(screen.queryByText("Report this account")).not.toBeNull();
    });

    it("draws both as consequences rather than as one", async () => {
        // Red on both. One of them reading like Copy is how a menu stops saying
        // which of its items are heavy - which is what this looked like when the
        // account report was red on one menu and the message report was not.
        const user = userEvent.setup();
        list();
        await user.pointer({ target: screen.getByText("message m1"), keys: "[MouseRight]" });

        for (const label of ["Report this message", "Report this account"]) {
            const item = screen.getByText(label).closest("[role='menuitem']");
            expect(item?.className).toContain("text-danger");
        }
    });
});

describe("your own name", () => {
    it("is not pressable, because none of it is aimed at yourself", () => {
        list();
        expect(screen.queryByRole("button", { name: "ada" })).toBeNull();
        expect(screen.getByText("ada")).toBeDefined();
    });
});
