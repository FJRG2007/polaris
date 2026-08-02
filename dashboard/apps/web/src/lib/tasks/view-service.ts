/**
 * Saved views: a named way of looking at work.
 *
 * A view is stored settings, not stored results. It records which tasks
 * (filter), arranged how (group, sort, type) and with what shown (columns), and
 * the screen applies those through the same @polaris/core engine the server used
 * to build the page. Storing results instead would make every view a cache with
 * an invalidation problem attached.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

export interface SavedView {
    readonly id: string;
    readonly name: string;
    readonly type: core.TaskViewType;
    readonly listId: string | null;
    readonly spaceId: string | null;
    readonly groupBy: core.TaskGroupField;
    readonly sort: core.TaskSort;
    readonly filter: core.TaskFilter;
    readonly columns: string[];
    readonly showSubtasks: boolean;
    readonly showClosed: boolean;
    readonly shared: boolean;
    readonly ownerId: string;
}

function parseColumns(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

function toView(record: {
    id: string;
    name: string;
    type: string;
    listId: string | null;
    spaceId: string | null;
    groupBy: string;
    sortField: string;
    sortDirection: string;
    filter: string;
    columns: string;
    showSubtasks: boolean;
    showClosed: boolean;
    shared: boolean;
    ownerId: string;
}): SavedView {
    return {
        id: record.id,
        name: record.name,
        type: record.type as core.TaskViewType,
        listId: record.listId,
        spaceId: record.spaceId,
        groupBy: record.groupBy as core.TaskGroupField,
        sort: {
            field: record.sortField as core.TaskSortField,
            direction: record.sortDirection === "desc" ? "desc" : "asc"
        },
        filter: core.parseTaskFilter(record.filter),
        columns: parseColumns(record.columns),
        showSubtasks: record.showSubtasks,
        showClosed: record.showClosed,
        shared: record.shared,
        ownerId: record.ownerId
    };
}

/** The views on a list: everything shared, plus this person's private ones. */
export async function listViews(userId: string, scope: { listId?: string; spaceId?: string }): Promise<SavedView[]> {
    const views = await prisma.taskView.findMany({
        where: {
            ...(scope.listId ? { listId: scope.listId } : {}),
            ...(scope.spaceId ? { spaceId: scope.spaceId } : {}),
            OR: [{ shared: true }, { ownerId: userId }]
        },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }]
    });
    return views.map(toView);
}

export async function getView(viewId: string): Promise<SavedView | null> {
    const view = await prisma.taskView.findUnique({ where: { id: viewId } });
    return view ? toView(view) : null;
}

export async function createView(ownerId: string, input: core.TaskViewInput): Promise<string> {
    const last = await prisma.taskView.findFirst({
        where: { listId: input.listId, spaceId: input.spaceId },
        orderBy: { order: "desc" },
        select: { order: true }
    });
    const view = await prisma.taskView.create({
        data: {
            ownerId,
            listId: input.listId,
            spaceId: input.spaceId,
            name: input.name,
            type: input.type,
            groupBy: input.groupBy,
            sortField: input.sort.field,
            sortDirection: input.sort.direction,
            filter: JSON.stringify(input.filter),
            columns: JSON.stringify(input.columns),
            showSubtasks: input.showSubtasks,
            showClosed: input.showClosed,
            shared: input.shared,
            order: (last?.order ?? 0) + core.ORDER_STEP
        },
        select: { id: true }
    });
    return view.id;
}

/** Save changes to a view. A shared view may only be reshaped by whoever made
 *  it; everybody else's tweaks stay on their screen until they save their own. */
export async function updateView(
    userId: string,
    viewId: string,
    input: core.TaskViewInput,
    canModerate: boolean
): Promise<void> {
    const existing = await prisma.taskView.findUnique({ where: { id: viewId }, select: { ownerId: true } });
    if (!existing) throw new Error("That view no longer exists");
    if (existing.ownerId !== userId && !canModerate) throw new Error("Only the person who made this view can change it");

    await prisma.taskView.update({
        where: { id: viewId },
        data: {
            name: input.name,
            type: input.type,
            groupBy: input.groupBy,
            sortField: input.sort.field,
            sortDirection: input.sort.direction,
            filter: JSON.stringify(input.filter),
            columns: JSON.stringify(input.columns),
            showSubtasks: input.showSubtasks,
            showClosed: input.showClosed,
            shared: input.shared
        }
    });
}

export async function deleteView(userId: string, viewId: string, canModerate: boolean): Promise<void> {
    const deleted = await prisma.taskView.deleteMany({
        where: canModerate ? { id: viewId } : { id: viewId, ownerId: userId }
    });
    if (deleted.count === 0) throw new Error("Only the person who made this view can remove it");
}

/** The view a list opens on: its first shared view, or a board if it has none. */
export function defaultView(views: readonly SavedView[], listId: string | null): SavedView {
    return (
        views[0] ?? {
            id: "",
            name: "Board",
            type: "board",
            listId,
            spaceId: null,
            groupBy: "status",
            sort: { field: "manual", direction: "asc" },
            filter: core.EMPTY_FILTER,
            columns: [],
            showSubtasks: true,
            showClosed: false,
            shared: true,
            ownerId: ""
        }
    );
}
