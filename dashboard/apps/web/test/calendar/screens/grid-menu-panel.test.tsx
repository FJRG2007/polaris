// @vitest-environment jsdom

/**
 * A choice in the grid's menu that opens a panel leaves it open: "New event
 * here" right-clicked on a day used to open the new-event card and close it in
 * the same breath.
 */

import "@/components/app-host/client";
import { useState } from "react";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { AnchoredPanel } from "@polaris-app/calendar/src/screens/ui";
import {
    GridMenu,
    type GridMenuActions,
    type MenuTarget
} from "@polaris-app/calendar/src/screens/grid-menu";
import type { GridTarget } from "@polaris-app/calendar/src/screens/grid-target";
import type { OccurrenceView } from "@polaris-app/calendar/src/lib/wire";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

const OCCURRENCE = {
    objectId: "o1",
    summary: "Fixture review",
    editable: false,
    busyOnly: true,
    myPartstat: null
} as unknown as OccurrenceView;

function resolve(target: GridTarget, point: DOMRect): MenuTarget | null {
    if (target.kind === "item")
        return { kind: "event", id: target.id, occurrence: OCCURRENCE, rect: point };
    if (target.kind !== "slot") return null;
    const at = new Date(`${target.day}T09:00:00Z`);
    const start = { at, day: target.day, allDay: false };
    return {
        kind: "slot",
        range: { start, end: { ...start, at: new Date(at.getTime() + 1_800_000) } },
        day: target.day,
        selected: false,
        when: target.day,
        point
    };
}

function Screen() {
    const [open, setOpen] = useState(false);
    const actions = {
        newEvent: () => setOpen(true),
        newAllDay: () => setOpen(true),
        openItem: () => setOpen(true),
        goToDay: () => undefined
    } as unknown as GridMenuActions;
    return (
        <>
            <GridMenu
                resolve={resolve}
                heldRange={() => null}
                onOpenChange={() => undefined}
                calendars={[]}
                clipboard={null}
                taskLists={null}
                showsOnlyDay={() => false}
                actions={actions}
            >
                <div className="fc">
                    <table>
                        <tbody>
                            <tr>
                                <td
                                    className="fc-daygrid-day"
                                    data-date="2026-10-07"
                                    data-testid="day"
                                    tabIndex={0}
                                >
                                    <a
                                        className="fc-event"
                                        data-event-id="event|o1|k"
                                        data-testid="event"
                                        tabIndex={0}
                                    >
                                        Fixture review
                                    </a>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </GridMenu>
            {open ? (
                <AnchoredPanel
                    open
                    onOpenChange={(next) => !next && setOpen(false)}
                    anchor={null}
                    title="Panel"
                >
                    <input aria-label="Title" autoFocus />
                </AnchoredPanel>
            ) : null}
        </>
    );
}

function openWithPointer(element: HTMLElement): void {
    act(() => {
        element.focus();
        fireEvent.pointerDown(element, { button: 2, pointerType: "mouse" });
        fireEvent.contextMenu(element, { clientX: 40, clientY: 60 });
    });
}

function openWithKeyboard(element: HTMLElement): void {
    act(() => {
        element.focus();
        fireEvent.keyDown(element, { key: "F10", shiftKey: true });
    });
}

async function choose(name: string) {
    const item = screen.getByRole("menuitem", { name });
    await act(async () => {
        fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
        fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
        fireEvent.click(item);
    });
    // The menu's own closing finishes on the next turns: focus going back, the
    // layer leaving.
    await act(async () => {
        await new Promise((done) => setTimeout(done, 50));
    });
}

function expectPanelOpen(): void {
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Panel" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Title" }));
}

describe("a menu choice that opens a panel", () => {
    it.each(["New event here", "New all-day event"])("%s stays open", async (name) => {
        render(<Screen />, { wrapper: MessagesWrapper });
        openWithPointer(screen.getByTestId("day"));
        await choose(name);
        expectPanelOpen();
    });

    it("stays open when the menu was opened from the keyboard", async () => {
        render(<Screen />, { wrapper: MessagesWrapper });
        openWithKeyboard(screen.getByTestId("day"));
        await choose("New event here");
        expectPanelOpen();
    });

    it("leaves an event's card open when it is opened from the event's menu", async () => {
        render(<Screen />, { wrapper: MessagesWrapper });
        openWithPointer(screen.getByTestId("event"));
        await choose("Open");
        expectPanelOpen();
    });

    it("hands the focus back to the day when the choice opened nothing", async () => {
        render(<Screen />, { wrapper: MessagesWrapper });
        openWithPointer(screen.getByTestId("day"));
        await choose("Go to this day");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.activeElement).toBe(screen.getByTestId("day"));
    });
});
