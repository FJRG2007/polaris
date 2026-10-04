// @vitest-environment jsdom

/**
 * Right-clicking your own row in a roster.
 *
 * Everything the menu offers about somebody else - messaging them, blocking
 * them, moderating them - is meaningless about yourself, so the menu came up
 * with a name in it and nothing else, which reads as broken. It offers what
 * does apply: your card, a mention of yourself, and editing how you appear.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonPressContext } from "@/components/person-press";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const pushed: string[] = [];

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: (to: string) => pushed.push(to) })
}));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({ spaces: [], blocked: new Set<string>(), friends: new Set<string>(), refresh: () => undefined })
}));
vi.mock("@/app/(app)/chat/actions", () => ({}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/components/report-person-dialog", () => ({ ReportPersonDialog: () => null }));

const { MemberMenu } = await import("@/app/(app)/chat/member-menu");

const channel = {
    id: "channel-1",
    kind: "group",
    spaceId: null,
    ownerId: "someone-else",
    others: []
} as never;

afterEach(() => {
    cleanup();
    pushed.length = 0;
});

function open(viewerId: string, onMention?: (text: string) => void) {
    const cards: string[] = [];
    render(
        <PersonPressContext.Provider value={(person) => cards.push(person.id)}>
            <MemberMenu
                member={{ userId: "me", name: "Ana" }}
                channel={channel}
                viewerId={viewerId}
                onMention={onMention}
                onNickname={() => undefined}
                onChanged={() => undefined}
                onError={() => undefined}
            >
                <button type="button">Ana row</button>
            </MemberMenu>
        </PersonPressContext.Provider>, { wrapper: MessagesWrapper }
    );
    fireEvent.contextMenu(screen.getByText("Ana row"));
    return cards;
}

describe("the menu on your own row", () => {
    it("offers your card, a mention and your profile", () => {
        const mentions: string[] = [];
        const cards = open("me", (text) => mentions.push(text));
        fireEvent.click(screen.getByText("Mention"));
        expect(mentions).toEqual(["[Ana](polaris:user/me)"]);

        fireEvent.contextMenu(screen.getByText("Ana row"));
        fireEvent.click(screen.getByText("Profile"));
        expect(cards).toEqual(["me"]);

        fireEvent.contextMenu(screen.getByText("Ana row"));
        fireEvent.click(screen.getByText("Edit your profile"));
        expect(pushed).toEqual(["/account"]);
    });

    it("offers nothing about reaching or moderating yourself", () => {
        open("me");
        expect(screen.queryByText("Message")).toBeNull();
        expect(screen.queryByText("Block")).toBeNull();
        expect(screen.queryByText("Change nickname")).toBeNull();
    });

    it("keeps Edit your profile off somebody else's row", () => {
        open("someone-else", () => undefined);
        expect(screen.getByText("Profile")).toBeTruthy();
        expect(screen.getByText("Message")).toBeTruthy();
        expect(screen.queryByText("Edit your profile")).toBeNull();
    });
});

describe("the menu opened without a right-click", () => {
    it("still offers the card when pressed, as a touch or a button opens it", () => {
        const cards: string[] = [];
        render(
            <PersonPressContext.Provider value={(person) => cards.push(person.id)}>
                <MemberMenu
                    member={{ userId: "me", name: "Ana" }}
                    channel={channel}
                    viewerId="someone-else"
                    openWith="press"
                    onNickname={() => undefined}
                    onChanged={() => undefined}
                    onError={() => undefined}
                >
                    <button type="button">Ana row</button>
                </MemberMenu>
            </PersonPressContext.Provider>, { wrapper: MessagesWrapper }
        );
        fireEvent.pointerDown(screen.getByText("Ana row"), {
            button: 0,
            ctrlKey: false,
            pointerType: "mouse"
        });
        fireEvent.click(screen.getByText("Profile"));
        expect(cards).toEqual(["me"]);
    });
});
