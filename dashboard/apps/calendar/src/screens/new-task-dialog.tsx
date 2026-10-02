"use client";

/**
 * "New task due here": a task in the Tasks app, due at the day or time the
 * menu was opened on, assigned to the reader so it shows on their calendar.
 *
 * A name and a list are all it asks; everything else a task holds is one click
 * away once it exists ("Open" on the note that says it was made).
 */

import Link from "next/link";
import * as time from "./time";
import { FieldRow } from "./ui";
import { useCalendarT } from "./i18n";
import { Loader2 } from "lucide-react";
import type { GridMoment } from "./grid-view";
import * as taskActions from "../actions/tasks";
import { useEffect, useId, useState } from "react";
import type { TaskListOption } from "../actions/tasks";
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
    onCreated: (task: { taskId: string; reference: string }) => void;
}) {
    const t = useCalendarT();
    const ids = useId();
    const open = at !== null;
    const { lists, error: listsError, refresh } = useTaskLists(open);
    const [name, setName] = useState("");
    const [listId, setListId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setName("");
        setError(null);
        setBusy(false);
    }, [open]);

    // The list used last, while it is still one of the choices; else the first.
    useEffect(() => {
        if (!lists || lists.length === 0) return;
        setListId((current) => {
            if (lists.some((list) => list.id === current)) return current;
            const last = rememberedList();
            return lists.some((list) => list.id === last) ? last! : lists[0]!.id;
        });
    }, [lists]);

    const trimmed = name.trim();
    const ready = trimmed.length > 0 && listId !== "" && !busy;
    const when = at
        ? at.allDay
            ? time.formatDay(at.day, locale, { dateStyle: "full" })
            : time.formatInstant(at.at, locale, zone, { dateStyle: "full", timeStyle: "short" })
        : "";

    async function create(): Promise<void> {
        if (!at || !ready) return;
        setBusy(true);
        setError(null);
        try {
            const created = await unwrap(
                () =>
                    taskActions.createDueTaskAction({
                        listId,
                        name: trimmed,
                        due: { at: at.at.toISOString(), timed: !at.allDay }
                    }),
                t("screen.failed")
            );
            rememberList(listId);
            onCreated(created);
            onClose();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : t("screen.failed"));
            // A list that went away is read again, so the choice stays true.
            dropCached("task-lists");
            refresh();
        } finally {
            setBusy(false);
        }
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
                {lists === undefined ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                        {t("newTask.loading")}
                    </div>
                ) : lists === null ? (
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
                ) : lists.length === 0 ? (
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
                ) : (
                    <form
                        noValidate
                        className="flex flex-col gap-3"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void create();
                        }}
                    >
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
                        <FieldRow label={`${t("newTask.list")} *`} htmlFor={`${ids}-list`}>
                            <Select
                                id={`${ids}-list`}
                                aria-label={t("newTask.list")}
                                value={listId}
                                onValueChange={setListId}
                                options={lists.map((list) => ({
                                    value: list.id,
                                    label: `${list.spaceName} / ${list.name}`
                                }))}
                            />
                        </FieldRow>
                        {error ? (
                            <p role="alert" className="text-xs text-danger">
                                {error}
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
                                {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                                {t("newTask.create")}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
