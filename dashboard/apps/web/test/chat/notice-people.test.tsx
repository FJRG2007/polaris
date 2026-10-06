// @vitest-environment jsdom

/**
 * The people a system line names can be pressed.
 *
 * The report: "You added Elepd" named somebody who could not be pressed, where
 * every mention and every author's name opens that person's card - as the same
 * lines do in Discord. Each name in the line is now the same press a mention is.
 */

import { NoticeText } from "@/app/(app)/chat/notice-line";
import type { ChatMessageView } from "@/lib/chat/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonPressContext } from "@/components/person-press";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

const LINE = {
    kind: "system",
    body: "You added Elepd",
    notice: [
        { userId: "u-me", name: "You" },
        { text: " added " },
        { userId: "u-elepd", name: "Elepd" }
    ]
} as unknown as ChatMessageView;

describe("a system line", () => {
    it("opens the card of the person pressed, as a mention does", () => {
        const press = vi.fn();
        const { container } = render(
            <PersonPressContext.Provider value={press}>
                <p>
                    <NoticeText message={LINE} />
                </p>
            </PersonPressContext.Provider>
        );
        fireEvent.click(screen.getByRole("button", { name: "Elepd" }));
        expect(press).toHaveBeenCalledWith(
            { id: "u-elepd", name: "Elepd" },
            expect.any(HTMLElement)
        );
        expect(container.textContent).toBe("You added Elepd");
    });

    it("reads as the plain sentence where nothing opens a card, or the pieces are missing", () => {
        render(<NoticeText message={LINE} />);
        expect(screen.queryByRole("button")).toBeNull();
        cleanup();
        render(<NoticeText message={{ ...LINE, notice: undefined }} />);
        expect(screen.getByText("You added Elepd")).toBeTruthy();
    });
});
