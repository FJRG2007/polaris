"use client";

/**
 * Subtasks as the list and the board show them: under their parent, never as
 * work of their own beside it.
 *
 * A subtask belongs to whatever its parent belongs to. Counted on its own it
 * makes a column look twice as full as it is, and drawn on its own it is the
 * same piece of work twice on one screen. So a subtask whose parent is on the
 * screen is pulled out of every group and hung under that parent instead,
 * whatever status, person or tag it would have been grouped by. One whose
 * parent is not here - filtered out, assigned to somebody else, in a list the
 * reader cannot see - stays where it was, because hiding it would hide the work.
 */

import type * as core from "@polaris/core";
import type { TaskRow } from "@/lib/tasks/facts";
import { useCallback, useEffect, useState } from "react";

export type SubtaskMode = core.TaskSubtaskMode;

/** The subtasks under each parent on screen, in the order the screen sorted them. */
export type SubtaskIndex = ReadonlyMap<string, readonly TaskRow[]>;

export interface NestedGroups<G extends { readonly tasks: readonly TaskRow[] }> {
    readonly groups: G[];
    readonly children: SubtaskIndex;
}

/**
 * Hang every subtask whose parent is on screen under that parent.
 *
 * `keepEmpty` keeps a group that only held subtasks: a status column is the
 * space's own and stays on the board empty, while a group made of a person or a
 * tag is only a slice of the data and is dropped once nothing is left in it.
 */
export function nestSubtasks<G extends { readonly tasks: readonly TaskRow[] }>(
    groups: readonly G[],
    mode: SubtaskMode,
    keepEmpty: boolean
): NestedGroups<G> {
    if (mode === "separate") return { groups: [...groups], children: new Map() };

    const onScreen = new Set(groups.flatMap((group) => group.tasks.map((task) => task.id)));
    const nested = (task: TaskRow) => task.parentId !== null && onScreen.has(task.parentId);

    const children = new Map<string, TaskRow[]>();
    const seen = new Set<string>();
    for (const group of groups) {
        for (const task of group.tasks) {
            // A task can sit in several groups at once - two assignees, two tags -
            // and is still one subtask of its parent.
            if (!nested(task) || seen.has(task.id)) continue;
            seen.add(task.id);
            const parentId = task.parentId as string;
            const siblings = children.get(parentId);
            if (siblings) siblings.push(task);
            else children.set(parentId, [task]);
        }
    }

    const kept: G[] = [];
    for (const group of groups) {
        const roots = group.tasks.filter((task) => !nested(task));
        if (roots.length === 0 && group.tasks.length > 0 && !keepEmpty) continue;
        kept.push(roots.length === group.tasks.length ? group : { ...group, tasks: roots });
    }
    return { groups: kept, children };
}

/**
 * Every row under a parent, however deep, in the order they are drawn: a
 * subtask's own subtasks come straight after it.
 */
export function descendants(
    parentId: string,
    children: SubtaskIndex,
    isOpen: (taskId: string) => boolean,
    depth = 1
): { task: TaskRow; depth: number }[] {
    const rows: { task: TaskRow; depth: number }[] = [];
    // Bounded, so a cycle in bad data cannot hang the screen.
    if (depth > 8) return rows;
    for (const child of children.get(parentId) ?? []) {
        rows.push({ task: child, depth });
        if (isOpen(child.id)) rows.push(...descendants(child.id, children, isOpen, depth + 1));
    }
    return rows;
}

/**
 * Which parents this reader opened or closed by hand, kept in their browser.
 *
 * Stored as exceptions to the mode rather than as a list of open parents, so
 * "expanded" opens everything without writing every id down, and switching the
 * mode starts over from it. Capped, because it only ever grows otherwise.
 */
const OPEN_KEY = "polaris.tasks.subtasks.open";
const OPEN_MAX = 500;

function readOpen(): Record<string, boolean> {
    try {
        const raw = window.localStorage.getItem(OPEN_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return Object.fromEntries(
            Object.entries(parsed).filter(
                (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
            )
        );
    } catch {
        return {};
    }
}

function writeOpen(open: Record<string, boolean>): void {
    try {
        const entries = Object.entries(open).slice(-OPEN_MAX);
        window.localStorage.setItem(OPEN_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
        // Private browsing or a full quota: the carets hold for this visit only.
    }
}

/** What the list and the board are handed about subtasks. */
export interface SubtaskView {
    readonly mode: SubtaskMode;
    readonly children: SubtaskIndex;
    readonly isOpen: (taskId: string) => boolean;
    readonly toggle: (taskId: string) => void;
}

/**
 * Whether a parent's subtasks are showing, the caret that changes it, and the
 * reset a new mode starts from - "expanded" has to mean every parent, including
 * the ones somebody closed by hand an hour ago.
 */
export function useOpenParents(mode: SubtaskMode): {
    isOpen: (taskId: string) => boolean;
    toggle: (taskId: string) => void;
    reset: () => void;
} {
    // Read after mount: the server has no localStorage.
    const [open, setOpen] = useState<Record<string, boolean>>({});
    useEffect(() => setOpen(readOpen()), []);

    const isOpen = useCallback(
        (taskId: string) => open[taskId] ?? mode === "expanded",
        [open, mode]
    );
    const toggle = useCallback(
        (taskId: string) =>
            setOpen((current) => {
                const { [taskId]: _previous, ...rest } = current;
                const next = { ...rest, [taskId]: !(current[taskId] ?? mode === "expanded") };
                writeOpen(next);
                return next;
            }),
        [mode]
    );
    const reset = useCallback(() => {
        setOpen({});
        writeOpen({});
    }, []);
    return { isOpen, toggle, reset };
}
