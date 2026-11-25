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

import { MessagesWrapper } from "../setup/i18n";
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
    pollAction: async () => ({ poll: null }),
    pollVotersAction: async (messageId: string) => {
        listed.push(messageId);
        return {
            answers: [
                { optionId: "o1", voters: [{ id: "u-ada", name: "Ada Lovelace" }], more: 0 },
                { optionId: "o2", voters: [], more: 0 }
            ]
        };
    }
}));
const listed: string[] = [];

let sealedOn = false;
const ballotsCast: { messageId: string; optionIds: readonly string[] }[] = [];
vi.mock("@/lib/chat/e2ee/sealed-chat", () => ({ sealedChatActive: () => sealedOn }));
vi.mock("@/app/(app)/chat/sealed-votes", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/(app)/chat/sealed-votes")>()),
    // Bob's sealed ballot for Sushi, already cast.
    loadBallots: async () => [{ picks: [1], mine: false, voter: { id: "u-bob", name: "Bob" } }],
    castSealedVote: async (_channelId: string, messageId: string, _poll: unknown, optionIds: readonly string[]) => {
        ballotsCast.push({ messageId, optionIds });
        return refuse ? { error: refuse } : {};
    }
}));

// The live wire is a device-wide connection. Nothing here is testing it, and a
// card that opened one would be a test holding a socket.
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));

function poll(over: Partial<ChatPollView> = {}): ChatPollView {
    return {
        multiple: false,
        hideResults: false,
        anonymous: true,
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
        />, { wrapper: MessagesWrapper }
    );
}

afterEach(() => {
    cleanup();
    sent.length = 0;
    ended.length = 0;
    refuse = null;
    sealedOn = false;
    ballotsCast.length = 0;
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

describe("public and anonymous votes", () => {
    it("says an anonymous poll is anonymous and offers no list of voters", () => {
        card(poll({ anonymous: true, voters: 2, options: [
            { id: "o1", text: "Pizza", votes: 2, mine: false },
            { id: "o2", text: "Sushi", votes: 0, mine: false }
        ] }));
        expect(screen.getByText("Anonymous")).toBeDefined();
        expect(screen.queryByRole("button", { name: "See votes" })).toBeNull();
    });

    it("keeps the list back while a hidden public poll runs", () => {
        card(poll({ anonymous: false, hideResults: true, results: false, voters: 2 }));
        expect(screen.getByText("Public")).toBeDefined();
        expect(screen.queryByRole("button", { name: "See votes" })).toBeNull();
    });

    it("lists who picked each answer of a public poll", async () => {
        const user = userEvent.setup();
        card(poll({ anonymous: false, voters: 1, options: [
            { id: "o1", text: "Pizza", votes: 1, mine: false },
            { id: "o2", text: "Sushi", votes: 0, mine: false }
        ] }));
        await user.click(screen.getByRole("button", { name: "See votes" }));
        expect(listed).toEqual(["m1"]);
        expect(await screen.findByText("Ada Lovelace")).toBeDefined();
        expect(screen.getByText("Nobody picked this")).toBeDefined();
    });
});

describe("a sealed poll", () => {
    it("counts the ballots this browser opened and votes with a sealed ballot, never in the clear", async () => {
        sealedOn = true;
        const user = userEvent.setup();
        card(poll({ sealedVotes: true, voters: 1 }));
        expect(await screen.findByText(/100% \(1\)/)).toBeDefined();
        await user.click(screen.getByRole("button", { name: /Pizza/ }));

        expect(sent).toEqual([]);
        expect(ballotsCast).toEqual([{ messageId: "m1", optionIds: ["o1"] }]);
        expect(screen.getByRole("button", { name: /Pizza/ }).getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByText("2 votes")).toBeDefined();
    });

    it("puts the bars back when the ballot is refused", async () => {
        sealedOn = true;
        refuse = "That poll has closed";
        const user = userEvent.setup();
        card(poll({ sealedVotes: true, voters: 1 }));
        await screen.findByText(/100% \(1\)/);
        await user.click(screen.getByRole("button", { name: /Pizza/ }));
        expect(screen.getByRole("button", { name: /Pizza/ }).getAttribute("aria-pressed")).toBe("false");
        expect(screen.getByText("1 vote")).toBeDefined();
    });

    it("cannot be voted on from a page without sealed chat", () => {
        card(poll({ sealedVotes: true }));
        expect(screen.getByRole("button", { name: /Pizza/ }).hasAttribute("disabled")).toBe(true);
    });
});
