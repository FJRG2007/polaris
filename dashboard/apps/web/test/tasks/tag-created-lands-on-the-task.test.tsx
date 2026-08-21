// @vitest-environment jsdom

/**
 * Creating a tag from the picker while filling a task in.
 *
 * The tag is made for this task - that is the whole reason somebody typed it
 * there rather than in the space's settings - so it has to end up on the task,
 * not merely exist. What used to break it: the screen draws an edit against the
 * tags it was given when it opened, and a tag created a second ago is not among
 * them, so the id was written and then dropped on the way to the screen.
 */

import userEvent from "@testing-library/user-event";
import type { PersonRef } from "@/lib/tasks/facts";
import type { StatusView } from "@/lib/tasks/space-service";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const createTagAction = vi.fn(async (spaceId: string, name: string, color: string) => ({
    tag: { id: "t-new", name, color }
}));

vi.mock("@/app/(app)/tasks/actions", () => ({
    createTagAction: (spaceId: string, name: string, color: string) => createTagAction(spaceId, name, color),
    createTaskAction: async () => ({ id: "task1" })
}));
// The description editor asks these for its @ and # pickers; the module reaches
// the database and the session on import.
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));

// The dialog and its menus measure the boxes they position against, which is
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

afterEach(() => {
    cleanup();
    createTagAction.mockClear();
});

const { TaskCreateDialog } = await import("@/app/(app)/tasks/task-create-dialog");

const STATUSES: StatusView[] = [{ id: "st1", name: "Open", type: "open", color: "#64748b", order: 0 }];
const PEOPLE: PersonRef[] = [{ id: "u1", name: "Ada Lovelace" }];

function dialog() {
    return render(
        <TaskCreateDialog
            open
            spaceId="s1"
            statuses={STATUSES}
            tags={[]}
            people={PEOPLE}
            lists={[{ id: "l1", name: "Inbox" }]}
            defaultListId="l1"
            onClose={() => {}}
            onCreated={() => {}}
        />
    );
}

describe("a tag created from the picker of a task being written", () => {
    it("is put on that task, not only into the space", async () => {
        dialog();

        await userEvent.click(screen.getByRole("button", { name: "Tags" }));
        const field = await screen.findByPlaceholderText("Find or create a tag");
        await userEvent.type(field, "urgent{Enter}");

        await waitFor(() => expect(createTagAction).toHaveBeenCalledWith("s1", "urgent", expect.any(String)));
        // The chip beside the picker is the task carrying it. The menu lists the
        // name too, so the count is what says it landed somewhere else as well.
        // The chip beside the picker is the task carrying the tag; the menu lists
        // the name as well, which is why the chip is asked for by its own control.
        await waitFor(() => expect(screen.getByLabelText("Remove urgent")).toBeDefined());
    });
});
