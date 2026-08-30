// @vitest-environment jsdom

/**
 * The field at the top of a menu, and the two things that made it unusable.
 *
 * A menu takes focus for itself as it opens, and the field used to try to win
 * that by taking focus a tick later. Whoever won depended on the machine. When
 * the field lost, every letter typed went to the menu's type-ahead instead: the
 * name was never typed anywhere, and enter then meant whatever the jumping about
 * had left highlighted. That is exactly what "the tag picker does not focus, and
 * enter did something else entirely" was.
 *
 * So: the field has the focus the moment the menu is open, and enter in it is
 * the field's own - it reaches the submit that creates the thing being named,
 * and it reaches nothing above the menu, which is portalled out of the page but
 * still nested inside it as far as a key press is concerned.
 *
 * The handover itself is pinned where it can be pinned - `menu-search-focus` in
 * the design system, where it is a decision rather than a race. Here there is no
 * animation and no paint, so the losing order cannot be reproduced at all: what
 * these assert is the behaviour somebody depends on, whichever way it was won.
 */

import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, MenuSearch } from "@polaris/ui";

afterEach(cleanup);

function Picker({
    onSubmit,
    onOuterKey,
    onPick
}: {
    onSubmit: (value: string) => void;
    onOuterKey?: () => void;
    onPick?: () => void;
}) {
    const [value, setValue] = useState("");
    return (
        // The screen around the menu. A menu is portalled out of the page, but a
        // key pressed inside it still reaches the components it is nested under -
        // which is how enter in this field used to be somebody else's enter as
        // well: a form's, a dialog's, a row's.
        <div onKeyDown={() => onOuterKey?.()}>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button type="button">Tag</button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                    <MenuSearch
                        value={value}
                        onChange={setValue}
                        onSubmit={() => onSubmit(value)}
                        placeholder="Find or create a tag"
                    />
                    <DropdownMenuItem
                        onSelect={(event) => {
                            event.preventDefault();
                            onPick?.();
                        }}
                    >
                        backend
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

describe("opening a menu with a field in it", () => {
    it("gives the field the focus instead of taking it", async () => {
        const user = userEvent.setup();
        render(<Picker onSubmit={() => undefined} />);
        await user.click(screen.getByRole("button", { name: "Tag" }));

        const field = await screen.findByLabelText("Find or create a tag");
        await waitFor(() => expect(document.activeElement).toBe(field));
    });

    it("takes what is typed, rather than losing it to the options", async () => {
        const user = userEvent.setup();
        render(<Picker onSubmit={() => undefined} />);
        await user.click(screen.getByRole("button", { name: "Tag" }));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Find or create a tag")));

        await user.keyboard("release");
        expect((screen.getByLabelText("Find or create a tag") as HTMLInputElement).value).toBe("release");
    });
});

describe("enter", () => {
    it("means the name that was just typed", async () => {
        const user = userEvent.setup();
        const submit = vi.fn();
        render(<Picker onSubmit={submit} />);
        await user.click(screen.getByRole("button", { name: "Tag" }));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Find or create a tag")));

        await user.keyboard("release{Enter}");
        expect(submit).toHaveBeenCalledWith("release");
    });

    it("commits the option tab stepped onto", async () => {
        const user = userEvent.setup();
        const picked = vi.fn();
        render(<Picker onSubmit={() => undefined} onPick={picked} />);
        await user.click(screen.getByRole("button", { name: "Tag" }));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Find or create a tag")));

        await user.keyboard("back{Tab}{Enter}");
        expect(picked).toHaveBeenCalledTimes(1);
    });

    it("does not reach the screen around the menu", async () => {
        const user = userEvent.setup();
        const outer = vi.fn();
        render(<Picker onSubmit={() => undefined} onOuterKey={outer} />);
        await user.click(screen.getByRole("button", { name: "Tag" }));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Find or create a tag")));

        await user.keyboard("{Enter}");
        expect(outer).not.toHaveBeenCalled();
    });
});
