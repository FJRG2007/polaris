"use client";

/**
 * Making something new, from wherever you are in the tree.
 *
 * A container's plus button is the fastest thing in a sidebar to reach, so it
 * should offer everything that container can actually hold - not just the one
 * thing whoever wrote the row happened to wire up. What is on offer is decided
 * by where you clicked: a space holds lists, folders, pages, sprints and goals;
 * a folder holds all of that except goals, which belong to nobody in particular;
 * a list holds tasks and the form that feeds them.
 *
 * Nothing here offers a thing it cannot honestly place. A sprint created on a
 * project folder is that project's sprint, and a page written there is that
 * project's page, because the folder is what people use as a project.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { TaskCreateDialog } from "./task-create-dialog";
import type { CreateContext } from "@/lib/tasks/space-service";
import { CheckSquare, FileText, FolderPlus, ListPlus, Loader2, Target, Timer } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@polaris/ui";

/** Where a create menu was opened. */
export interface CreateAt {
    readonly kind: "space" | "folder" | "list";
    readonly spaceId: string;
    /** The folder itself, or the folder a list sits in. Null at a space root. */
    readonly folderId: string | null;
    /** Only for a list: what a new task goes into. */
    readonly listId: string | null;
    /** How deep the folder is, so a subfolder is only offered where one fits. */
    readonly depth: number;
    readonly name: string;
}

/** What can be made, in the order people reach for them. */
export type CreateKind = "task" | "list" | "folder" | "doc" | "sprint" | "goal" | "form";

export interface CreateOption {
    readonly kind: CreateKind;
    readonly label: string;
    readonly Icon: typeof ListPlus;
}

const OPTIONS: Record<CreateKind, CreateOption> = {
    task: { kind: "task", label: "Task", Icon: CheckSquare },
    list: { kind: "list", label: "List", Icon: ListPlus },
    folder: { kind: "folder", label: "Folder", Icon: FolderPlus },
    doc: { kind: "doc", label: "Doc", Icon: FileText },
    sprint: { kind: "sprint", label: "Sprint", Icon: Timer },
    goal: { kind: "goal", label: "Goal", Icon: Target },
    form: { kind: "form", label: "Form", Icon: FileText }
};

/**
 * What this container can hold. A folder is offered a subfolder only while there
 * is room left to nest one, rather than offered it and then refused after the
 * name has been typed.
 */
export function createOptionsFor(at: CreateAt): CreateOption[] {
    if (at.kind === "list") return [OPTIONS.task, OPTIONS.form];
    const nestable = at.kind === "space" || at.depth + 1 < core.FOLDER_DEPTH_LIMIT;
    return [
        OPTIONS.task,
        OPTIONS.list,
        ...(nestable ? [{ ...OPTIONS.folder, label: at.kind === "folder" ? "Subfolder" : "Folder" }] : []),
        OPTIONS.doc,
        OPTIONS.sprint,
        ...(at.kind === "space" ? [OPTIONS.goal] : [])
    ];
}

// ---------------------------------------------------------------------------
// The dialogs the heavier kinds need
// ---------------------------------------------------------------------------

/** Today and a fortnight from now, which is the sprint most teams are about to
 *  create; both are editable before it is made. */
function defaultSprintWindow(): { start: string; end: string } {
    const now = new Date();
    const end = new Date(now.getTime() + 13 * 24 * 60 * 60 * 1000);
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    return { start: iso(now), end: iso(end) };
}

