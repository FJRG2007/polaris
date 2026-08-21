// @vitest-environment jsdom

/**
 * The card under the question.
 *
 * What is being protected here is the press. A poll is the one thing in a
 * conversation where somebody acts on what they see rather than reads it, so the
 * card has to move the moment it is pressed, has to send the whole selection
 * rather than the answer that changed, and must never show a number a hidden
 * poll has not released.
 *
 * The optimistic move is the part with no server behind it: if the guess is
 * wrong, the bars are wrong for the second before the real count lands, and
 * nobody watching would know which of the two they were reading.
 */

import userEvent from "@testing-library/user-event";
import type { ChatPollView } from "@/lib/chat/polls";
import { PollCard } from "@/app/(app)/chat/poll-card";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const sent: { messageId: string; optionIds: string[] }[] = [];
const ended: string[] = [];
let refuse: string | null = null;

vi.mock("@/app/(app)/chat/actions", () => ({
    votePollAction: async (input: { messageId: string; optionIds: string[] }) => {
        sent.push(input);
        return refuse ? { error: refuse } : {};
    },
    endPollAction: async (messageId: string) => {
        ended.push(messageId);
        return {};
    },
    pollAction: async () => ({ poll: null })
}));

// The live wire is a device-wide connection. Nothing here is testing it, and a
// card that opened one would be a test holding a socket.
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));

function poll(over: Partial<ChatPollView> = {}): ChatPollView {
    return {
        multiple: false,
        hideResults: false,
        closed: false,
        closesAt: null,
        endedEarly: false,
        results: true,
        voters: 0,
        voted: false,
        options: [
            { id: "o1", text: "Pizza", votes: 0, mine: false },
            { id: "o2", text: "Sushi", votes: 0, mine: false }
        ],
        ...over
    };
}

function card(view: ChatPollView, options: { canPost?: boolean; canEnd?: boolean } = {}) {
    const message = {
        id: "m1",
        channelId: "c1",
        deleted: false
    } as never;
    return render(
        <PollCard
            message={message}
            poll={view}
            canPost={options.canPost ?? true}
            canEnd={options.canEnd ?? false}
            onError={() => undefined}
        />
    );
}

afterEach(() => {
    cleanup();
    sent.length = 0;
    ended.length = 0;
    refuse = null;
});

describe("pressing an answer", () => {
    it("sends it and moves the bar without waiting", async () => {
        const user = userEvent.setup();
        card(poll());
        await user.click(screen.getByRole("button", { name: /Pizza/ }));

        expect(sent).toEqual([{ messageId: "m1", optionIds: ["o1"] }]);
        expect(screen.getByRole("button", { name: /Pizza/ }).textContent).toContain("100%");
        expect(screen.getByText("1 vote")).toBeDefined();
    });

    it("replaces the answer rather than adding to it when only one may be picked", async () => {
        const user = userEvent.setup();
        card(poll());
        await user.click(screen.getByRole("button", { name: /Pizza/ }));
        await user.click(screen.getByRole("button", { name: /Sushi/ }));

        expect(sent.map((entry) => entry.optionIds)).toEqual([["o1"], ["o2"]]);
        expect(screen.getByRole("button", { name: /Pizza/ }).getAttribute("aria-pressed")).toBe(
            "false"
        );
        expect(screen.getByRole("button", { name: /Sushi/ }).getAttribute("aria-pressed")).toBe(
            "true"
        );
        // Still one person, not two: the vote moved rather than stacking.
        expect(screen.getByText("1 vote")).toBeDefined();
    });

    it("sends the whole selection when several may be picked", async () => {
        const user = userEvent.setup();
        card(poll({ multiple: true }));
        await user.click(screen.getByRole("button", { name: /Pizza/ }));
        await user.click(screen.getByRole("button", { name: /Sushi/ }));

        expect(sent.map((entry) => entry.optionIds)).toEqual([["o1"], ["o1", "o2"]]);
    });

    it("takes the vote back when the same answer is pressed again", async () => {
        const user = userEvent.setup();
        card(poll({ voted: true, voters: 1, options: [
            { id: "o1", text: "Pizza", votes: 1, mine: true },
            { id: "o2", text: "Sushi", votes: 0, mine: false }
        ] }));
        await user.click(screen.getByRole("button", { name: /Pizza/ }));

        expect(sent).toEqual([{ messageId: "m1", optionIds: [] }]);
        expect(screen.getByText("0 votes")).toBeDefined();
    });

    it("puts the card back when the server refuses", async () => {
        const user = userEvent.setup();
        refuse = "That poll has closed";
        card(poll());
        await user.click(screen.getByRole("button", { name: /Pizza/ }));

        expect(screen.getByRole("button", { name: /Pizza/ }).getAttribute("aria-pressed")).toBe(
            "false"
        );
        expect(screen.getByText("0 votes")).toBeDefined();
    });
});

describe("a poll nobody may answer", () => {
    it("takes no press once it has closed", async () => {
        const user = userEvent.setup();
        card(poll({ closed: true }));
        await user.click(screen.getByRole("button", { name: /Pizza/ }));
        expect(sent).toEqual([]);
        expect(screen.getByText("Poll closed")).toBeDefined();
    });

    it("takes no press in a room this reader may only read", async () => {
        const user = userEvent.setup();
        card(poll(), { canPost: false });
        await user.click(screen.getByRole("button", { name: /Pizza/ }));
        expect(sent).toEqual([]);
    });
});

describe("a poll that hides its results", () => {
    it("shows no counts at all while it runs, and says why", () => {
        card(poll({ hideResults: true, results: false, voters: 3 }));
        expect(screen.getByRole("button", { name: /Pizza/ }).textContent).not.toContain("%");
        expect(screen.getByText("Results show when it closes")).toBeDefined();
        // How many took part is not what any of them chose.
        expect(screen.getByText("3 votes")).toBeDefined();
    });

    it("still shows this reader their own answer", () => {
        card(
            poll({
                hideResults: true,
                results: false,
                voted: true,
                voters: 1,
                options: [
                    { id: "o1", text: "Pizza", votes: 0, mine: true },
                    { id: "o2", text: "Sushi", votes: 0, mine: false }
                ]
            })
        );
        expect(screen.getByRole("button", { name: /Pizza/ }).getAttribute("aria-pressed")).toBe(
            "true"
        );
    });
});

describe("ending it", () => {
    it("is offered to whoever may, and only while it is running", () => {
        card(poll(), { canEnd: true });
        expect(screen.getByRole("button", { name: /End poll/ })).toBeDefined();

        cleanup();
        card(poll({ closed: true }), { canEnd: true });
        expect(screen.queryByRole("button", { name: /End poll/ })).toBeNull();

        cleanup();
        card(poll(), { canEnd: false });
        expect(screen.queryByRole("button", { name: /End poll/ })).toBeNull();
    });

    it("closes the card the moment it is done", async () => {
        const user = userEvent.setup();
        card(poll(), { canEnd: true });
        await user.click(screen.getByRole("button", { name: /End poll/ }));

        expect(ended).toEqual(["m1"]);
        expect(screen.getByText("Poll closed")).toBeDefined();
        expect(screen.getByText("Closed early")).toBeDefined();
    });
});
