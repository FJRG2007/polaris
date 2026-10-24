"use client";

/**
 * A record's notes, tasks and files, kept in Polaris's Notes, Tasks and Drive
 * and linked here. Each opens in its own app; a note or task written here is an
 * ordinary one there, and a file stays where it is in Drive. The lists paint from the last answer kept for this record and
 * refresh behind it; a change shows at once and goes back if it is refused.
 */

import Link from "next/link";
import { useCrmT } from "./i18n";
import { messageOf, unwrap } from "./call";
import { formatDay } from "./format";
import { CalendarDays, File as FileIcon, Mail, Plus, Unlink } from "lucide-react";
import * as actions from "../actions/activities";
import { hostUi } from "@polaris/app-host/client";
import type { CrmObject } from "../model/objects";
import { useCallback, useId, useState } from "react";
import { Button, Checkbox, cn, Input, Select, Textarea, useToast, DateInput } from "@polaris/ui";
import * as links from "../model/links";

function Block({ className }: { className?: string }) {
    return <span aria-hidden className={cn("block animate-pulse rounded bg-muted", className)} />;
}

export interface RecordActivitiesProps {
    readonly object: CrmObject;
    readonly id: string;
    /** The reader may change this record, and it is not in the trash. */
    readonly canEdit: boolean;
}

