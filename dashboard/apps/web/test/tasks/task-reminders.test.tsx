// @vitest-environment jsdom

/**
 * "Remind me" on a task, from its header.
 *
 * A preset sets a reminder for the moment it names; the reminders still waiting
 * are listed when the menu opens, and one is called off from there - put back
 * when the server refuses, so the list never claims a reminder is gone that will
 * still go off.
 */

import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const TASK = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const REMINDER = "019f8506-21f4-7173-a097-47c1fe63a88b";

const addReminderAction = vi.fn(async () => ({}) as { error?: string });
const deleteReminderAction = vi.fn(async () => ({}) as { error?: string });
const taskRemindersAction = vi.fn(async () => ({
    reminders: [{ id: REMINDER, remindAt: "2030-01-02T09:00:00.000Z" }]
}));

vi.mock("@/app/(app)/tasks/actions", () => ({
    addReminderAction: (...args: unknown[]) => addReminderAction(...(args as [])),
    deleteReminderAction: (...args: unknown[]) => deleteReminderAction(...(args as [])),
    taskRemindersAction: (...args: unknown[]) => taskRemindersAction(...(args as []))
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

afterEach(() => {
    cleanup();
    addReminderAction.mockClear();
    deleteReminderAction.mockClear();
    taskRemindersAction.mockClear();
});

const { TaskReminderButton } = await import("@/app/(app)/tasks/task-reminders");

function button() {
    return render(
        <ToastProvider>
            <TaskReminderButton taskId={TASK} />
        </ToastProvider>,
        { wrapper: MessagesWrapper }
    );
}

describe("remind me on a task", () => {
    it("sets a reminder for the moment the preset names", async () => {
        const user = userEvent.setup();
        button();
        const before = Date.now();
        await user.click(screen.getByRole("button", { name: "Remind me" }));
        await user.click(await screen.findByRole("menuitem", { name: "In 1 hour" }));
        expect(addReminderAction).toHaveBeenCalledTimes(1);
        const [taskId, at] = addReminderAction.mock.calls[0] as unknown as [string, string];
        expect(taskId).toBe(TASK);
        const offset = new Date(at).getTime() - before;
        expect(offset).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
        expect(offset).toBeLessThan(60 * 60 * 1000 + 60 * 1000);
    });

    it("lists what is still waiting and calls one off", async () => {
        const user = userEvent.setup();
        button();
        await user.click(screen.getByRole("button", { name: "Remind me" }));
        const row = await screen.findByRole("menuitem", { name: /^Call off the reminder/ });
        await user.click(row);
        expect(deleteReminderAction).toHaveBeenCalledWith(REMINDER);
        await waitFor(() =>
            expect(screen.queryByRole("menuitem", { name: /^Call off the reminder/ })).toBeNull()
        );
    });

    it("puts a reminder back when the server would not call it off", async () => {
        deleteReminderAction.mockResolvedValueOnce({ error: "Could not call off the reminder" });
        const user = userEvent.setup();
        button();
        await user.click(screen.getByRole("button", { name: "Remind me" }));
        await user.click(await screen.findByRole("menuitem", { name: /^Call off the reminder/ }));
        expect(
            await screen.findByRole("menuitem", { name: /^Call off the reminder/ })
        ).toBeTruthy();
    });
});
