// @vitest-environment jsdom

/**
 * The pickers a task screen is worked with, opened for real.
 *
 * `menu-search.test` pins the field's contract against a stand-in surface; this
 * one opens the actual menus, because the two things being relied on - a menu
 * that takes focus as it opens, and one that reads a keystroke as a jump to an
 * option - are the menu's own behaviour rather than the field's, and a change in
 * it would leave the search looking fine and quietly ignoring what is typed.
 */

import type { PersonRef } from "@/lib/tasks/facts";
import userEvent from "@testing-library/user-event";
import type { TagView } from "@/lib/tasks/space-service";
import { AssigneePicker, TagPicker } from "@/app/(app)/tasks/pickers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// The menus position themselves against the box their trigger occupies, which
// is machinery jsdom does not have.
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

const TAGS: TagView[] = [
    { id: "t1", name: "backend", color: "#3b82f6" },
    { id: "t2", name: "design", color: "#ec4899" },
    { id: "t3", name: "frontend", color: "#22c55e" }
];

const PEOPLE: PersonRef[] = [
    { id: "u1", name: "Ada Lovelace" },
    { id: "u2", name: "Grace Hopper" }
];

describe("the tag picker", () => {
    it("puts the caret in its search as it opens", async () => {
        render(<TagPicker tags={TAGS} selected={[]} onChange={() => {}} />);

        await userEvent.click(screen.getByRole("button", { name: "Tags" }));

        await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText("Find a tag")));
    });

    it("narrows the list as it is typed into, without the menu taking the keystrokes", async () => {
        render(<TagPicker tags={TAGS} selected={[]} onChange={() => {}} />);
        await userEvent.click(screen.getByRole("button", { name: "Tags" }));
        const field = await screen.findByPlaceholderText("Find a tag");

        await userEvent.type(field, "end");

        // Both halves matter: the field still holds the caret - a menu reading
        // "e" as a jump would have moved it onto an option - and it holds every
        // letter rather than the last one that survived.
        expect(document.activeElement).toBe(field);
        expect((field as HTMLInputElement).value).toBe("end");
        expect(screen.getByText("backend")).toBeDefined();
        expect(screen.getByText("frontend")).toBeDefined();
        expect(screen.queryByText("design")).toBeNull();
    });
});

describe("the assignee picker", () => {
    it("offers its search whatever the size of the space", async () => {
        const onChange = vi.fn();
        render(<AssigneePicker people={PEOPLE} selected={[]} onChange={onChange} />);

        await userEvent.click(screen.getByRole("button", { name: "Assignees" }));
        const field = await screen.findByPlaceholderText("Find someone");
        await waitFor(() => expect(document.activeElement).toBe(field));

        await userEvent.type(field, "grace");

        expect(screen.queryByText("Ada Lovelace")).toBeNull();
        await userEvent.click(screen.getByText("Grace Hopper"));
        expect(onChange).toHaveBeenCalledWith(["u2"]);
    });
});
