// @vitest-environment jsdom

/**
 * Writing the question.
 *
 * The dialog holds the same rules the server does, so nothing is refused after
 * the press - but it holds them as a hint rather than as a complaint. An empty
 * answer box is not a mistake somebody made; it is one they have not reached
 * yet, and a form that turns red under a person's hands while they are still
 * typing is a form that reads as broken.
 *
 * The two shapes worth pinning down are the ones somebody hits without meaning
 * to: emptying an answer that is one of the last two, which must leave the row
 * rather than collapse the list below the minimum, and pressing Enter halfway
 * through writing the answers, which must not send the poll.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PollDialog, type PollDraft } from "@/app/(app)/chat/poll-dialog";

const made: PollDraft[] = [];

function dialog() {
    return render(
        <PollDialog
            open
            onOpenChange={() => undefined}
            onConfirm={(draft) => made.push(draft)}
        />
    );
}

/** The Create button, which is present from the start and refuses until there is
 *  something to send. */
function create() {
    return screen.getByRole("button", { name: /Create poll/ });
}

afterEach(() => {
    cleanup();
    made.length = 0;
});

describe("before it can be sent", () => {
    it("says what is missing rather than marking the empty boxes wrong", () => {
        dialog();
        expect(screen.getByText("Ask something first")).toBeDefined();
        expect(create().getAttribute("aria-disabled")).toBe("true");
    });

    it("asks for the second answer once there is a question", async () => {
        const user = userEvent.setup();
        dialog();
        await user.type(screen.getByRole("textbox", { name: /Question/i }), "Lunch?");
        expect(screen.getByText("A poll needs at least two answers")).toBeDefined();
        expect(create().getAttribute("aria-disabled")).toBe("true");
    });

    it("sends nothing while it is still refusing", async () => {
        const user = userEvent.setup();
        dialog();
        await user.type(screen.getByRole("textbox", { name: /Question/i }), "Lunch?");
        await user.click(create());
        expect(made).toEqual([]);
    });
});

describe("a poll that is ready", () => {
    async function fill(user: ReturnType<typeof userEvent.setup>) {
        await user.type(screen.getByRole("textbox", { name: /Question/i }), "Lunch?");
        await user.type(screen.getByRole("textbox", { name: "Answer 1" }), "Pizza");
        await user.type(screen.getByRole("textbox", { name: "Answer 2" }), "Sushi");
    }

    it("hands back the question and the answers, trimmed", async () => {
        const user = userEvent.setup();
        dialog();
        await fill(user);
        await user.click(create());

        expect(made).toEqual([
            {
                question: "Lunch?",
                options: ["Pizza", "Sushi"],
                multiple: false,
                hideResults: false,
                hours: 24
            }
        ]);
    });

    it("drops an answer written twice rather than splitting the vote", async () => {
        const user = userEvent.setup();
        dialog();
        await fill(user);
        await user.click(screen.getByRole("button", { name: /Add an answer/ }));
        await user.type(screen.getByRole("textbox", { name: "Answer 3" }), "  pizza ");
        await user.click(create());

        expect(made[0]?.options).toEqual(["Pizza", "Sushi"]);
    });

    it("carries the two decisions somebody made about it", async () => {
        const user = userEvent.setup();
        dialog();
        await fill(user);
        await user.click(screen.getByRole("switch", { name: /more than one answer/i }));
        await user.click(screen.getByRole("switch", { name: /Hide the results/i }));
        await user.click(create());

        expect(made[0]?.multiple).toBe(true);
        expect(made[0]?.hideResults).toBe(true);
    });
});

describe("the answer rows", () => {
    it("adds one, up to the limit", async () => {
        const user = userEvent.setup();
        dialog();
        await user.click(screen.getByRole("button", { name: /Add an answer/ }));
        expect(screen.getByRole("textbox", { name: "Answer 3" })).toBeDefined();
    });

    it("empties the last two rather than removing them, so the form cannot go below a poll", async () => {
        const user = userEvent.setup();
        dialog();
        await user.type(screen.getByRole("textbox", { name: "Answer 1" }), "Pizza");
        await user.click(screen.getByRole("button", { name: /Remove answer 1/ }));

        expect(screen.getByRole("textbox", { name: "Answer 1" })).toBeDefined();
        expect(screen.getByRole("textbox", { name: "Answer 2" })).toBeDefined();
        expect(
            (screen.getByRole("textbox", { name: "Answer 1" }) as HTMLInputElement).value
        ).toBe("");
    });

    it("takes a third one away entirely", async () => {
        const user = userEvent.setup();
        dialog();
        await user.click(screen.getByRole("button", { name: /Add an answer/ }));
        await user.click(screen.getByRole("button", { name: /Remove answer 3/ }));
        expect(screen.queryByRole("textbox", { name: "Answer 3" })).toBeNull();
    });

    it("moves down the list on Enter instead of sending half a poll", async () => {
        const user = userEvent.setup();
        dialog();
        await user.type(screen.getByRole("textbox", { name: "Answer 1" }), "Pizza{Enter}");
        expect(made).toEqual([]);
        expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Answer 2" }));
    });

    it("adds a row on Enter from the last one", async () => {
        const user = userEvent.setup();
        dialog();
        await user.type(screen.getByRole("textbox", { name: "Answer 2" }), "Sushi{Enter}");
        expect(screen.getByRole("textbox", { name: "Answer 3" })).toBeDefined();
        expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Answer 3" }));
    });
});
