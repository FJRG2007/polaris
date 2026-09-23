// @vitest-environment jsdom

/**
 * A player row, and the two places its verbs are offered from.
 *
 * The point of the shape under test is that there is one list: the `...` at the
 * end of the row and the menu the right button opens are two renderings of it,
 * so a verb cannot exist in one and not the other. That is what this asserts -
 * the same entries, drawn by both, with what is refused still refused.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    RowContextMenu,
    RowMenuButton,
    type RowMenuEntry
} from "@polaris-app/game-servers/src/components/row-menu";

const kicked = vi.fn();

const ENTRIES: RowMenuEntry[] = [
    { kind: "label", text: "ErMigue04" },
    { kind: "separator" },
    { kind: "item", text: "Kick them", onSelect: kicked },
    { kind: "item", text: "Teleport", disabled: true, onSelect: () => undefined },
    { kind: "item", text: "Kill", danger: true, onSelect: () => undefined },
    { kind: "link", text: "Open their Steam profile", href: "https://steamcommunity.com/profiles/1" }
];

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("the menu on a player row", () => {
    it("opens on the right button, with everything the ... has", async () => {
        render(
            <table>
                <tbody>
                    <RowContextMenu entries={ENTRIES}>
                        <tr>
                            <td>ErMigue04</td>
                        </tr>
                    </RowContextMenu>
                </tbody>
            </table>
        );

        fireEvent.contextMenu(screen.getByText("ErMigue04"));

        expect(await screen.findByText("Kick them")).toBeTruthy();
        expect(screen.getByText("Teleport")).toBeTruthy();
        expect(screen.getByText("Kill")).toBeTruthy();
        expect(screen.getByText("Open their Steam profile")).toBeTruthy();
    });

    it("acts on the row it was opened over", async () => {
        render(
            <table>
                <tbody>
                    <RowContextMenu entries={ENTRIES}>
                        <tr>
                            <td>ErMigue04</td>
                        </tr>
                    </RowContextMenu>
                </tbody>
            </table>
        );

        fireEvent.contextMenu(screen.getByText("ErMigue04"));
        fireEvent.click(await screen.findByText("Kick them"));

        expect(kicked).toHaveBeenCalledTimes(1);
    });

    it("keeps a refused verb refused in the menu as well", async () => {
        render(
            <table>
                <tbody>
                    <RowContextMenu entries={ENTRIES}>
                        <tr>
                            <td>ErMigue04</td>
                        </tr>
                    </RowContextMenu>
                </tbody>
            </table>
        );

        fireEvent.contextMenu(screen.getByText("ErMigue04"));
        const teleport = await screen.findByText("Teleport");

        // Radix marks a disabled item rather than dropping it, which is what the
        // row wants: the verb exists and says why it cannot be used now.
        expect(teleport.closest("[data-disabled]")).toBeTruthy();
    });

    it("draws the same list behind the three dots", async () => {
        render(<RowMenuButton entries={ENTRIES} label="More for ErMigue04" />);

        // Opened with a pointer rather than from the keyboard, which is how the
        // three dots are actually used. It also avoids the one thing a keyboard
        // open does that jsdom cannot finish: the menu then walks its items
        // looking for the first to focus, nothing in jsdom is focusable enough to
        // be found, and the walk lands after the test is over and the menu
        // unmounted - an uncaught TypeError that fails the whole run while every
        // test still reads as passed.
        fireEvent.pointerDown(screen.getByLabelText("More for ErMigue04"), {
            button: 0,
            ctrlKey: false,
            pointerType: "mouse"
        });

        expect(await screen.findByText("Kick them")).toBeTruthy();
        expect(screen.getByText("Kill")).toBeTruthy();
        expect(screen.getByText("Open their Steam profile")).toBeTruthy();
    });
});
