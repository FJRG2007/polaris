// @vitest-environment jsdom

/**
 * Code's composer pickers on a phone: the same rows, in a sheet from the bottom.
 *
 * What has to hold is the menu's contract carried over: a row picked closes the
 * sheet, a row whose `onSelect` prevents the event (the model list's "more")
 * keeps it open, and above the phone width the parts are the Dropdown's.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    SheetMenu,
    SheetMenuContent,
    SheetMenuItem,
    SheetMenuLabel,
    SheetMenuTrigger
} from "@/components/polar/elements/sheet-menu";

function screenIs(phone: boolean) {
    window.matchMedia = ((query: string) => ({
        matches: phone && query.includes("max-width"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
    })) as unknown as typeof window.matchMedia;
}

function Picker({ onPick, onMore }: { onPick: () => void; onMore: () => void }) {
    return (
        <SheetMenu>
            <SheetMenuTrigger>
                <button type="button">Model</button>
            </SheetMenuTrigger>
            <SheetMenuContent title="Pick a model">
                <SheetMenuLabel>Fixture source</SheetMenuLabel>
                <SheetMenuItem onSelect={onPick}>Fixture model</SheetMenuItem>
                <SheetMenuItem
                    onSelect={(event) => {
                        event.preventDefault();
                        onMore();
                    }}
                >
                    More
                </SheetMenuItem>
            </SheetMenuContent>
        </SheetMenu>
    );
}

afterEach(cleanup);

describe("SheetMenu on a phone", () => {
    it("opens a sheet named by its title, and a picked row closes it", () => {
        screenIs(true);
        const onPick = vi.fn();
        render(<Picker onPick={onPick} onMore={() => undefined} />);
        expect(screen.queryByRole("dialog")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Model" }));
        expect(screen.getByRole("dialog", { name: "Pick a model" })).toBeTruthy();
        expect(screen.getByText("Fixture source")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Fixture model" }));
        expect(onPick).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("stays open for a row that prevents the select", () => {
        screenIs(true);
        const onMore = vi.fn();
        render(<Picker onPick={() => undefined} onMore={onMore} />);
        fireEvent.click(screen.getByRole("button", { name: "Model" }));
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        expect(onMore).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("keeps a disabled trigger shut", () => {
        screenIs(true);
        render(
            <SheetMenu>
                <SheetMenuTrigger disabled>
                    <button type="button">Model</button>
                </SheetMenuTrigger>
                <SheetMenuContent title="Pick a model">
                    <SheetMenuItem>Fixture model</SheetMenuItem>
                </SheetMenuContent>
            </SheetMenu>
        );
        fireEvent.click(screen.getByRole("button", { name: "Model" }));
        expect(screen.queryByRole("dialog")).toBeNull();
    });
});

describe("SheetMenu above a phone", () => {
    it("is the dropdown menu, with no sheet", () => {
        screenIs(false);
        render(<Picker onPick={() => undefined} onMore={() => undefined} />);
        const trigger = screen.getByRole("button", { name: "Model" });
        expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
        expect(screen.queryByRole("dialog")).toBeNull();
    });
});
