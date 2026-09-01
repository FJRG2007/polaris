// @vitest-environment jsdom

/**
 * The other person, beside the conversation.
 *
 * Two things this panel got wrong, both of them the same mistake: it drew a
 * person in a way no other screen in Polaris draws one.
 *
 * The dot belongs on the face. It is on the face in the roster, in the header,
 * beside every message; here it had been unpicked into a coloured circle on a
 * line of its own under the name, so the one screen devoted to somebody was the
 * one screen where you had to learn a second way of being told where they are.
 *
 * And everything you can do about somebody lived behind a right-click on a list
 * row. There is no list here - this screen is about one person - so message,
 * call, mention, nickname, silence, invite and block were all unreachable from
 * it. They are behind the three dots now, which is the same menu rather than a
 * second copy of it: what the menu offers is decided in one place, and a copy is
 * how the profile ends up missing the item somebody actually uses.
 */

import userEvent from "@testing-library/user-event";
import { DirectProfile } from "@/app/(app)/chat/direct-profile";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/app/(app)/chat/actions", () => ({
    profileAction: async () => ({
        profile: {
            name: "Grace Hopper",
            fullName: "Grace Hopper",
            username: "grace",
            description: "Compilers."
        }
    }),
    openDirectAction: async () => ({ id: "d1" }),
    addSpaceMembersAction: async () => ({}),
    transferGroupAction: async () => ({}),
    timeOutMemberAction: async () => ({}),
    removeSpaceMemberAction: async () => ({}),
    removeChannelMemberAction: async () => ({})
}));

vi.mock("@/app/(app)/account/privacy/actions", () => ({
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({
    reportPersonAction: async () => ({})
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        viewerId: "ada",
        blocked: new Set<string>(),
        spaces: [],
        channels: [CHANNEL],
        refresh: () => undefined
    })
}));

/** Where they are, as the presence store would answer for them. */
let presence: { status: string; note: string | null } | null = {
    status: "idle",
    note: "Reading the manual"
};
vi.mock("@/components/presence-store", () => ({
    usePresence: () => presence
}));

// The panel decides between a column and a dialog with this; the column is the
// shape being tested and jsdom has no width to answer with.
vi.mock("@/app/(app)/chat/use-wide-screen", () => ({ useWideScreen: () => true }));

function panel() {
    return render(
        <DirectProfile
            person={PERSON}
            channel={CHANNEL as never}
            open
            onOpenChange={() => undefined}
            onMention={() => undefined}
        />
    );
}

beforeEach(() => {
    presence = { status: "idle", note: "Reading the manual" };
});

afterEach(cleanup);

describe("how the person is drawn", () => {
    it("puts the dot on the face, the way every other screen does", async () => {
        const { container } = panel();
        // The face carries it: the avatar renders the status marker itself, and
        // the panel no longer draws a circle of its own beside the word.
        expect((await screen.findAllByTitle("Away")).length).toBeGreaterThan(0);
        expect(container.querySelectorAll("[aria-hidden='true'].rounded-full")).toHaveLength(0);
    });

    it("says the name, then the handle, then what they are showing", async () => {
        panel();
        expect(await screen.findByText("Grace Hopper")).toBeDefined();
        expect(screen.getByText("grace")).toBeDefined();
        expect(screen.getByText("Reading the manual")).toBeDefined();
    });

    it("does not spell out where they are underneath the face that already says it", async () => {
        // The dot carries it, in the colour it carries it in everywhere else, and
        // a line of the panel saying "Away" underneath is the same fact twice.
        // It survives where a colour cannot be read - the dot's own label and
        // tooltip - and nowhere else, which is what the count below asserts.
        panel();
        await screen.findByText("Grace Hopper");
        expect(screen.queryAllByText("Away")).toHaveLength(0);
        expect((await screen.findAllByTitle("Away")).length).toBeGreaterThan(0);
    });

    it("draws the band across the top, whether or not they uploaded one", async () => {
        const { container } = panel();
        await screen.findByText("Grace Hopper");
        // The picture is simply laid over the colour: an account with no banner
        // is answered with a transparent pixel, so nothing here has to ask which
        // case it is in first.
        const band = container.querySelector<HTMLElement>("img[src='/api/banner/grace']");
        expect(band).not.toBeNull();
        expect(band?.parentElement?.style.background).not.toBe("");
    });

    it("does not say their name twice when it is also what they are called", async () => {
        panel();
        expect(await screen.findAllByText("Grace Hopper")).toHaveLength(1);
    });

    it("draws nothing about where they are when nothing is known", async () => {
        presence = null;
        panel();
        expect(await screen.findByText("Grace Hopper")).toBeDefined();
        expect(screen.queryByText("Reading the manual")).toBeNull();
        expect(screen.queryAllByText("Away")).toHaveLength(0);
    });
});

describe("the three dots", () => {
    it("carry the menu a name carries everywhere else", async () => {
        const user = userEvent.setup();
        panel();
        await user.click(
            await screen.findByRole("button", { name: "What you can do about Grace Hopper" })
        );
        const menu = await screen.findByRole("menu");
        for (const item of ["Message", "Call", "Mention", "Change nickname", "Block"]) {
            expect(within(menu).getByText(item)).toBeDefined();
        }
    });

    it("draw the one that shuts somebody out in the colour that means that", async () => {
        const user = userEvent.setup();
        panel();
        await user.click(
            await screen.findByRole("button", { name: "What you can do about Grace Hopper" })
        );
        const menu = await screen.findByRole("menu");
        // Through the menu's own danger variant rather than a colour painted on
        // the label, so the row highlights in it too - which is what makes it
        // read as heavy with the pointer on it.
        const block = within(menu).getByText("Block").closest("[role='menuitem']");
        expect(block?.className).toContain("text-danger");
        const message = within(menu).getByText("Message").closest("[role='menuitem']");
        expect(message?.className).not.toContain("text-danger");
    });
});
