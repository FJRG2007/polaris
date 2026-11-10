"use client";

/**
 * The two dialogs an issue opens: handing it to somebody, and making a task of
 * it. Shared by the list's menus, the bulk bar and the issue screen, so the
 * three ask the same questions in the same words.
 */

import Link from "next/link";
import * as actions from "./actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Check, ListTodo, Search } from "lucide-react";
import { issueHref } from "./paths";
import { issueTaskDraft } from "@/lib/telemetry/issue-query";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { TaskListOption } from "@/lib/telemetry/workflow-service";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import {
    Button,
    Checkbox,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Textarea
} from "@polaris/ui";

export function AssignDialog({
    open,
    onOpenChange,
    projectId,
    current,
    count,
    viewerId,
    onAssign
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Whose people search to ask: the project the issues sit in. */
    projectId: string;
    current: PickedPerson | null;
    /** How many issues this hands over, for the heading. */
    count: number;
    viewerId: string;
    onAssign: (person: PickedPerson | null) => void;
}) {
    const t = useTranslations("telemetry");
    const [picked, setPicked] = useState<readonly PickedPerson[]>(current ? [current] : []);
    useEffect(() => {
        if (open) setPicked(current ? [current] : []);
    }, [open, current]);
    const chosen = picked[0] ?? null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("assign.title", { count })}</DialogTitle>
                    <DialogDescription>{t("assign.hint")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <PeoplePicker
                        picked={picked}
                        onChange={setPicked}
                        max={1}
                        label={t("assign.find")}
                        search={(query) => actions.searchAssigneesAction(projectId, query)}
                    />
                    <div className="flex flex-wrap gap-2">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                onAssign({ id: viewerId, name: t("assign.me") });
                                onOpenChange(false);
                            }}
                        >
                            {t("assign.toMe")}
                        </Button>
                        {current && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    onAssign(null);
                                    onOpenChange(false);
                                }}
                            >
                                {t("assign.nobody")}
                            </Button>
                        )}
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {t("assign.cancel")}
                    </Button>
                    <Button
                        disabled={!chosen || chosen.id === current?.id}
                        onClick={() => {
                            onAssign(chosen);
                            onOpenChange(false);
                        }}
                    >
                        {t("assign.confirm")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export { issueHref };

export interface TaskSource {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly culprit: string;
    readonly level: string;
    readonly timesSeen: number;
    readonly firstSeen: string;
    readonly lastSeen: string;
    readonly lastRelease: string | null;
}


export function CreateTaskDialog({
    issue,
    onOpenChange,
    onCreated
}: {
    /** The issue to make a task of; null keeps the dialog closed. */
    issue: TaskSource | null;
    onOpenChange: (open: boolean) => void;
    onCreated?: () => void;
}) {
    const t = useTranslations("telemetry");
    const [query, setQuery] = useState("");
    const [lists, setLists] = useState<readonly TaskListOption[] | null>(null);
    const [listId, setListId] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [assign, setAssign] = useState(true);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const [made, setMade] = useState<{ id: string; reference: string } | null>(null);

    useEffect(() => {
        if (!issue) return;
        const link = `${window.location.origin}${issueHref(issue.projectId, issue.id)}`;
        const draft = issueTaskDraft(
            { title: issue.title, culprit: issue.culprit, link },
            {
                where: issue.culprit ? t("task.where", { culprit: issue.culprit }) : null,
                seen: t("task.seen", {
                    level: issue.level,
                    count: issue.timesSeen,
                    first: issue.firstSeen.slice(0, 10),
                    last: issue.lastSeen.slice(0, 10)
                }),
                release: issue.lastRelease ? t("task.release", { release: issue.lastRelease }) : null
            }
        );
        setName(draft.name);
        setDescription(draft.description);
        setMade(null);
        setError("");
        setAssign(true);
    }, [issue, t]);

    useEffect(() => {
        if (!issue) return;
        let live = true;
        const timer = setTimeout(async () => {
            const result = await runAction(() => actions.taskListsAction(query), setError);
            if (!live || !result) return;
            if (result.error) setError(result.error);
            setLists(result.lists ?? []);
        }, 200);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [issue, query]);

    const ready = Boolean(issue && listId && name.trim());

    return (
        <Dialog open={issue !== null} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("task.title")}</DialogTitle>
                    <DialogDescription>{t("task.hint")}</DialogDescription>
                </DialogHeader>
                {made ? (
                    <div className="flex flex-col items-start gap-3">
                        <p className="text-sm">{t("task.made", { reference: made.reference })}</p>
                        <Button asChild size="sm">
                            <Link href={`/tasks/t/${made.id}`}>
                                <ListTodo className="size-4" />
                                {t("task.open")}
                            </Link>
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("task.list")}
                            </span>
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={query}
                                    onChange={(event) => setQuery(event.target.value)}
                                    placeholder={t("task.findList")}
                                    aria-label={t("task.findList")}
                                    className="pl-7"
                                />
                            </div>
                            <ul
                                role="listbox"
                                aria-label={t("task.list")}
                                className="max-h-40 overflow-y-auto overscroll-contain rounded-md border border-border"
                            >
                                {lists === null ? (
                                    <li className="px-3 py-2 text-xs text-muted-foreground">
                                        {t("task.loadingLists")}
                                    </li>
                                ) : lists.length === 0 ? (
                                    <li className="px-3 py-2 text-xs text-muted-foreground">
                                        {t("task.noLists")}
                                    </li>
                                ) : (
                                    lists.map((list) => (
                                        <li key={list.id}>
                                            <button
                                                type="button"
                                                role="option"
                                                aria-selected={list.id === listId}
                                                onClick={() => setListId(list.id)}
                                                className={cn(
                                                    "flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                                                    list.id === listId && "bg-muted"
                                                )}
                                            >
                                                <span className="min-w-0 flex-1 truncate">
                                                    <span className="text-muted-foreground">
                                                        {list.spaceName} /{" "}
                                                    </span>
                                                    {list.name}
                                                </span>
                                                {list.id === listId && (
                                                    <Check className="size-3.5 shrink-0 text-primary" />
                                                )}
                                            </button>
                                        </li>
                                    ))
                                )}
                            </ul>
                        </div>
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("task.name")} *
                            </span>
                            <Input
                                value={name}
                                maxLength={200}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("task.description")}
                            </span>
                            <Textarea
                                value={description}
                                rows={6}
                                maxLength={20_000}
                                onChange={(event) => setDescription(event.target.value)}
                            />
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                                checked={assign}
                                onChange={(event) => setAssign(event.target.checked)}
                            />
                            {t("task.assign")}
                        </label>
                        {error && (
                            <p role="alert" className="text-xs text-danger">
                                {error}
                            </p>
                        )}
                    </div>
                )}
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {made ? t("task.close") : t("assign.cancel")}
                    </Button>
                    {!made && (
                        <Button
                            disabled={!ready || saving}
                            aria-disabled={!ready || saving}
                            title={!listId ? t("task.pickList") : undefined}
                            onClick={async () => {
                                if (!issue || !listId) return;
                                setSaving(true);
                                const result = await runAction(
                                    () =>
                                        actions.createIssueTaskAction({
                                            projectId: issue.projectId,
                                            issueId: issue.id,
                                            listId,
                                            name: name.trim(),
                                            description: description.trim(),
                                            assign
                                        }),
                                    setError
                                );
                                setSaving(false);
                                if (result?.error) setError(result.error);
                                else if (result?.id && result.reference) {
                                    setMade({ id: result.id, reference: result.reference });
                                    onCreated?.();
                                }
                            }}
                        >
                            {t("task.create")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