function SprintDialog({
    at,
    onClose,
    onDone
}: {
    at: CreateAt;
    onClose: () => void;
    onDone: () => void;
}) {
    const window = defaultSprintWindow();
    const [name, setName] = useState("");
    const [start, setStart] = useState(window.start);
    const [end, setEnd] = useState(window.end);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    const submit = async () => {
        if (!name.trim() || saving) return;
        setSaving(true);
        const result = await runAction(
            () =>
                actions.createSprintAction({
                    spaceId: at.spaceId,
                    folderId: at.folderId,
                    name: name.trim(),
                    startDate: new Date(start).toISOString(),
                    endDate: new Date(`${end}T23:59:59`).toISOString()
                }),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        onDone();
        onClose();
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="w-[min(28rem,95vw)] max-w-[min(28rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>New sprint</DialogTitle>
                    <DialogDescription>
                        {at.kind === "folder"
                            ? `A run of work inside ${at.name}. Only this folder's tasks join it.`
                            : "A time-boxed run of work across this space."}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <Input
                        autoFocus
                        value={name}
                        placeholder="Sprint 14"
                        aria-label="Sprint name"
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void submit();
                        }}
                    />
                    <div className="flex gap-2">
                        <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                            Starts
                            <input
                                type="date"
                                value={start}
                                onChange={(event) => setStart(event.target.value)}
                                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                            />
                        </label>
                        <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                            Ends
                            <input
                                type="date"
                                value={end}
                                onChange={(event) => setEnd(event.target.value)}
                                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                            />
                        </label>
                    </div>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={saving}>
                            Cancel
                        </Button>
                        <Button onClick={() => void submit()} disabled={!name.trim() || saving}>
                            Create sprint
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function GoalDialog({ at, onClose, onDone }: { at: CreateAt; onClose: () => void; onDone: () => void }) {
    const [name, setName] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const router = useRouter();

    const submit = async () => {
        if (!name.trim() || saving) return;
        setSaving(true);
        const result = await runAction(
            () => actions.createGoalAction({ name: name.trim(), spaceId: at.spaceId }),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        onDone();
        onClose();
        // Straight to the goal: a target with no measure on it does nothing, and
        // the measures live on the goals screen.
        router.push("/tasks/goals");
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="w-[min(28rem,95vw)] max-w-[min(28rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>New goal</DialogTitle>
                    <DialogDescription>Name it now; add what it measures on the goals screen.</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <Input
                        autoFocus
                        value={name}
                        placeholder="Ship the new onboarding"
                        aria-label="Goal name"
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void submit();
                        }}
                    />
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={saving}>
                            Cancel
                        </Button>
                        <Button onClick={() => void submit()} disabled={!name.trim() || saving}>
                            Create goal
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// The one component the tree mounts
// ---------------------------------------------------------------------------

/**
 * Runs whatever the tree asked to create. The two kinds that are just a name in
 * a row (a list, a folder) are handled by the tree itself, where the input can
 * appear in the right place; everything else needs more than a name and lands
 * here.
 */
export function TreeCreate({
    request,
    onClose,
    onDone,
    onError
}: {
    request: { kind: CreateKind; at: CreateAt } | null;
    onClose: () => void;
    onDone: () => void;
    onError: (message: string) => void;
}) {
    const router = useRouter();
    const [context, setContext] = useState<CreateContext | null>(null);
    const [loading, setLoading] = useState(false);

    const kind = request?.kind ?? null;
    const at = request?.at ?? null;

    // A page and a form are a redirect rather than a form of their own: an empty
    // page is worth nothing until somebody writes in it, and a form needs its
    // questions, which is a screen rather than a dialog.
    useEffect(() => {
        if (!request || !at) return;
        if (request.kind === "doc") {
            void (async () => {
                const result = await runAction(
                    () =>
                        actions.createDocAction({
                            spaceId: at.spaceId,
                            folderId: at.folderId,
                            title: "Untitled"
                        }),
                    onError
                );
                onClose();
                onDone();
                if (result?.id) router.push(`/tasks/docs?doc=${result.id}`);
            })();
            return;
        }
        if (request.kind === "form") {
            onClose();
            router.push(`/tasks/s/${at.spaceId}?tab=Forms`);
        }
    }, [request, at, onClose, onDone, onError, router]);

    // A task needs the space's vocabulary, which the sidebar does not carry;
    // it is fetched when the dialog opens rather than with every page.
    useEffect(() => {
        if (kind !== "task" || !at) {
            setContext(null);
            return;
        }
        setLoading(true);
        void (async () => {
            const result = await runAction(() => actions.createContextAction(at.spaceId, at.folderId), onError);
            setLoading(false);
            if (result?.context) setContext(result.context);
            else onClose();
        })();
    }, [kind, at, onClose, onError]);

    if (!request || !at) return null;

    if (kind === "task") {
        if (loading || !context) {
            return (
                <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Opening
                </div>
            );
        }
        const defaultListId = at.listId ?? context.lists[0]?.id ?? "";
        if (!defaultListId) {
            onError("Make a list first - a task has to live in one.");
            onClose();
            return null;
        }
        return (
            <TaskCreateDialog
                open
                spaceId={at.spaceId}
                statuses={context.statuses}
                tags={context.tags}
                people={context.people}
                lists={context.lists}
                defaultListId={defaultListId}
                onClose={onClose}
                onCreated={(taskId) => {
                    onDone();
                    router.push(`/tasks/t/${taskId}`);
                }}
            />
        );
    }

    if (kind === "sprint") return <SprintDialog at={at} onClose={onClose} onDone={onDone} />;
    if (kind === "goal") return <GoalDialog at={at} onClose={onClose} onDone={onDone} />;
    return null;
}
