// @vitest-environment jsdom

/**
 * Closing a task does not lose what was just written into it.
 *
 * The report this exists for: type a description, reach straight for the X, and the
 * text was gone - the write had not been made yet, and the panel was already off the
 * screen. So what is proven here is the whole path rather than the pieces: the panel
 * stays open while the write is in flight, the write carries what was on the screen,
 * and a write the server refuses keeps the panel - and the text in it - where it is.
 */

import userEvent from "@testing-library/user-event";
import { TaskPanel } from "@/app/(app)/tasks/task-panel";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/tasks/actions", () => ({
    getTaskDetailAction: vi.fn(),
    updateTaskAction: vi.fn(),
    setCustomValueAction: vi.fn(async () => ({})),
    setWatchingAction: vi.fn(async () => ({})),
    duplicateTaskAction: vi.fn(async () => ({})),
    deleteTaskAction: vi.fn(async () => ({})),
    createTagAction: vi.fn(async () => ({}))
}));

// The description is a TipTap surface, and what the panel depends on is its two
// callbacks rather than its editing. A textarea reports the same two.
vi.mock("@/components/rich-text/rich-text-editor", () => ({
    RichTextEditor: ({
        value,
        onChange,
        onBlur
    }: {
        value: string;
        onChange?: (markdown: string) => void;
        onBlur?: (markdown: string) => void;
    }) => (
        <textarea
            aria-label="Description"
            defaultValue={value}
            onChange={(event) => onChange?.(event.target.value)}
            onBlur={(event) => onBlur?.(event.target.value)}
        />
    )
}));

// The thread and the timer are a screen of their own, and none of what is proven
// here goes through them.
vi.mock("@/app/(app)/tasks/task-conversation", () => ({
    ActivityStream: () => <aside />,
    TimeSection: () => <section />,
    Composer: () => <div />,
    TimerControl: () => <div />
}));

import * as actions from "@/app/(app)/tasks/actions";

const CONTEXT: SpaceContext = {
    spaceId: "s1",
    statuses: [{ id: "st1", name: "Open", color: "#64748b", type: "open" }],
    tags: [],
    fields: [],
    people: [{ id: "u1", name: "Ana Ruiz", image: null }],
    canEdit: true,
    canModerate: true,
    currentUserId: "u1",
    siblings: []
} as unknown as SpaceContext;

const TASK = {
    id: "t1",
    reference: "FJRG-1",
    name: "Add backup codes",
    description: "",
    spaceId: "s1",
    listId: "l1",
    statusId: "st1",
    statusName: "Open",
    statusColor: "#64748b",
    statusType: "open",
    priority: "none",
    assignees: [],
    tags: [],
    startDate: null,
    dueDate: null,
    timed: false,
    timeEstimate: null,
    trackedSeconds: 0,
    points: null,
    milestone: false,
    archived: false,
    recurring: false,
    blockedUntil: null,
    blockedNote: "",
    customValues: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
} as unknown as TaskRow;

const DETAIL = {
    task: TASK,
    subtasks: [],
    watchers: [],
    checklists: [],
    comments: [],
    dependencies: [],
    activity: [],
    timeEntries: [],
    attachments: [],
    commits: [],
    recurrence: null,
    parent: null
};

/** A write the test answers when it chooses, so the panel can be caught mid-save. */
function heldOpen() {
    let answer: (result: { error?: string }) => void = () => undefined;
    const server = new Promise<{ error?: string }>((resolve) => {
        answer = resolve;
    });
    return { server, taken: () => answer({}), refused: () => answer({ error: "Could not save the task" }) };
}

beforeEach(() => {
    vi.mocked(actions.getTaskDetailAction).mockResolvedValue({ detail: DETAIL } as never);
    vi.mocked(actions.updateTaskAction).mockResolvedValue({});
});

afterEach(async () => {
    cleanup();
    // The panel writes anything still held when it is torn off the page, and that
    // write must land before the next test starts counting.
    await new Promise((settled) => setTimeout(settled, 0));
    vi.clearAllMocks();
});

/** Open the panel and wait for the task to arrive in it. */
async function openPanel(onClose = vi.fn()) {
    render(<TaskPanel taskId="t1" context={CONTEXT} onClose={onClose} onChanged={() => {}} />);
    await screen.findByDisplayValue("Add backup codes");
    return onClose;
}

describe("closing a task that was just edited", () => {
    it("writes the description and waits for it before the panel goes", async () => {
        const user = userEvent.setup();
        const write = heldOpen();
        vi.mocked(actions.updateTaskAction).mockReturnValue(write.server);
        const onClose = await openPanel();

        // Typed, and then the X on the next breath - no blur, no pause, which is
        // the report this is about.
        await user.type(screen.getByLabelText("Description"), "Rotate them every 90 days");
        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(actions.updateTaskAction).toHaveBeenCalledWith({
            taskId: "t1",
            description: "Rotate them every 90 days"
        });
        expect(onClose).not.toHaveBeenCalled();

        write.taken();
        await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("stays open with the text still in it when the write is refused", async () => {
        const user = userEvent.setup();
        vi.mocked(actions.updateTaskAction).mockResolvedValue({ error: "Could not save the task" });
        const onClose = await openPanel();

        await user.type(screen.getByLabelText("Description"), "Rotate them every 90 days");
        await user.click(screen.getByRole("button", { name: "Close" }));

        await screen.findByText("Could not save the task");
        expect(onClose).not.toHaveBeenCalled();
        expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
            "Rotate them every 90 days"
        );

        // And the edit is still an edit: closing again sends it rather than dropping it.
        vi.mocked(actions.updateTaskAction).mockResolvedValue({});
        await user.click(screen.getByRole("button", { name: "Close" }));
        await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("closes straight away when there was nothing to save", async () => {
        const user = userEvent.setup();
        const onClose = await openPanel();

        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(actions.updateTaskAction).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("writes a name that was typed but never blurred", async () => {
        const user = userEvent.setup();
        const onClose = await openPanel();

        await user.type(screen.getByLabelText("Task name"), " and a recovery kit");
        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(actions.updateTaskAction).toHaveBeenCalledWith({
            taskId: "t1",
            name: "Add backup codes and a recovery kit"
        });
        await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    });
});
