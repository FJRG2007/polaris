"use client";

/**
 * A task that lives in a calendar (a VTODO from an outside CalDAV calendar):
 * its title, when it is due and whether it is done. Tasks from the Tasks app
 * open in Tasks instead.
 */

import { FieldRow } from "./ui";
import * as engine from "../engine";
import { isDayString } from "./time";
import { useCalendarT } from "./i18n";
import { unwrap } from "./cached-read";
import { RefreshCw } from "lucide-react";
import type { TodoDetail } from "../lib/wire";
import * as taskActions from "../actions/tasks";
import * as eventActions from "../actions/events";
import { useEffect, useId, useMemo, useState } from "react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    useToast
} from "@polaris/ui";

interface TodoForm {
    readonly summary: string;
    readonly dueKind: "none" | "date" | "time";
    readonly dueDate: string;
    readonly dueTime: string;
    readonly status: engine.TodoStatus;
}

function formOf(detail: TodoDetail, zone: string): TodoForm {
    const due = detail.todo.due;
    if (!due)
        return {
            summary: detail.todo.summary,
            dueKind: "none",
            dueDate: "",
            dueTime: "09:00",
            status: detail.todo.status
        };
    if ("date" in due)
        return {
            summary: detail.todo.summary,
            dueKind: "date",
            dueDate: due.date,
            dueTime: "09:00",
            status: detail.todo.status
        };
    const wall = engine.formatWall(engine.instantToWall(engine.valueToInstant(due, zone), zone));
    return {
        summary: detail.todo.summary,
        dueKind: "time",
        dueDate: wall.slice(0, 10),
        dueTime: wall.slice(11, 16),
        status: detail.todo.status
    };
}

function dueOf(form: TodoForm, zone: string): engine.DateValue | null {
    if (form.dueKind === "none") return null;
    if (form.dueKind === "date") return { date: form.dueDate };
    return { dateTime: `${form.dueDate}T${form.dueTime}:00`, tzid: zone };
}