export function RecordActivities({ object, id, canEdit }: RecordActivitiesProps) {
    const t = useCrmT();
    const toast = useToast();
    const load = useCallback(
        () =>
            unwrap(
                () => actions.recordActivitiesAction({ object, id }),
                t("errors.loadFailed")
            ).then((answer) => answer.activities),
        [object, id, t]
    );
    const live = hostUi.liveRead.useLiveRead<links.RecordActivities>({
        cacheKey: `crm:activities:${object}:${id}`,
        load
    });
    const data = live.data;

    /** Show a change at once; put the kept answer back if the server refuses. */
    const change = (next: links.RecordActivities, work: () => Promise<unknown>) => {
        if (!data) return;
        const kept = data;
        live.replace(next);
        work()
            .then(() => live.refresh())
            .catch((caught) => {
                live.replace(kept);
                toast.show({ title: t("errors.notSaved"), body: messageOf(caught) });
            });
    };

    const unlink = (kind: links.LinkKind, targetId: string) => {
        if (!data) return;
        change(
            {
                ...data,
                notes: data.notes?.filter((note) => note.id !== targetId) ?? null,
                tasks: data.tasks?.filter((task) => task.id !== targetId) ?? null,
                files: (data.files ?? []).filter((file) => file.id !== targetId)
            },
            () =>
                unwrap(
                    () => actions.unlinkAction({ object, id, kind, targetId }),
                    t("errors.generic")
                )
        );
    };

    const tick = (task: links.LinkedTask) => {
        if (!data?.tasks) return;
        change(
            {
                ...data,
                tasks: data.tasks.map((one) =>
                    one.id === task.id ? { ...one, done: !one.done } : one
                )
            },
            () =>
                unwrap(
                    () =>
                        actions.setRecordTaskDoneAction({
                            object,
                            id,
                            taskId: task.id,
                            done: !task.done
                        }),
                    t("errors.generic")
                )
        );
    };

    const added = (patch: Partial<links.RecordActivities>) => {
        if (data) live.replace({ ...data, ...patch });
    };

    const [picking, setPicking] = useState(false);
    const attach = async (
        picked: readonly { kind: string; connectionId?: string; path?: string }[]
    ) => {
        setPicking(false);
        const made: links.LinkedFile[] = [];
        for (const one of picked) {
            if (one.kind !== "drive" || !one.connectionId || !one.path) continue;
            try {
                const answer = await unwrap(
                    () =>
                        actions.attachRecordFileAction({
                            object,
                            id,
                            file: { connectionId: one.connectionId, path: one.path }
                        }),
                    t("errors.generic")
                );
                made.push(answer.file);
            } catch (caught) {
                toast.show({ title: t("errors.notSaved"), body: messageOf(caught) });
            }
        }
        if (made.length > 0) live.refresh();
    };

    return (
        <>
            {data?.notes === null ? null : (
                <Section
                    title={t("activities.notes")}
                    count={data?.notes?.length ?? null}
                    adding={
                        canEdit && data && data.noteShelves.length > 0 ? (
                            <NoteForm
                                object={object}
                                id={id}
                                shelves={data.noteShelves}
                                onAdded={(note) => added({ notes: [note, ...(data.notes ?? [])] })}
                            />
                        ) : null
                    }
                >
                    {!data ? (
                        <Block className="mx-3 my-3 h-3 w-40" />
                    ) : (data.notes ?? []).length === 0 ? (
                        <Empty text={t("activities.noNotes")} />
                    ) : (
                        <ul className="flex flex-col gap-1 p-2">
                            {(data.notes ?? []).map((note) => (
                                <NoteRow
                                    key={note.id}
                                    note={note}
                                    onUnlink={canEdit ? () => unlink("note", note.id) : null}
                                />
                            ))}
                        </ul>
                    )}
                </Section>
            )}
            {data?.tasks === null ? null : (
                <Section
                    title={t("activities.tasks")}
                    count={data?.tasks?.length ?? null}
                    adding={
                        canEdit && data && data.taskLists.length > 0 ? (
                            <TaskForm
                                object={object}
                                id={id}
                                lists={data.taskLists}
                                onAdded={(task) => added({ tasks: [task, ...(data.tasks ?? [])] })}
                            />
                        ) : null
                    }
                >
                    {!data ? (
                        <Block className="mx-3 my-3 h-3 w-40" />
                    ) : (data.tasks ?? []).length === 0 ? (
                        <Empty text={t("activities.noTasks")} />
                    ) : (
                        <ul className="flex flex-col gap-1 p-2">
                            {(data.tasks ?? []).map((task) => (
                                <TaskRow
                                    key={task.id}
                                    task={task}
                                    onTick={() => tick(task)}
                                    onUnlink={canEdit ? () => unlink("task", task.id) : null}
                                />
                            ))}
                        </ul>
                    )}
                </Section>
            )}
            <Section
                title={t("activities.files")}
                count={data ? (data.files ?? []).length : null}
                adding={
                    canEdit && data ? (
                        <AddToggle
                            label={t("activities.attachFile")}
                            onClick={() => setPicking(true)}
                        />
                    ) : null
                }
            >
                {!data ? (
                    <Block className="mx-3 my-3 h-3 w-40" />
                ) : (data.files ?? []).length === 0 ? (
                    <Empty text={t("activities.noFiles")} />
                ) : (
                    <ul className="flex flex-col gap-1 p-2">
                        {(data.files ?? []).map((file) => (
                            <FileRow
                                key={file.id}
                                file={file}
                                onUnlink={canEdit ? () => unlink("file", file.id) : null}
                            />
                        ))}
                    </ul>
                )}
            </Section>
            {data?.mail === null ? null : (
                <Section
                    title={t("activities.mail")}
                    count={data?.mail ? data.mail.length : null}
                    adding={null}
                >
                    {!data?.mail ? (
                        <Block className="mx-3 my-3 h-3 w-40" />
                    ) : data.mail.length === 0 ? (
                        <Empty text={t("activities.noMail")} />
                    ) : (
                        <ul className="flex flex-col gap-1 p-2">
                            {data.mail.map((thread) => (
                                <MailRow key={thread.id} thread={thread} />
                            ))}
                        </ul>
                    )}
                </Section>
            )}
            {data?.events === null ? null : (
                <Section
                    title={t("activities.events")}
                    count={data?.events ? data.events.length : null}
                    adding={null}
                >
                    {!data?.events ? (
                        <Block className="mx-3 my-3 h-3 w-40" />
                    ) : data.events.length === 0 ? (
                        <Empty text={t("activities.noEvents")} />
                    ) : (
                        <ul className="flex flex-col gap-1 p-2">
                            {data.events.map((event) => (
                                <EventRow key={event.id} event={event} />
                            ))}
                        </ul>
                    )}
                </Section>
            )}
            {picking ? (
                <hostUi.filePicker.FilePickerDialog
                    storageOnly
                    title={t("activities.attachFile")}
                    onPick={(
                        picked: readonly { kind: string; connectionId?: string; path?: string }[]
                    ) => void attach(picked)}
                    onClose={() => setPicking(false)}
                />
            ) : null}
        </>
    );
}

function FileRow({ file, onUnlink }: { file: links.LinkedFile; onUnlink: (() => void) | null }) {
    return (
        <li className="flex min-w-0 items-center gap-2 px-1">
            <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <a
                href={file.href}
                className="min-w-0 flex-1 truncate rounded py-0.5 text-[0.8125rem] hover:underline"
                title={file.name}
            >
                {file.name}
            </a>
            {onUnlink ? <UnlinkButton onClick={onUnlink} /> : null}
        </li>
    );
}

