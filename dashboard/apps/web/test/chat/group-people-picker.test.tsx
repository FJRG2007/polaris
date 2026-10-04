// @vitest-environment jsdom

/**
 * The group picker shows who cannot be added, and why, instead of offering them.
 *
 * The server refuses anybody who is not a friend or a colleague. A picker that
 * let them be chosen anyway would assemble a group, name it, and then fail on
 * the button - so somebody who cannot be added is drawn greyed out with the
 * reason, cannot be picked, and is offered the request that would change it
 * when their own setting would take one.
 */

import { useState } from "react";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { PickedPerson } from "@/components/people-picker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const asked: string[] = [];
let groupSearches = 0;
let plainSearches = 0;

vi.mock("@/app/(app)/chat/actions", () => ({
    searchPeopleAction: async () => {
        plainSearches += 1;
        return { results: [{ id: "alan", name: "Alan" }], withheld: 0 };
    },
    searchGroupPeopleAction: async () => {
        groupSearches += 1;
        return {
            results: [
                { id: "grace", name: "Grace" },
                { id: "alan", name: "Alan", unavailable: "Not your friend yet", requestable: true },
                { id: "hopper", name: "Hopper", unavailable: "Friend request pending" }
            ],
            withheld: 0
        };
    },
    askFriendAction: async (personId: string) => {
        asked.push(personId);
        return {};
    }
}));

const { ChatPeoplePicker } = await import("@/app/(app)/chat/chat-people-picker");

function Harness({
    forGroup,
    onPicked
}: {
    forGroup: boolean;
    onPicked: (p: readonly PickedPerson[]) => void;
}) {
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    return (
        <ChatPeoplePicker
            forGroup={forGroup}
            picked={picked}
            onChange={(next) => {
                setPicked(next);
                onPicked(next);
            }}
        />
    );
}

afterEach(cleanup);
beforeEach(() => {
    asked.length = 0;
    groupSearches = 0;
    plainSearches = 0;
});

describe("picking people for a group", () => {
    it("offers a friend, and only a friend, as something to press", async () => {
        const user = userEvent.setup();
        const picks: (readonly PickedPerson[])[] = [];
        render(<Harness forGroup onPicked={(next) => picks.push(next)} />, {
            wrapper: MessagesWrapper
        });
        await user.type(screen.getByRole("textbox"), "al");

        const alan = (await screen.findByText("Not your friend yet")).closest("li")!;
        const hopper = screen.getByText("Friend request pending").closest("li")!;
        expect(alan.getAttribute("aria-disabled")).toBe("true");
        expect(hopper.getAttribute("aria-disabled")).toBe("true");

        // Pressing the name of somebody who cannot be added does nothing.
        await user.click(within(alan).getByText("Alan"));
        expect(picks).toEqual([]);

        // A friend is a button and becomes a chip.
        const grace = screen
            .getAllByRole("button")
            .find((button) => button.textContent?.includes("Grace"))!;
        await user.click(grace);
        expect(picks.at(-1)).toEqual([{ id: "grace", name: "Grace" }]);
        expect(groupSearches).toBeGreaterThan(0);
        expect(plainSearches).toBe(0);
    });

    it("offers the friend request beside a stranger who takes them, and not beside a waiting one", async () => {
        const user = userEvent.setup();
        render(<Harness forGroup onPicked={() => undefined} />, { wrapper: MessagesWrapper });
        await user.type(screen.getByRole("textbox"), "al");

        const alan = (await screen.findByText("Not your friend yet")).closest("li")!;
        const hopper = screen.getByText("Friend request pending").closest("li")!;
        expect(within(hopper).queryByRole("button")).toBeNull();

        await user.click(within(alan).getByRole("button", { name: "Send Alan a friend request" }));
        expect(asked).toEqual(["alan"]);
        expect(within(alan).getByText("Friend request sent")).toBeTruthy();
    });
});

describe("picking somebody to write to", () => {
    it("keeps the wider search, with nobody greyed out", async () => {
        const user = userEvent.setup();
        render(<Harness forGroup={false} onPicked={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        await user.type(screen.getByRole("textbox"), "al");
        await screen.findByText("Alan");
        expect(plainSearches).toBeGreaterThan(0);
        expect(groupSearches).toBe(0);
        expect(screen.queryByText("Not your friend yet")).toBeNull();
    });
});