export function TodoEditor({
    objectId,
    zone,
    onClose,
    onChanged
}: {
    objectId: string | null;
    zone: string;
    onClose: () => void;
    onChanged: () => void;
}) {
    const t = useCalendarT();
    const toast = useToast();
    const ids = useId();
    const [detail, setDetail] = useState<TodoDetail | null>(null);
    const [form, setForm] = useState<TodoForm | null>(null);
    const [initial, setInitial] = useState<TodoForm | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [turn, setTurn] = useState(0);

    useEffect(() => {
        setDetail(null);
        setForm(null);
        setFailure(null);
        if (!objectId) return;
        let live = true;
        unwrap(() => eventActions.openTodoAction(objectId), t("screen.failed"))
            .then((answer) => {
                if (!live) return;
                const loaded = formOf(answer.detail, zone);
                setDetail(answer.detail);
                setForm(loaded);
                setInitial(loaded);
            })
            .catch(
                (caught: unknown) =>
                    live && setFailure(caught instanceof Error ? caught.message : String(caught))
            );
        return () => {
            live = false;
        };
    }, [objectId, zone, turn, t]);

    const incomplete =
        !form ||
        form.summary.trim() === "" ||
        (form.dueKind !== "none" && !isDayString(form.dueDate)) ||
        (form.dueKind === "time" && !/^\d{2}:\d{2}$/.test(form.dueTime));
    const dirty = useMemo(
        () =>
            form !== null &&
            initial !== null &&
            JSON.stringify({ ...form, due: dueOf(form, zone) }) !==
                JSON.stringify({ ...initial, due: dueOf(initial, zone) }),
        [form, initial, zone]
    );
    const blocked = !dirty ? t("editor.noChanges") : incomplete ? t("editor.incomplete") : null;

    const save = async () => {
        if (!form || !detail || blocked || busy) return;
        setBusy(true);
        try {
            await unwrap(
                () =>
                    taskActions.saveTodoAction({
                        objectId: detail.objectId,
                        version: detail.version,
                        summary: form.summary.trim(),
                        due: dueOf(form, zone),
                        status: form.status,
                        zone
                    }),
                t("screen.failed")
            );
            toast.show({ key: "calendar-todo-saved", title: t("todo.saved") });
            onChanged();
            onClose();
        } catch (caught) {
            toast.show({
                key: "calendar-todo-failed",
                title: t("todo.saveFailed"),
                body: caught instanceof Error ? caught.message : undefined
            });
        } finally {
            setBusy(false);
        }
    };

    const set = (change: Partial<TodoForm>) => form && setForm({ ...form, ...change });
    const writable = detail?.writable ?? false;

    return (
        <Dialog open={objectId !== null} onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="max-w-md" aria-describedby={undefined}>
                <DialogHeader className="pr-8">
                    <DialogTitle>
                        {writable ? t("todo.editTitle") : t("todo.viewTitle")}
                    </DialogTitle>
                </DialogHeader>
                {failure ? (
                    <div role="alert" className="flex flex-col items-start gap-2">
                        <p className="text-[0.8125rem]">{t("todo.loadFailed")}</p>
                        <p className="text-xs text-muted-foreground">{failure}</p>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setTurn((value) => value + 1)}
                        >
                            <RefreshCw />
                            {t("screen.retry")}
                        </Button>
                    </div>
                ) : !form ? (
                    <div className="flex flex-col gap-2" aria-hidden>
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-2/3" />
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        <FieldRow label={t("todo.title")} htmlFor={`${ids}-title`}>
                            <Input
                                id={`${ids}-title`}
                                value={form.summary}
                                maxLength={500}
                                disabled={!writable}
                                onChange={(event) => set({ summary: event.target.value })}
                            />
                        </FieldRow>
                        <FieldRow label={t("todo.due")}>
                            <div className="flex flex-wrap gap-2">
                                <Select
                                    className="w-36"
                                    aria-label={t("todo.due")}
                                    disabled={!writable}
                                    value={form.dueKind}
                                    onValueChange={(dueKind) =>
                                        set({
                                            dueKind: dueKind as TodoForm["dueKind"],
                                            dueDate:
                                                form.dueDate || engine.localDate(new Date(), zone)
                                        })
                                    }
                                    options={(["none", "date", "time"] as const).map((kind) => ({
                                        value: kind,
                                        label: t(`todo.dueKind.${kind}`)
                                    }))}
                                />
                                {form.dueKind !== "none" ? (
                                    <Input
                                        type="date"
                                        aria-label={t("todo.dueDate")}
                                        className="w-40 tabular-nums"
                                        disabled={!writable}
                                        value={form.dueDate}
                                        onChange={(event) => set({ dueDate: event.target.value })}
                                    />
                                ) : null}
                                {form.dueKind === "time" ? (
                                    <Input
                                        type="time"
                                        aria-label={t("todo.dueTime")}
                                        className="w-28 tabular-nums"
                                        disabled={!writable}
                                        value={form.dueTime}
                                        onChange={(event) => set({ dueTime: event.target.value })}
                                    />
                                ) : null}
                            </div>
                        </FieldRow>
                        <FieldRow label={t("todo.status")}>
                            <Select
                                aria-label={t("todo.status")}
                                disabled={!writable}
                                value={form.status}
                                onValueChange={(status) =>
                                    set({ status: status as engine.TodoStatus })
                                }
                                options={(
                                    [
                                        "NEEDS-ACTION",
                                        "IN-PROCESS",
                                        "COMPLETED",
                                        "CANCELLED"
                                    ] as const
                                ).map((status) => ({
                                    value: status,
                                    label: t(`todo.statusOption.${status}`)
                                }))}
                            />
                        </FieldRow>
                    </div>
                )}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                        {writable ? t("screen.cancel") : t("screen.close")}
                    </Button>
                    {writable ? (
                        <Button
                            aria-disabled={blocked !== null || busy}
                            title={blocked ?? undefined}
                            className={cn(blocked !== null && "opacity-50")}
                            onClick={() => void save()}
                        >
                            {busy ? t("screen.saving") : t("screen.save")}
                        </Button>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