function MailRow({ thread }: { thread: links.MailWith }) {
    const t = useCrmT();
    const format = hostUi.displayFormat.useDisplayFormat();
    const subject = thread.subject.trim() || t("activities.noSubject");
    const people = thread.participants.map((one) => one.name.trim() || one.address).join(", ");
    return (
        <li className="flex min-w-0 items-start gap-2 px-1">
            <Mail aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
            <a
                href={thread.href}
                className="flex min-w-0 flex-1 flex-col rounded py-0.5 hover:underline"
                title={subject}
            >
                <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{subject}</span>
                    <span className="shrink-0 text-[0.75rem] tabular-nums text-muted-foreground">
                        {format.date(thread.lastMessageAt)}
                    </span>
                </span>
                <span className="truncate text-[0.75rem] text-muted-foreground" title={people}>
                    {thread.messageCount > 1
                        ? t("activities.mailCount", { count: thread.messageCount, people })
                        : people}
                </span>
            </a>
        </li>
    );
}

function EventRow({ event }: { event: links.EventWith }) {
    const t = useCrmT();
    const format = hostUi.displayFormat.useDisplayFormat();
    const summary = event.summary.trim() || t("activities.noSummary");
    const when = !event.startsAt
        ? ""
        : event.allDay
          ? formatDay(event.startsAt.slice(0, 10), format)
          : format.dateTime(event.startsAt);
    return (
        <li className="flex min-w-0 items-start gap-2 px-1">
            <CalendarDays aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
            <a
                href={event.href}
                className="flex min-w-0 flex-1 flex-col rounded py-0.5 hover:underline"
                title={summary}
            >
                <span className="truncate text-[0.8125rem]">{summary}</span>
                <span className="truncate text-[0.75rem] text-muted-foreground">
                    {[when, event.location.trim()].filter(Boolean).join(" - ")}
                </span>
            </a>
        </li>
    );
}

function Section({
    title,
    count,
    adding,
    children
}: {
    title: string;
    count: number | null;
    adding: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section aria-label={title} className="min-w-0 rounded-lg border border-border bg-card">
            <h2 className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-[0.8125rem] font-medium">
                <span className="truncate">{title}</span>
                {count === null ? null : (
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                )}
            </h2>
            {children}
            {adding}
        </section>
    );
}

function Empty({ text }: { text: string }) {
    return <p className="px-3 py-3 text-[0.8125rem] text-muted-foreground">{text}</p>;
}

function UnlinkButton({ onClick }: { onClick: () => void }) {
    const t = useCrmT();
    return (
        <Button
            variant="ghost"
            size="sm"
            className="size-7 shrink-0 p-0"
            onClick={onClick}
            aria-label={t("activities.unlink")}
            title={t("activities.unlink")}
        >
            <Unlink className="size-3.5" />
        </Button>
    );
}

function NoteRow({ note, onUnlink }: { note: links.LinkedNote; onUnlink: (() => void) | null }) {
    return (
        <li className="flex min-w-0 items-start gap-2">
            <Link
                href={`/notes?note=${encodeURIComponent(note.id)}`}
                className="flex min-w-0 flex-1 flex-col rounded px-1 py-0.5 hover:bg-muted/60"
            >
                <span className="truncate text-[0.8125rem]" title={note.title}>
                    {note.title}
                </span>
                {note.excerpt ? (
                    <span className="truncate text-[0.75rem] text-muted-foreground">
                        {note.excerpt}
                    </span>
                ) : null}
            </Link>
            {onUnlink ? <UnlinkButton onClick={onUnlink} /> : null}
        </li>
    );
}

function TaskRow({
    task,
    onTick,
    onUnlink
}: {
    task: links.LinkedTask;
    onTick: () => void;
    onUnlink: (() => void) | null;
}) {
    const t = useCrmT();
    return (
        <li className="flex min-w-0 items-center gap-2 px-1">
            <Checkbox
                checked={task.done}
                onChange={onTick}
                aria-label={t("activities.done", { name: task.name })}
            />
            <Link
                href={`/tasks/t/${encodeURIComponent(task.id)}`}
                className={cn(
                    "min-w-0 flex-1 truncate rounded py-0.5 text-[0.8125rem] hover:underline",
                    task.done && "text-muted-foreground line-through"
                )}
                title={`${task.reference} ${task.name}`}
            >
                {task.name}
            </Link>
            {task.due ? (
                <span className="shrink-0 text-[0.75rem] tabular-nums text-muted-foreground">
                    {task.due.slice(0, 10)}
                </span>
            ) : null}
            {onUnlink ? <UnlinkButton onClick={onUnlink} /> : null}
        </li>
    );
}

function AddToggle({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <div className="border-t border-border p-1.5">
            <Button variant="ghost" size="sm" onClick={onClick}>
                <Plus className="size-4" />
                {label}
            </Button>
        </div>
    );
}

