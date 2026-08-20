// @vitest-environment jsdom

/**
 * The field that filters a menu, and the two things that break one.
 *
 * A menu takes focus as it opens, which undoes an `autoFocus` on anything drawn
 * inside it, and it reads every character afterwards as a jump to the option
 * beginning with that letter, which moves focus off the field on the first
 * keystroke. Both are silent: the box looks like a search box and simply never
 * receives what is typed into it, which is how the tag picker shipped with a
 * search nobody could use.
 *
 * So what is asserted here is the contract rather than the markup - the field
 * ends up with the caret, its own typing never reaches the menu, and the keys
 * that still belong to the menu still get there - and then the same thing again
 * inside a real right-click submenu, which is the case where the field has no
 * mounting of its own to work from.
 */

import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    MenuSearch,
    MenuSurfaceProvider,
    menuSearchMatches
} from "@polaris/ui";

// A menu positions itself against the box its trigger occupies, which is
// machinery jsdom does not have.
beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.scrollIntoView ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(cleanup);

/**
 * A menu around the field, standing in for the real one: the surface carries the
 * attribute the field looks for and the options carry the role, which is all
 * either of them knows about the other.
 */
function Menu({ onMenuKeyDown, ...props }: { onMenuKeyDown?: (key: string) => void; open?: boolean }) {
    const options = ["Backend", "Design", "Frontend"];
    return (
        <MenuSurfaceProvider value={{ open: props.open ?? true, kept: false }}>
            <div data-radix-menu-content="" onKeyDown={(event) => onMenuKeyDown?.(event.key)}>
                <MenuSearch value="" onChange={() => {}} placeholder="Find a tag" />
                {options.map((option) => (
                    <button key={option} type="button" role="menuitem">
                        {option}
                    </button>
                ))}
            </div>
        </MenuSurfaceProvider>
    );
}

describe("the field that filters a menu", () => {
    it("takes the caret once the menu has settled", async () => {
        render(<Menu />);
        const field = screen.getByPlaceholderText("Find a tag");
        await waitFor(() => expect(document.activeElement).toBe(field));
    });

    it("keeps its own typing away from the menu, which would read it as a jump", async () => {
        const onMenuKeyDown = vi.fn();
        render(<Menu onMenuKeyDown={onMenuKeyDown} />);
        const field = screen.getByPlaceholderText("Find a tag");
        await waitFor(() => expect(document.activeElement).toBe(field));

        await userEvent.keyboard("de");

        expect(onMenuKeyDown).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(field);
    });

    it("hands back the keys the menu still answers for", async () => {
        const onMenuKeyDown = vi.fn();
        render(<Menu onMenuKeyDown={onMenuKeyDown} />);
        await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText("Find a tag")));

        await userEvent.keyboard("{Escape}");

        expect(onMenuKeyDown).toHaveBeenCalledWith("Escape");
    });

    it("steps into the options, which a menu only does for a key pressed on itself", async () => {
        render(<Menu />);
        await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText("Find a tag")));

        await userEvent.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Backend" }));
    });

    it("takes the first option left on screen when enter is pressed", async () => {
        const chosen = vi.fn();
        render(
            <MenuSurfaceProvider value={{ open: true, kept: false }}>
                <div data-radix-menu-content="">
                    <MenuSearch value="" onChange={() => {}} placeholder="Find a tag" />
                    <button type="button" role="menuitem" onClick={chosen}>
                        Backend
                    </button>
                </div>
            </MenuSurfaceProvider>
        );
        await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText("Find a tag")));

        await userEvent.keyboard("{Enter}");
        expect(chosen).toHaveBeenCalledOnce();
    });
});

/** A right-click menu with a search in one of its submenus. */
function Row() {
    const [query, setQuery] = useState("");
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <button type="button">Task</button>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem>Open</ContextMenuItem>
                <ContextMenuSub>
                    <ContextMenuSubTrigger>Tags</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        <MenuSearch value={query} onChange={setQuery} placeholder="Find a tag" />
                        <ContextMenuItem>backend</ContextMenuItem>
                    </ContextMenuSubContent>
                </ContextMenuSub>
            </ContextMenuContent>
        </ContextMenu>
    );
}

describe("the same field inside a right-click submenu", () => {
    it("takes the caret every time the submenu is stepped into, not only the first", async () => {
        // A submenu is built once and then kept, hidden rather than unmounted
        // while it is closed, so coming back to it is not a mount and there is
        // nothing for `autoFocus` to happen on. Without the surface saying it is
        // open again, the search worked once per right-click and then went dead.
        render(<Row />);
        fireEvent.contextMenu(screen.getByText("Task"));
        const trigger = await screen.findByText("Tags");

        await userEvent.hover(trigger);
        const field = await screen.findByPlaceholderText("Find a tag");
        await waitFor(() => expect(document.activeElement).toBe(field));

        await userEvent.hover(screen.getByText("Open"));
        await waitFor(() => expect(trigger.dataset.state).toBe("closed"));
        expect(document.activeElement).not.toBe(field);

        await userEvent.hover(trigger);
        await waitFor(() => expect(document.activeElement).toBe(field));
    });
});

describe("what a menu's search leaves on screen", () => {
    it("matches any part of a name, not only its start", () => {
        expect(menuSearchMatches("Website design", "design")).toBe(true);
        expect(menuSearchMatches("Website design", "DESIGN")).toBe(true);
        expect(menuSearchMatches("Website design", "backend")).toBe(false);
    });

    it("leaves the whole list alone until something is typed", () => {
        expect(menuSearchMatches("Anything", "")).toBe(true);
        expect(menuSearchMatches("Anything", "   ")).toBe(true);
    });
});
