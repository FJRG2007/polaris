/**
 * A task screen draws what this device wrote and has not sent yet over what
 * the server sent: a change shows as made, and a task made here sits in its
 * list with no reference until the server numbers it.
 */

import { describe, expect, it } from "vitest";
import type { AppWrite } from "@/lib/offline/app-writes";
import type { TaskRow } from "@/lib/tasks/facts";
import { TASK_CREATE, TASK_MOVE, TASK_UPDATE, withQueuedWrites } from "@/app/(app)/tasks/offline-rows";

const directory = {
    statuses: [
        { id: "st-open", name: "To do", color: "#111111", type: "open" },
        { id: "st-done", name: "Done", color: "#222222", type: "done" }
    ],
    people: [],
    tags: []
} as never;
const lists = [{ id: "list-1", name: "Inbox", spaceId: "space-1" }];
const task = { id: "task-1", reference: "ENG-1", name: "Server", spaceId: "space-1", spaceName: "Eng", listId: "list-1", statusId: "st-open", statusName: "To do", statusColor: "#111111", statusType: "open", priority: "none" } as unknown as TaskRow;

const write = (kind: string, target: string, payload: unknown, at = "2026-11-24T10:00:00.000Z"): AppWrite => ({ key: `${kind}-${target}-${at}`, kind, target, payload, state: "pending", attempts: 0, createdAt: at });

describe("tasks with what this device has not sent yet", () => {
    it("leaves the server's tasks alone when nothing waits", () => {
        const tasks = [task];
        expect(withQueuedWrites(tasks, [], directory, lists, "list-1")).toBe(tasks);
    });

    it("draws a waiting change and a waiting move over the task, newest last", () => {
        const [row] = withQueuedWrites(
            [task],
            [
                write(TASK_UPDATE, "task-1", { taskId: "task-1", name: "Mine", priority: "high" }),
                write(TASK_MOVE, "task-1", { taskId: "task-1", statusId: "st-done", beforeId: null, afterId: null }, "2026-11-24T10:01:00.000Z")
            ],
            directory,
            lists,
            "list-1"
        );
        expect(row).toMatchObject({ name: "Mine", priority: "high", statusId: "st-done", statusName: "Done", reference: "ENG-1" });
        expect(row).not.toHaveProperty("beforeId");
    });

    it("puts a task made here in its list with no reference, and only there", () => {
        const made = write(TASK_CREATE, "new-1", { id: "new-1", listId: "list-1", name: "Offline task" });
        const shown = withQueuedWrites([task], [made], directory, lists, "list-1");
        expect(shown.map((row) => row.id)).toEqual(["task-1", "new-1"]);
        expect(shown[1]).toMatchObject({ reference: "", name: "Offline task", statusId: "st-open", spaceName: "Eng" });
        expect(withQueuedWrites([task], [made], directory, lists, "list-2")).toHaveLength(1);
    });

    it("draws the server's row once the made task has arrived", () => {
        const arrived = { ...task, id: "new-1", reference: "ENG-2" };
        const made = write(TASK_CREATE, "new-1", { id: "new-1", listId: "list-1", name: "Offline task" });
        const shown = withQueuedWrites([task, arrived], [made], directory, lists, null);
        expect(shown.filter((row) => row.id === "new-1")).toEqual([arrived]);
    });
});
