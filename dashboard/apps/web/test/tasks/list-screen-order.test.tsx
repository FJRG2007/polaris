/**
 * What order a Tasks screen opens in.
 *
 * Manual order only means something once somebody has dragged a card: on a list
 * nobody has arranged by hand it is creation order wearing another name, which
 * puts the most urgent work wherever it happened to be typed. So an unarranged
 * screen opens on priority - and a screen somebody did arrange still opens on
 * the arrangement, because that was a deliberate choice.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SavedView } from "@/lib/tasks/view-service";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";

// The task screen's comment box is the one from Chat, whose emoji picker reaches
// Chat's own server actions - and that module reads Polaris' configuration as it
// is imported. A running server has all of this; a test process has to say so.
vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh() {}, push() {} }),
    usePathname: () => "/tasks/l/l1"
}));
vi.mock("@/app/(app)/tasks/actions", () => ({}));
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));

const { ListScreen } = await import("@/app/(app)/tasks/list-view");

function taskRow(overrides: Partial<TaskRow> & { id: string; name: string }): TaskRow {
    return {
        reference: `FJRG-${overrides.id}`,
        description: "",
        spaceId: "s1",
        spaceName: "Space",
        listId: "l1",
        listName: "List",
        folderName: null,
        parentId: null,
        statusId: "st1",
        statusName: "Open",
        statusColor: "#64748b",
        statusType: "open",
        priority: "none",
        assignees: [],
        tags: [],
        createdById: null,
        startDate: null,
        dueDate: null,
        timed: false,
        timeEstimate: null,
        points: null,
        milestone: false,
        archived: false,
        order: 1,
        sprintId: null,
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        subtaskCount: 0,
        commentCount: 0,
        trackedSeconds: 0,
        blocked: false,
        blockedUntil: null,
        blockedNote: "",
        recurring: false,
        customValues: {},
        ...overrides
    };
}

// Typed in this order, which is the order a list nobody has arranged is in.
const TASKS: readonly TaskRow[] = [
    taskRow({ id: "t1", name: "Rotate the logs", priority: "low", order: 1 }),
    taskRow({ id: "t2", name: "Restore the backups", priority: "urgent", order: 2 }),
    taskRow({ id: "t3", name: "Rename the column", priority: "normal", order: 3 })
];

function context(): SpaceContext {
    return {
        spaceId: "s1",
        statuses: [{ id: "st1", name: "Open", type: "open", color: "#64748b", order: 0 }],
        tags: [],
        fields: [],
        people: [],
        canEdit: true,
        canModerate: false,
        currentUserId: "u1",
        siblings: []
    };
}

function order(markup: string): string[] {
    return TASKS.map((task) => ({ name: task.name, at: markup.indexOf(task.name) }))
        .filter((entry) => entry.at !== -1)
        .sort((left, right) => left.at - right.at)
        .map((entry) => entry.name);
}

function screen(savedViews: readonly SavedView[] = []) {
    return renderToStaticMarkup(
        <ListScreen
            listId="l1"
            defaultListId="l1"
            title="Inbox"
            tasks={TASKS}
            savedViews={savedViews}
            context={context()}
            lists={[{ id: "l1", name: "Inbox", spaceId: "s1" }]}
        />
    );
}

function savedView(sort: SavedView["sort"]): SavedView {
    return {
        id: "v1",
        name: "My order",
        type: "board",
        listId: "l1",
        spaceId: null,
        groupBy: "status",
        sort,
        filter: { match: "all", conditions: [] },
        columns: [],
        showSubtasks: true,
        showClosed: false,
        shared: false,
        ownerId: "u1"
    };
}

describe("what order a list opens in", () => {
    it("puts the most urgent work first when nobody has arranged it", () => {
        expect(order(screen())).toEqual([
            "Restore the backups",
            "Rename the column",
            "Rotate the logs"
        ]);
    });

    it("opens on the arrangement when somebody dragged one into place", () => {
        // A view that says manual was arranged by hand, and the order somebody
        // put the cards in is the one they get back.
        expect(order(screen([savedView({ field: "manual", direction: "asc" })]))).toEqual([
            "Rotate the logs",
            "Restore the backups",
            "Rename the column"
        ]);
    });

    it("opens on whatever else the view was saved with", () => {
        expect(order(screen([savedView({ field: "name", direction: "asc" })]))).toEqual([
            "Rename the column",
            "Restore the backups",
            "Rotate the logs"
        ]);
    });
});
