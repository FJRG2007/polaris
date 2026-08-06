/**
 * The board's columns: what may be done to one, and where a dragged one lands.
 *
 * The arithmetic of the drag is a pure function, so it is tested directly - the
 * two directions read differently to whoever is dragging, and getting them the
 * same way round is the whole feature. The rest is rendered, because the point
 * of the affordances is that they appear on a column somebody may change and on
 * nothing else.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import type { ViewProps } from "@/app/(app)/tasks/views/shared";
import { DisplayFormatProvider } from "@/components/display-format";
import { DISPLAY_DEFAULTS, type TaskGroupField } from "@polaris/core";
import { BoardView, reorderColumns } from "@/app/(app)/tasks/views/board";

const CONTEXT: SpaceContext = {
    spaceId: "s1",
    statuses: [
        { id: "st1", name: "Open", type: "open", color: "#64748b", order: 1 },
        { id: "st2", name: "Done", type: "done", color: "#22c55e", order: 2 }
    ],
    tags: [],
    fields: [],
    people: [],
    canEdit: true,
    canModerate: true,
    currentUserId: "u1",
    siblings: []
};

const GROUPS: ViewProps["groups"] = [
    { key: "st1", label: "Open", color: "#64748b", tasks: [] as TaskRow[] },
    { key: "st2", label: "Done", color: "#22c55e", tasks: [] as TaskRow[] },
    { key: "", label: "No status", tasks: [] as TaskRow[] }
];

function props(overrides: Partial<ViewProps> = {}): ViewProps {
    return {
        rows: [],
        groups: GROUPS,
        context: CONTEXT,
        canEdit: true,
        orderable: true,
        selection: new Set<string>(),
        selected: [],
        lists: [],
        groupBy: "status",
        onOpen: () => {},
        onSelect: () => {},
        onMove: () => {},
        onQuickCreate: () => {},
        onEdit: () => {},
        onApply: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
        ...overrides
    };
}

function render(overrides: Partial<ViewProps> = {}): string {
    return renderToStaticMarkup(
        <DisplayFormatProvider preferences={DISPLAY_DEFAULTS}>
            <BoardView {...props(overrides)} />
        </DisplayFormatProvider>
    );
}

/** A board whose columns may be reshaped, removed and reordered. */
const MANAGED: Partial<ViewProps> = {
    onCreateStatus: async () => null,
    onUpdateStatus: async () => true,
    onDeleteStatus: async () => true,
    onReorderStatuses: async () => true
};

describe("reordering columns", () => {
    it("puts a column dragged leftwards before the one it landed on", () => {
        expect(reorderColumns(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    });

    it("gives a column dragged rightwards the place of the one it landed on", () => {
        expect(reorderColumns(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
    });

    it("leaves the order alone when either end of the drag is not a column", () => {
        expect(reorderColumns(["a", "b"], "a", "a")).toEqual(["a", "b"]);
        expect(reorderColumns(["a", "b"], "z", "a")).toEqual(["a", "b"]);
        expect(reorderColumns(["a", "b"], "a", "z")).toEqual(["a", "b"]);
    });
});

describe("the board's column affordances", () => {
    it("offers no way to change a column to somebody who may not", () => {
        const markup = render();
        expect(markup).not.toContain("Column options");
        expect(markup).not.toContain("New column");
        expect(markup).not.toContain('draggable="true"');
    });

    it("offers them on every real column, and on the pile with no status on none", () => {
        const markup = render(MANAGED);
        expect(markup).toContain('aria-label="Column options for Open"');
        expect(markup).toContain('aria-label="Column options for Done"');
        expect(markup).not.toContain("Column options for No status");
        expect(markup).toContain("New column");
    });

    it("only lets the columns that are statuses be dragged", () => {
        const markup = render(MANAGED);
        // The two status headers, and not the one the unset pile draws. No task
        // is on this board, so nothing else here is draggable.
        expect([...markup.matchAll(/draggable="true"/g)]).toHaveLength(2);
    });

    it("says nothing about columns when they are not the space's statuses", () => {
        // Grouped by assignee, "edit this column" would mean editing a person.
        const markup = render({ ...MANAGED, groupBy: "assignee" as TaskGroupField });
        expect(markup).not.toContain("Column options");
        expect(markup).not.toContain("New column");
        expect(markup).not.toContain('draggable="true"');
    });
});
