// @vitest-environment jsdom

/**
 * The send dialog, as somebody actually sees it.
 *
 * Two things it has to get right are both about not surprising anybody: a copy
 * is the default and the other option is written as what it DOES rather than as
 * a verb, and a name that cannot receive is shown greyed rather than removed
 * from the list - a name missing teaches nobody anything, one that is there and
 * refused is a question with an answer.
 */

import userEvent from "@testing-library/user-event";
import { SendDialog } from "@/app/(app)/drive/send-dialog";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findTransferPeopleAction = vi.fn();
const sendTransferAction = vi.fn();
const transferOrgsAction = vi.fn();

vi.mock("@/app/(app)/drive/transfer-actions", () => ({
    findTransferPeopleAction: (...args: unknown[]) => findTransferPeopleAction(...args),
    sendTransferAction: (...args: unknown[]) => sendTransferAction(...args),
    transferOrgsAction: (...args: unknown[]) => transferOrgsAction(...args)
}));

afterEach(cleanup);

beforeEach(() => {
    vi.clearAllMocks();
    transferOrgsAction.mockResolvedValue([]);
    findTransferPeopleAction.mockResolvedValue({
        results: [
            { id: "bob", name: "Bob", allowed: true },
            { id: "eve", name: "Eve", allowed: false }
        ],
        withheld: 0
    });
});

describe("sending a file", () => {
    it("shows somebody who cannot receive as greyed rather than gone, with the reason", async () => {
        const user = userEvent.setup();
        render(
            <SendDialog
                open
                onOpenChange={() => undefined}
                connectionId="c1"
                path="a/report.pdf"
                name="report.pdf"
            />
        );

        await user.type(screen.getByLabelText("Search for a person"), "xx");
        const eve = await screen.findByRole("button", { name: /Eve/ });
        expect(eve.hasAttribute("disabled")).toBe(true);
        expect(eve.textContent).toContain("Not accepting files");

        const bob = screen.getByRole("button", { name: /Bob/ });
        expect(bob.hasAttribute("disabled")).toBe(false);
        expect(bob.textContent).not.toContain("Not accepting files");
    });

    it("defaults to a copy and describes 'send the file itself' by what it does", async () => {
        const user = userEvent.setup();
        render(
            <SendDialog
                open
                onOpenChange={() => undefined}
                connectionId="c1"
                path="a/report.pdf"
                name="report.pdf"
            />
        );

        await user.type(screen.getByLabelText("Search for a person"), "xx");
        await user.click(await screen.findByRole("button", { name: /Bob/ }));

        const toggle = screen.getByLabelText("Send the file itself");
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(
            screen.getByText(/It leaves your Drive once they accept it/)
        ).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Send" }));
        expect(sendTransferAction).toHaveBeenCalledWith(
            expect.objectContaining({ mode: "copy", to: [{ userId: "bob" }] })
        );
    });

    it("turns sending the file itself back off the moment a second recipient joins", async () => {
        // Picking a second person is what turns "move" back into "copy" - "move
        // it to all of them" has no meaning.
        findTransferPeopleAction.mockResolvedValue({
            results: [
                { id: "bob", name: "Bob", allowed: true },
                { id: "ada", name: "Ada", allowed: true }
            ],
            withheld: 0
        });
        const user = userEvent.setup();
        render(
            <SendDialog
                open
                onOpenChange={() => undefined}
                connectionId="c1"
                path="a/report.pdf"
                name="report.pdf"
            />
        );

        await user.type(screen.getByLabelText("Search for a person"), "xx");
        await user.click(await screen.findByRole("button", { name: /Bob/ }));
        await user.click(screen.getByLabelText("Send the file itself"));
        expect(screen.getByLabelText("Send the file itself").getAttribute("aria-checked")).toBe(
            "true"
        );

        await user.click(screen.getByRole("button", { name: /Ada/ }));
        const toggle = screen.getByLabelText("Send the file itself");
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(toggle.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText(/Only when you are sending to one person/)).toBeTruthy();
    });
});
