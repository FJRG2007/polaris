// @vitest-environment jsdom

/**
 * Tab reaches every option of a menu, not only the first.
 *
 * A menu refuses tab, so in the tag picker tab from the search field reached the
 * first match and stopped: "Create tag" under the matches could only be reached
 * by the arrows or the mouse. Tab and shift-tab now walk the options as the
 * arrows do, with the field as one more stop.
 */

import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MenuSearch } from "../src/components/menu-search";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "../src/components/dropdown-menu";

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

function Picker() {
    const [query, setQuery] = useState("ba");
    return (
        <DropdownMenu defaultOpen>
            <DropdownMenuTrigger>Tags</DropdownMenuTrigger>
            <DropdownMenuContent>
                <MenuSearch value={query} onChange={setQuery} placeholder="Find or create" />
                <DropdownMenuItem>backend</DropdownMenuItem>
                <DropdownMenuItem>Create tag "ba"</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

describe("tab in a menu", () => {
    it("steps from the field through every option and wraps back to the field", () => {
        render(<Picker />);
        const field = screen.getByPlaceholderText("Find or create");
        const [first, create] = screen.getAllByRole("menuitem");
        field.focus();

        fireEvent.keyDown(field, { key: "Tab" });
        expect(document.activeElement).toBe(first);
        fireEvent.keyDown(first!, { key: "Tab" });
        expect(document.activeElement).toBe(create);
        fireEvent.keyDown(create!, { key: "Tab" });
        expect(document.activeElement).toBe(field);
    });

    it("steps backwards with shift-tab", () => {
        render(<Picker />);
        const [first, create] = screen.getAllByRole("menuitem");
        create!.focus();
        fireEvent.keyDown(create!, { key: "Tab", shiftKey: true });
        expect(document.activeElement).toBe(first);
    });
});