/** Send a new note or task; on success hand it up and close, on refusal say why. */
function useSubmit<T>(send: () => Promise<T>, onDone: (made: T) => void) {
    const t = useCrmT();
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const submit = () => {
        if (busy) return;
        setBusy(true);
        send()
            .then(onDone)
            .catch((caught) => toast.show({ title: t("errors.notSaved"), body: messageOf(caught) }))
            .finally(() => setBusy(false));
    };
    return { busy, submit };
}

function NoteForm({
    object,
    id,
    shelves,
    onAdded
}: {
    object: CrmObject;
    id: string;
    shelves: links.RecordActivities["noteShelves"];
    onAdded: (note: links.LinkedNote) => void;
}) {
    const t = useCrmT();
    const field = useId();
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [shelf, setShelf] = useState<string>(shelves[0]?.id ?? "");
    const note = { title, body, spaceId: shelf || null };
    const valid = links.newNoteSchema.safeParse(note).success;
    const { busy, submit } = useSubmit(
        () =>
            unwrap(() => actions.createRecordNoteAction({ object, id, note }), t("errors.generic")),
        (answer) => {
            onAdded(answer.note);
            setTitle("");
            setBody("");
            setOpen(false);
        }
    );
    if (!open) return <AddToggle label={t("activities.addNote")} onClick={() => setOpen(true)} />;
    return (
        <form
            className="flex flex-col gap-2 border-t border-border p-2"
            onSubmit={(event) => {
                event.preventDefault();
                if (valid) submit();
            }}
        >
            <Input
                aria-label={`${t("activities.noteTitle")} *`}
                placeholder={t("activities.noteTitle")}
                value={title}
                maxLength={links.NOTE_TITLE_MAX}
                autoFocus
                onChange={(event) => setTitle(event.target.value)}
            />
            <Textarea
                aria-label={t("activities.noteBody")}
                placeholder={t("activities.noteBody")}
                value={body}
                maxLength={links.NOTE_BODY_MAX}
                rows={3}
                onChange={(event) => setBody(event.target.value)}
            />
            {shelves.length > 1 ? (
                <Select
                    id={field}
                    aria-label={t("activities.noteShelf")}
                    value={shelf}
                    onValueChange={setShelf}
                    options={shelves.map((one) => ({
                        value: one.id ?? "",
                        label: one.id ? one.name : t("activities.myNotes")
                    }))}
                />
            ) : null}
            <FormButtons busy={busy} valid={valid} onCancel={() => setOpen(false)} />
        </form>
    );
}

function TaskForm({
    object,
    id,
    lists,
    onAdded
}: {
    object: CrmObject;
    id: string;
    lists: links.RecordActivities["taskLists"];
    onAdded: (task: links.LinkedTask) => void;
}) {
    const t = useCrmT();
    const field = useId();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [due, setDue] = useState("");
    const [listId, setListId] = useState(lists[0]?.id ?? "");
    const task = { name, listId, due: due || null };
    const valid = links.newTaskSchema.safeParse(task).success;
    const { busy, submit } = useSubmit(
        () =>
            unwrap(() => actions.createRecordTaskAction({ object, id, task }), t("errors.generic")),
        (answer) => {
            onAdded(answer.task);
            setName("");
            setDue("");
            setOpen(false);
        }
    );
    if (!open) return <AddToggle label={t("activities.addTask")} onClick={() => setOpen(true)} />;
    return (
        <form
            className="flex flex-col gap-2 border-t border-border p-2"
            onSubmit={(event) => {
                event.preventDefault();
                if (valid) submit();
            }}
        >
            <Input
                aria-label={`${t("activities.taskName")} *`}
                placeholder={t("activities.taskName")}
                value={name}
                maxLength={links.TASK_NAME_MAX}
                autoFocus
                onChange={(event) => setName(event.target.value)}
            />
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Select
                    id={field}
                    aria-label={t("activities.taskList")}
                    value={listId}
                    onValueChange={setListId}
                    options={lists.map((list) => ({
                        value: list.id,
                        label: `${list.spaceName} / ${list.name}`
                    }))}
                />
                <DateInput
                    mode="date"
                    aria-label={t("activities.taskDue")}
                    value={due}
                    onChange={(event) => setDue(event.target.value)}
                />
            </div>
            <FormButtons busy={busy} valid={valid} onCancel={() => setOpen(false)} />
        </form>
    );
}

function FormButtons({
    busy,
    valid,
    onCancel
}: {
    busy: boolean;
    valid: boolean;
    onCancel: () => void;
}) {
    const t = useCrmT();
    return (
        <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                {t("actions.cancel")}
            </Button>
            <Button type="submit" size="sm" aria-disabled={!valid || busy} disabled={busy}>
                {t("activities.add")}
            </Button>
        </div>
    );
}
