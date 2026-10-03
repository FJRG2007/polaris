"use client";

/**
 * "New task due here": a task in the Tasks app, due at the day or time the
 * menu was opened on, assigned to the reader so it shows on their calendar.
 *
 * A name and a list are all it asks; everything else a task holds is one click
 * away once it exists ("Open" on the note that says it was made).
 *
 * The same creation backs the "Task" side of the card a click on the grid
 * opens (`event-popover.tsx`): `useTaskCreation` holds the lists, the list
 * chosen and the call, and `TaskListField` draws the list choice and the states
 * around it, so both ask the same way and remember the same list.
 */

import Link from "next/link";
import * as time from "./time";
import { FieldRow } from "./ui";
import { useCalendarT } from "./i18n";
import { Loader2 } from "lucide-react";
import type { GridMoment } from "./grid-view";
import * as taskActions from "../actions/tasks";
import type { TaskListOption } from "../actions/tasks";
import { useEffect, useId, useState, type ReactNode } from "react";
import { cacheKey, dropCached, unwrap, useCachedRead } from "./cached-read";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

/** The lists a task can go into, read when first needed and kept: undefined
 *  while being read, null when the reader cannot create tasks. */
export function useTaskLists(enabled: boolean): {
    lists: TaskListOption[] | null | undefined;
    error: string | null;
    refresh: () => void;
} {
    const t = useCalendarT();
    const read = useCachedRead<{ lists: TaskListOption[] | null }>(
        enabled ? cacheKey("task-lists") : null,
        async () => {
            const answer = await unwrap(() => taskActions.taskListsAction(), t("screen.failed"));
            return { lists: answer.lists };
        }
    );
    return {
        lists: read.data ? read.data.lists : read.error ? null : undefined,
        error: read.error,
        refresh: read.refresh
    };
}

/** Where a new task's list choice is remembered in this browser. */
const LAST_LIST = "polaris.calendar.task-list";

function rememberedList(): string | null {
    try {
        return window.localStorage.getItem(LAST_LIST);
    } catch {
        return null;
    }
}

function rememberList(id: string): void {
    try {
        window.localStorage.setItem(LAST_LIST, id);
    } catch {
        // Only a convenience.
    }
}

/** A task the calendar made, for the note that says so. */
export interface CreatedTask {
    readonly taskId: string;
    readonly reference: string;
}

/** When a task due at `at` is due, as the dialog and the card say it. */
export function dueText(at: GridMoment, locale: string, zone: string): string {
    return at.allDay
        ? time.formatDay(at.day, locale, { dateStyle: "full" })
        : time.formatInstant(at.at, locale, zone, { dateStyle: "full", timeStyle: "short" });
}

/**
 * Making a Tasks task due at a moment of the grid: the lists it can go into
 * (read while `open`), the one chosen - the list used last while it is still a
 * choice, else the first - and the call. A failure is kept to be shown, and the
 * lists are read again in case the chosen one went away.
 */
export function useTaskCreation(open: boolean) {
    const t = useCalendarT();
    const { lists, error: listsError, refresh } = useTaskLists(open);
    const [listId, setListId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!lists || lists.length === 0) return;
        setListId((current) => {
            if (lists.some((list) => list.id === current)) return current;
            const last = rememberedList();
            return lists.some((list) => list.id === last) ? last! : lists[0]!.id;
        });
    }, [lists]);

    /** Whether a task named `name` can be made now. */
    const canCreate = (name: string) => name.trim().length > 0 && listId !== "" && !busy;

    async function create(at: GridMoment, name: string): Promise<CreatedTask | null> {
        if (!canCreate(name)) return null;
        setBusy(true);
        setError(null);
        try {
            const created = await unwrap(
                () =>
                    taskActions.createDueTaskAction({
                        listId,
                        name: name.trim(),
                        due: { at: at.at.toISOString(), timed: !at.allDay }
                    }),
                t("screen.failed")
            );
            rememberList(listId);
            return created;
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : t("screen.failed"));
            dropCached("task-lists");
            refresh();
            return null;
        } finally {
            setBusy(false);
        }
    }

    return {
        lists,
        listsError,
        refresh,
        listId,
        // The select reports "" when its hidden native twin resets (a form
        // event reaching it); no list is called that, so it is never a choice.
        chooseList: (id: string) => {
            if (id) setListId(id);
        },
        busy,
        error,
        clearError: () => setError(null),
        canCreate,
        create
    };
}

