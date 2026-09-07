// @vitest-environment jsdom

/**
 * A task somebody is writing survives the screen going away underneath it.
 *
 * The dialog used to write its draft down only when it was dismissed and the
 * question was answered, which covered exactly one of the ways this work goes
 * missing. Every other way is silent: the tab is closed, the browser falls over,
 * or the screen re-renders and takes the dialog with it - which is what creating
 * a tag from the picker did, because the write behind it revalidated the layout
 * these screens are drawn under.
 *
 * So the draft is written as it is typed, and what is asserted here is the
 * guarantee rather than any one cause of the loss: a dialog rebuilt from nothing
 * comes back holding what was in it, including the tag that was just made.
 */

import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@polaris/ui";
import type { PersonRef } from "@/lib/tasks/facts";
import type { StatusView } from "@/lib/tasks/space-service";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// As the sibling tag test does: the comment box reaches Chat's own actions, and
// that module reads Polaris' configuration as it is imported.
vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

const createTagAction = vi.fn(async (_spaceId: string, name: string, color: string) => ({
    tag: { id: `real-${name}`, name, color }
}));
const createTaskAction = vi.fn(async () => ({ id: "task1" }));

vi.mock("@/app/(app)/tasks/actions", () => ({
    createTagAction: (spaceId: string, name: string, color: string) => createTagAction(spaceId, name, color),
    createTaskAction: (input: unknown) => createTaskAction(input)
}));
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));

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

/** The browser storage the draft lives in. This environment does not ship one. */
function browserStorage() {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        writable: true,
        value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, String(value)),
            removeItem: (key: string) => void values.delete(key),
            clear: () => values.clear(),
            key: (index: number) => [...values.keys()][index] ?? null,
            get length() {
                return values.size;
            }
        }
    });
}

beforeEach(() => {
    browserStorage();
});

afterEach(() => {
    cleanup();
    createTagAction.mockClear();
    createTaskAction.mockClear();
});

const { TaskCreateDialog } = await import("@/app/(app)/tasks/task-create-dialog");

const STATUSES: StatusView[] = [{ id: "st1", name: "Open", type: "open", color: "#64748b", order: 0 }];
const PEOPLE: PersonRef[] = [{ id: "u1", name: "Ada Lovelace" }];
const KEY = "polaris:task-draft:l1";

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

/** What the browser has put down for this list, if anything. */
function stored(): { name?: string; tagIds?: string[] } | null {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as { name?: string; tagIds?: string[] }) : null;
}

/** Type a name no tag carries and take the offer to create it. */
async function createTag(name: string) {
    await userEvent.click(screen.getByRole("button", { name: "Tags" }));
    const field = await screen.findByPlaceholderText("Find or create a tag");
    await userEvent.type(field, `${name}{Enter}`);
    await waitFor(() => expect(createTagAction).toHaveBeenCalledWith("s1", name, expect.any(String)));
    await userEvent.keyboard("{Escape}");
}

describe("a task being written", () => {
    it("is written down as it is typed, without being asked", async () => {
        dialog();
        await userEvent.type(screen.getByLabelText("Task name"), "Move the database");

        await waitFor(() => expect(stored()?.name).toBe("Move the database"));
    });

    it("comes back when the dialog is rebuilt from nothing", async () => {
        const first = dialog();
        await userEvent.type(screen.getByLabelText("Task name"), "Move the database");
        await createTag("infra");
        // Under the server's own id, so it still names a tag in a browser that
        // never saw the one this one invented.
        await waitFor(() => expect(stored()?.tagIds).toEqual(["real-infra"]));

        first.unmount();
        dialog();

        await waitFor(() =>
            expect(screen.getByLabelText("Task name")).toHaveProperty("value", "Move the database")
        );
        expect(screen.getByLabelText("Remove infra")).toBeDefined();
        expect(screen.getByText("Picked up where you left off.")).toBeDefined();
    });

    it("is let go of once the task exists", async () => {
        dialog();
        await userEvent.type(screen.getByLabelText("Task name"), "Rotate the keys");
        await waitFor(() => expect(stored()).not.toBeNull());

        await userEvent.click(screen.getByRole("button", { name: "Create task" }));

        await waitFor(() => expect(createTaskAction).toHaveBeenCalled());
        expect(stored()).toBeNull();
    });

    it("moves with the list it is filed under", async () => {
        window.localStorage.setItem(
            KEY,
            JSON.stringify({ name: "Old draft", description: "", listId: "l1", at: Date.now() })
        );
        dialog();
        await waitFor(() => expect(screen.getByText("Picked up where you left off.")).toBeDefined());

        await userEvent.click(screen.getByRole("button", { name: "Start again" }));
        expect(stored()).toBeNull();
    });
});
