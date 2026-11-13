// @vitest-environment jsdom

/**
 * The dependency picker offers only what is not linked yet.
 *
 * A task already in "Waiting on" kept showing in the search below it, so it
 * could be picked again: the same side did nothing, and the other side was a
 * loop the server refused. Pinned: the task itself and every task linked either
 * way are left out, and the rest still match.
 */

import { withMessages } from "../setup/i18n";
import type { TaskRow } from "@/lib/tasks/facts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DependencyView } from "@/lib/tasks/task-service";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/tasks/actions", () => ({}));

const { DependencySection } = await import("@/app/(app)/tasks/task-subwork");

afterEach(cleanup);

function task(id: string, reference: string): TaskRow {
    return { id, reference, name: `Work ${reference}` } as TaskRow;
}

function edge(taskId: string, reference: string, direction: DependencyView["direction"]): DependencyView {
    return {
        id: `d-${taskId}`,
        type: "blocks",
        direction,
        taskId,
        reference,
        name: `Work ${reference}`,
        statusName: "Open",
        statusColor: "#64748b",
        finished: false
    };
}

describe("the dependency picker", () => {
    it("leaves out the task itself and every task already linked", () => {
        const candidates = [
            task("t1", "FJRG-131"),
            task("t2", "FJRG-132"),
            task("t3", "FJRG-133"),
            task("t4", "FJRG-134")
        ];
        render(
            withMessages(
                <DependencySection
                    taskId="t1"
                    dependencies={[edge("t2", "FJRG-132", "waitingOn"), edge("t3", "FJRG-133", "blocking")]}
                    candidates={candidates}
                    canEdit
                    onOpen={() => {}}
                    onChanged={() => {}}
                    onError={() => {}}
                />
            )
        );
        const search = screen.getByPlaceholderText(/find a task/i);
        fireEvent.change(search, { target: { value: "FJRG-13" } });
        // The picker's list sits right under the search row.
        const picker = search.parentElement?.nextElementSibling;
        const offered = Array.from(picker?.querySelectorAll("button") ?? []).map(
            (button) => button.textContent ?? ""
        );
        expect(offered.some((text) => text.includes("FJRG-134"))).toBe(true);
        for (const taken of ["FJRG-131", "FJRG-132", "FJRG-133"]) {
            expect(offered.some((text) => text.startsWith(taken))).toBe(false);
        }
    });
});
