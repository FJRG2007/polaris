// @vitest-environment jsdom

/**
 * Creating a tag from the picker while filling a task in.
 *
 * The tag is made for this task - that is the whole reason somebody typed it
 * there rather than in the space's settings - so three things have to hold: it
 * is on the task at once, without waiting for the server; the task is written
 * with the id the server gave it rather than the one this browser invented; and
 * a refused creation takes the tag back off instead of leaving a chip that
 * stands for nothing.
 */

import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@polaris/ui";
import type { PersonRef } from "@/lib/tasks/facts";
import type { StatusView } from "@/lib/tasks/space-service";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/** The creation, held open so the screen can be read while it is still in flight. */
let answer: (result: { tag?: { id: string; name: string; color: string }; error?: string }) => void = () => undefined;
const createTagAction = vi.fn(
    () => new Promise<{ tag?: { id: string; name: string; color: string }; error?: string }>((resolve) => {
        answer = resolve;
    })
);
const createTaskAction = vi.fn(async () => ({ id: "task1" }));

vi.mock("@/app/(app)/tasks/actions", () => ({
    createTagAction: (spaceId: string, name: string, color: string) => createTagAction(spaceId, name, color),
    createTaskAction: (input: unknown) => createTaskAction(input)
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
    createTaskAction.mockClear();
});

const { TaskCreateDialog } = await import("@/app/(app)/tasks/task-create-dialog");

const STATUSES: StatusView[] = [{ id: "st1", name: "Open", type: "open", color: "#64748b", order: 0 }];
const PEOPLE: PersonRef[] = [{ id: "u1", name: "Ada Lovelace" }];

function dialog() {
    return render(
        <ToastProvider>
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
        </ToastProvider>
    );
}

/** Type a name no tag carries and take the offer to create it. */
async function createTag(name: string) {
    await userEvent.click(screen.getByRole("button", { name: "Tags" }));
    const field = await screen.findByPlaceholderText("Find or create a tag");
    await userEvent.type(field, `${name}{Enter}`);
    await waitFor(() => expect(createTagAction).toHaveBeenCalledWith("s1", name, expect.any(String)));
    await userEvent.keyboard("{Escape}");
}

describe("a tag created from the picker of a task being written", () => {
    it("is on the task before the server has answered", async () => {
        dialog();

        await createTag("urgent");

        // Nothing has come back yet: the chip is the optimistic one.
        expect(screen.getByLabelText("Remove urgent")).toBeDefined();
    });

    it("is written under the id the server gave it, not the one made up for it", async () => {
        dialog();
        await createTag("infra");
        answer({ tag: { id: "tag-real", name: "infra", color: "#3b82f6" } });

        await userEvent.type(screen.getByLabelText("Task name"), "Move the database");
        await userEvent.click(screen.getByRole("button", { name: "Create task" }));

        await waitFor(() => expect(createTaskAction).toHaveBeenCalled());
        expect(createTaskAction.mock.calls[0]?.[0]).toMatchObject({ tagIds: ["tag-real"] });
    });

    it("comes back off the task when the tag is refused, and says so", async () => {
        dialog();
        await createTag("billing");
        answer({ error: "That tag could not be added" });

        await waitFor(() => expect(screen.queryByLabelText("Remove billing")).toBeNull());
        expect(screen.getByText('Could not create "billing"')).toBeDefined();
        expect(screen.getByText("That tag could not be added")).toBeDefined();
    });
});