export type TaskCreation = ReturnType<typeof useTaskCreation>;

/**
 * The list a new task goes into, and what is said instead while the lists are
 * read, when they cannot be, when the account cannot create tasks, and when it
 * has no list yet. `children` (the rest of the form) is drawn only once there
 * is a list to choose.
 */
export function TaskListField({
    creation,
    id,
    children
}: {
    creation: TaskCreation;
    id: string;
    children?: ReactNode;
}) {
    const t = useCalendarT();
    const { lists, listsError, refresh } = creation;
    if (lists === undefined)
        return (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t("newTask.loading")}
            </div>
        );
    if (lists === null)
        return (
            <div className="flex flex-col items-start gap-2 text-[0.8125rem]">
                <p className="text-muted-foreground">
                    {listsError ? t("newTask.listsFailed") : t("newTask.noTasks")}
                </p>
                {listsError ? (
                    <Button size="sm" variant="outline" onClick={refresh}>
                        {t("screen.retry")}
                    </Button>
                ) : null}
            </div>
        );
    if (lists.length === 0)
        return (
            <p className="text-[0.8125rem] text-muted-foreground">
                {t.rich("newTask.noLists", {
                    tasks: (chunks) => (
                        <Link
                            key="tasks"
                            href="/tasks"
                            className="text-foreground underline underline-offset-2"
                        >
                            {chunks}
                        </Link>
                    )
                })}
            </p>
        );
    return (
        <>
            <FieldRow label={`${t("newTask.list")} *`} htmlFor={id}>
                <Select
                    id={id}
                    aria-label={t("newTask.list")}
                    value={creation.listId}
                    onValueChange={creation.chooseList}
                    options={lists.map((list) => ({
                        value: list.id,
                        label: `${list.spaceName} / ${list.name}`
                    }))}
                />
            </FieldRow>
            {children}
        </>
    );
}

export function NewTaskDialog({
    at,
    zone,
    locale,
    onClose,
    onCreated
}: {
    /** When it is due; null closes the dialog. */
    at: GridMoment | null;
    zone: string;
    locale: string;
    onClose: () => void;
    onCreated: (task: CreatedTask) => void;
}) {
    const t = useCalendarT();
    const ids = useId();
    const open = at !== null;
    const creation = useTaskCreation(open);
    const [name, setName] = useState("");
    const { clearError } = creation;

    useEffect(() => {
        if (!open) return;
        setName("");
        clearError();
        // `clearError` is a fresh function each render; only opening resets.
    }, [open]);

    const ready = creation.canCreate(name);
    const when = at ? dueText(at, locale, zone) : "";

    async function create(): Promise<void> {
        if (!at) return;
        const created = await creation.create(at, name);
        if (!created) return;
        onCreated(created);
        onClose();
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("newTask.title")}</DialogTitle>
                    <DialogDescription className="first-letter:uppercase">
                        {t("newTask.due", { when })}
                    </DialogDescription>
                </DialogHeader>
                <form
                    noValidate
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void create();
                    }}
                >
                    {creation.lists && creation.lists.length > 0 ? (
                        <FieldRow label={`${t("newTask.name")} *`} htmlFor={`${ids}-name`}>
                            <Input
                                id={`${ids}-name`}
                                value={name}
                                maxLength={500}
                                autoFocus
                                placeholder={t("newTask.namePlaceholder")}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </FieldRow>
                    ) : null}
                    <TaskListField creation={creation} id={`${ids}-list`}>
                        {creation.error ? (
                            <p role="alert" className="text-xs text-danger">
                                {creation.error}
                            </p>
                        ) : null}
                        <DialogFooter>
                            <Button type="button" variant="ghost" onClick={onClose}>
                                {t("screen.cancel")}
                            </Button>
                            <Button
                                type="submit"
                                aria-disabled={!ready}
                                className={ready ? undefined : "opacity-50"}
                            >
                                {creation.busy ? (
                                    <Loader2 className="animate-spin" aria-hidden />
                                ) : null}
                                {t("newTask.create")}
                            </Button>
                        </DialogFooter>
                    </TaskListField>
                </form>
            </DialogContent>
        </Dialog>
    );
}
