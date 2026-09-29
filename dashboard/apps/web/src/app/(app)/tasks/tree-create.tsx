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
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
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

const ICONS: Record<CreateKind, typeof ListPlus> = {
    task: CheckSquare,
    list: ListPlus,
    folder: FolderPlus,
    doc: FileText,
    sprint: Timer,
    goal: Target,
    form: FileText
};

/**
 * What this container can hold. A folder is offered a subfolder only while there
 * is room left to nest one, rather than offered it and then refused after the
 * name has been typed.
 */
export function createOptionsFor(at: CreateAt, t: NamespaceTranslator<"tasks">): CreateOption[] {
    const option = (kind: CreateKind, label = t(`create.kind.${kind}`)): CreateOption => ({
        kind,
        label,
        Icon: ICONS[kind]
    });
    if (at.kind === "list") return [option("task"), option("form")];
    const nestable = at.kind === "space" || at.depth + 1 < core.FOLDER_DEPTH_LIMIT;
    return [
        option("task"),
        option("list"),
        ...(nestable ? [option("folder", at.kind === "folder" ? t("create.kind.subfolder") : t("create.kind.folder"))] : []),
        option("doc"),
        option("sprint"),
        ...(at.kind === "space" ? [option("goal")] : [])
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
    const t = useTranslations("tasks");
    const tc = useTranslations("common");
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
                    <DialogTitle>{t("create.sprint.title")}</DialogTitle>
                    <DialogDescription>
                        {at.kind === "folder"
                            ? t("create.sprint.inFolder", { name: at.name })
                            : t("create.sprint.inSpace")}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <Input
                        autoFocus
                        value={name}
                        placeholder={t("create.sprint.placeholder")}
                        aria-label={t("create.sprint.name")}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void submit();
                        }}
                    />
                    <div className="flex gap-2">
                        <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                            {t("create.sprint.starts")}
                            <input
                                type="date"
                                value={start}
                                onChange={(event) => setStart(event.target.value)}
                                className="h-9 rounded-md border border-border bg-field px-2 text-sm"
                            />
                        </label>
                        <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                            {t("create.sprint.ends")}
                            <input
                                type="date"
                                value={end}
                                onChange={(event) => setEnd(event.target.value)}
                                className="h-9 rounded-md border border-border bg-field px-2 text-sm"
                            />
                        </label>
                    </div>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={saving}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={() => void submit()} disabled={!name.trim() || saving}>
                            {t("create.sprint.submit")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function GoalDialog({ at, onClose, onDone }: { at: CreateAt; onClose: () => void; onDone: () => void }) {
    const t = useTranslations("tasks");
    const tc = useTranslations("common");
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
                    <DialogTitle>{t("create.goal.title")}</DialogTitle>
                    <DialogDescription>{t("create.goal.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <Input
                        autoFocus
                        value={name}
                        placeholder={t("create.goal.placeholder")}
                        aria-label={t("create.goal.name")}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void submit();
                        }}
                    />
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={saving}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={() => void submit()} disabled={!name.trim() || saving}>
                            {t("create.goal.submit")}
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
    const t = useTranslations("tasks");
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
                            title: t("docs.untitled")
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
    }, [request, at, onClose, onDone, onError, router, t]);

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
            if (!result?.context) {
                onClose();
                return;
            }
            // A task has to live in a list, and nothing here has one yet. That
            // is an arrangement, not a decision worth interrupting somebody for:
            // the list is made where the task was asked for and the dialog opens
            // on it, rather than sending them off to create one and come back.
            if (!at.listId && result.context.lists.length === 0) {
                const made = await runAction(() => actions.ensureListAction(at.spaceId, at.folderId), onError);
                if (made?.error) {
                    onError(made.error);
                    onClose();
                    return;
                }
                if (!made?.list) {
                    onClose();
                    return;
                }
                setContext({ ...result.context, lists: [made.list] });
                return;
            }
            setContext(result.context);
        })();
    }, [kind, at, onClose, onError]);

    if (!request || !at) return null;

    if (kind === "task") {
        if (loading || !context) {
            return (
                <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> {t("create.opening")}
                </div>
            );
        }
        // Made above when the container held none, so this is only a guard.
        const defaultListId = at.listId ?? context.lists[0]?.id ?? "";
        if (!defaultListId) return null;
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
