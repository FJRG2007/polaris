/**
 * Tasks, drawn in Spanish.
 *
 * What a migration gets wrong without noticing: a count that has to agree with
 * its number, a day or month name that used to be a constant frozen in English,
 * a choice drawn from core's English label map, and a refusal a service wrote
 * that the screen has to say in the reader's words while a log keeps the
 * English.
 */

import { withMessages } from "../../setup/i18n";
import { DISPLAY_DEFAULTS } from "@polaris/core";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersonRef, SpaceContext, TaskRow } from "@/lib/tasks/facts";

vi.mock("@/lib/google-calendar/events-client", () => ({
    useGoogleCalendarEvents: () => ({ status: "unlinked", events: [], error: null })
}));

const { TaskCard } = await import("@/app/(app)/tasks/views/board");
const { CalendarView } = await import("@/app/(app)/tasks/views/calendar");
const { DisplayFormatProvider } = await import("@/components/display-format");
const { optionLabel } = await import("@/app/(app)/tasks/option-label");
const { TaskRefusal, folderMoveRefusal, refusalText } = await import("@/lib/tasks/refusal");
const { translatorFor } = await import("@/lib/i18n/translate");

const ANA: PersonRef = { id: "u1", name: "Ana Ruiz", image: null };

const CONTEXT: SpaceContext = {
    spaceId: "s1",
    statuses: [],
    tags: [],
    fields: [],
    people: [ANA],
    canEdit: true,
    canModerate: true,
    currentUserId: "u1",
    siblings: []
};

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
    return {
        id: "t1",
        reference: "FJRG-1",
        name: "Add backup codes",
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

function card(task: TaskRow): string {
    return renderToStaticMarkup(
        withMessages(
            <TaskCard
                commands={{
                    task,
                    targets: [task],
                    context: CONTEXT,
                    lists: [],
                    canEdit: true,
                    onOpen: () => {},
                    onEdit: () => {},
                    onApply: () => {},
                    onDuplicate: () => {},
                    onDelete: () => {}
                }}
                selected={false}
                positioned
                onSelect={() => {}}
                onDragStart={() => {}}
                onDropAt={() => {}}
            />,
            "es-ES"
        )
    );
}

function calendar(): string {
    return renderToStaticMarkup(
        withMessages(
            <DisplayFormatProvider preferences={{ ...DISPLAY_DEFAULTS, weekStart: "mon" }}>
                <CalendarView
                    rows={[]}
                    groups={[]}
                    context={CONTEXT}
                    canEdit
                    orderable
                    selection={new Set<string>()}
                    selected={[]}
                    lists={[]}
                    onOpen={() => {}}
                    onSelect={() => {}}
                    onMove={() => {}}
                    onQuickCreate={() => {}}
                    onEdit={() => {}}
                    onApply={() => {}}
                    onDuplicate={() => {}}
                    onDelete={() => {}}
                />
            </DisplayFormatProvider>,
            "es-ES"
        )
    );
}

describe("a task card", () => {
    it("names its controls in Spanish", () => {
        const markup = card(taskRow());
        expect(markup).toContain('aria-label="Prioridad"');
        expect(markup).not.toContain('aria-label="Priority"');
    });

    it("agrees a count with its number", () => {
        expect(card(taskRow({ subtaskCount: 1, commentCount: 1 }))).toContain('title="1 subtarea"');
        expect(card(taskRow({ subtaskCount: 3, commentCount: 1 }))).toContain('title="3 subtareas"');
        expect(card(taskRow({ subtaskCount: 1, commentCount: 1 }))).toContain('title="1 comentario"');
    });
});

describe("the calendar", () => {
    it("draws the days of the week in Spanish, from the day the account chose", () => {
        const markup = calendar();
        const week = [...markup.matchAll(/>(lun|mar|mié|jue|vie|sáb|dom)</g)].map((match) => match[1]);
        expect(week.slice(0, 7)).toEqual(["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]);
        expect(markup).not.toMatch(/>(Mon|Tue|Sun)</);
    });

    it("names the month it is showing in Spanish", () => {
        const month = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric" }).format(new Date());
        expect(calendar()).toContain(`>${month}<`);
    });
});

describe("a choice core only knows in English", () => {
    const t = translatorFor("es-ES", "tasks");

    it("is shown in Spanish", () => {
        expect(optionLabel(t, "priority", "urgent")).toBe("Urgente");
        expect(optionLabel(t, "priority", "none")).toBe("Sin prioridad");
    });
});

describe("a refusal from the tasks service", () => {
    const t = translatorFor("es-ES", "tasks");

    it("is said in Spanish on the screen and kept in English for a log", () => {
        const refusal = new TaskRefusal("refusals.listGone");
        expect(refusal.message).toBe("That list no longer exists");
        expect(refusalText(t, refusal)).toBe("Esa lista ya no existe");
    });

    it("fills in what it names", () => {
        const refusal = folderMoveRefusal("too deep", 4);
        expect(refusalText(t, refusal)).toContain("4");
        expect(refusalText(t, refusal)).not.toBe(refusal.message);
    });

    it("leaves anything that is not one alone", () => {
        expect(refusalText(t, new Error("socket hang up"))).toBeNull();
    });
});
