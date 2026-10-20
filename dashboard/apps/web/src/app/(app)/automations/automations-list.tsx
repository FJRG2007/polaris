"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import {
    FolderInput,
    FolderPlus,
    Folders,
    History,
    MoreHorizontal,
    Pencil,
    Play,
    Plus,
    Tags,
    Trash2,
    Workflow,
    X
} from "lucide-react";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    EmptyState,
    Input,
    Select,
    Switch,
    Textarea,
    isDirty,
    useToast
} from "@polaris/ui";
import * as core from "@polaris/core";
import type { FolderRow } from "@/lib/automations/organize";
import type { AutomationRow } from "@/lib/automations/service";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { LoadFailed, RowsSkeleton, StatusChip, useCachedAction, when } from "./shared";
import {
    createAutomationAction,
    createFolderAction,
    creatableShelvesAction,
    deleteAutomationAction,
    deleteFolderAction,
    listAutomationsAction,
    moveToFolderAction,
    renameFolderAction,
    runNowAction,
    setEnabledAction,
    setTagsAction
} from "./actions";

const ALL = "all";
const NONE = "none";

/**
 * Every automation on the open shelf, or - given `from` - only those an app made
 * (and of one thing of it, such as a place), which is how an app's own screen
 * shows its automations. Those are started from the app's screen, so the list
 * offers no blank one of its own there: `actions` is what the app offers
 * instead, in the toolbar, and `after` what it draws under the list.
 */
export function AutomationsList({
    from,
    actions,
    after
}: {
    from?: { readonly origin: string; readonly originRef?: string | null };
    actions?: ReactNode;
    after?: ReactNode;
} = {}) {
    const t = useTranslations("automations");
    const locale = useLocale();
    const toast = useToast();
    const origin = from?.origin ?? null;
    const originRef = from?.originRef ?? null;
    const load = useMemo(
        () => () => listAutomationsAction(origin ? { origin, originRef } : undefined),
        [origin, originRef]
    );
    const { data, error, refresh, replace } = useCachedAction(
        origin
            ? `polaris.automations.list.${origin}.${originRef ?? ""}`
            : "polaris.automations.list",
        load
    );
    const mayCreate = Boolean(data?.canEdit) && !origin;
    const [creating, setCreating] = useState(false);
    const [folder, setFolder] = useState<string>(ALL);
    const [tag, setTag] = useState<string | null>(null);
    const [managing, setManaging] = useState(false);
    const [tagging, setTagging] = useState<AutomationRow | null>(null);
    const [deleting, setDeleting] = useState<AutomationRow | null>(null);

    const folders = data?.folders ?? [];
    const folderName = useMemo(
        () => new Map(folders.map((entry) => [entry.id, entry.name])),
        [folders]
    );
    // A list cached before folders and tags existed has rows without them.
    const rows = useMemo(
        () =>
            (data?.rows ?? []).map((row) => ({
                ...row,
                folderId: row.folderId ?? null,
                tags: row.tags ?? []
            })),
        [data?.rows]
    );
    const allTags = useMemo(() => [...new Set(rows.flatMap((row) => row.tags))].sort(), [rows]);
    // A filter on a folder or tag that no longer exists shows everything rather than nothing.
    const folderFilter = folder === ALL || folder === NONE || folderName.has(folder) ? folder : ALL;
    const tagFilter = tag && allTags.includes(tag) ? tag : null;
    const shown = rows.filter(
        (row) =>
            (folderFilter === ALL ||
                (folderFilter === NONE ? !row.folderId : row.folderId === folderFilter)) &&
            (!tagFilter || row.tags.includes(tagFilter))
    );

    /** Change one row now, and put it back when the server says no. */
    const patchRow = async (
        row: AutomationRow,
        patch: Partial<AutomationRow>,
        send: () => Promise<{ ok: boolean; error?: string }>
    ) => {
        const before: Partial<AutomationRow> = Object.fromEntries(
            Object.keys(patch).map((key) => [key, row[key as keyof AutomationRow]])
        );
        replace((current) => ({
            ...current,
            rows: current.rows.map((entry) =>
                entry.id === row.id ? { ...entry, ...patch } : entry
            )
        }));
        const answer = await send().catch(() => ({ ok: false, error: t("errors.generic") }));
        if (!answer.ok) {
            replace((current) => ({
                ...current,
                rows: current.rows.map((entry) =>
                    entry.id === row.id ? { ...entry, ...before } : entry
                )
            }));
            toast.show({ title: answer.error ?? t("errors.generic") });
        }
    };

    const toggle = (row: AutomationRow, enabled: boolean) =>
        void patchRow(row, { enabled }, () => setEnabledAction(row.id, enabled));
    const move = (row: AutomationRow, folderId: string | null) => {
        if (row.folderId === folderId) return;
        void patchRow(row, { folderId }, () =>
            moveToFolderAction({ automationId: row.id, folderId })
        );
    };

    const runNow = async (row: AutomationRow) => {
        const answer = await runNowAction(row.id).catch(() => ({
            ok: false as const,
            error: t("errors.generic")
        }));
        toast.show({ title: answer.ok ? t("editor.runStarted") : answer.error });
    };

    /** Gone from the list at once, and back where it was when the server says no. */
    const remove = async (row: AutomationRow) => {
        setDeleting(null);
        replace((current) => ({
            ...current,
            rows: current.rows.filter((entry) => entry.id !== row.id)
        }));
        const answer = await deleteAutomationAction(row.id).catch(() => ({
            ok: false as const,
            error: t("errors.generic")
        }));
        if (answer.ok) return void toast.show({ title: t("editor.deleted") });
        replace((current) => ({
            ...current,
            rows: current.rows.some((entry) => entry.id === row.id)
                ? current.rows
                : [...current.rows, row].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        }));
        toast.show({ title: answer.error ?? t("errors.generic") });
    };

    const filterOptions = [
        { value: ALL, label: t("folders.all") },
        { value: NONE, label: t("folders.none") },
        ...folders.map((entry) => ({ value: entry.id, label: entry.name }))
    ];

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                {data && (folders.length > 0 || data.canEdit) ? (
                    <Select
                        className="w-full min-w-0 sm:w-56"
                        value={folderFilter}
                        onValueChange={setFolder}
                        options={filterOptions}
                        aria-label={t("folders.filter")}
                    />
                ) : null}
                {data?.canEdit ? (
                    <Button variant="ghost" size="sm" onClick={() => setManaging(true)}>
                        <Folders aria-hidden="true" />
                        {t("folders.manage")}
                    </Button>
                ) : null}
                <div className="ml-auto flex items-center gap-2">
                    {actions}
                    {mayCreate ? (
                        <Button onClick={() => setCreating(true)}>
                            <Plus aria-hidden="true" />
                            {t("newAutomation")}
                        </Button>
                    ) : null}
                </div>
            </div>
            {allTags.length > 0 ? (
                <div
                    className="flex flex-wrap items-center gap-1"
                    role="group"
                    aria-label={t("tags.filter")}
                >
                    {allTags.map((entry) => (
                        <Button
                            key={entry}
                            size="sm"
                            variant={tagFilter === entry ? "secondary" : "ghost"}
                            className="h-7 max-w-[12rem] px-2"
                            aria-pressed={tagFilter === entry}
                            title={entry}
                            onClick={() => setTag(tagFilter === entry ? null : entry)}
                        >
                            <span className="truncate">#{entry}</span>
                        </Button>
                    ))}
                </div>
            ) : null}
            {error !== null && !data ? (
                <LoadFailed
                    message={error || t("list.loadFailed")}
                    onRetry={() => void refresh()}
                />
            ) : !data ? (
                <RowsSkeleton />
            ) : data.rows.length === 0 ? (
                <EmptyState
                    icon={<Workflow aria-hidden="true" />}
                    title={t("list.emptyTitle")}
                    description={
                        origin
                            ? t("list.emptyFromApp")
                            : data.canEdit
                              ? t("list.emptyDescription")
                              : t("list.emptyReadOnly")
                    }
                    action={
                        mayCreate ? (
                            <Button onClick={() => setCreating(true)}>
                                <Plus aria-hidden="true" />
                                {t("newAutomation")}
                            </Button>
                        ) : undefined
                    }
                />
            ) : shown.length === 0 ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                    <span className="min-w-0 flex-1">{t("folders.nothingMatches")}</span>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            setFolder(ALL);
                            setTag(null);
                        }}
                    >
                        {t("folders.clearFilters")}
                    </Button>
                </div>
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {shown.map((row) => (
                        <li key={row.id} className="flex items-center gap-3 p-3">
                            <div className="min-w-0 flex-1">
                                <Link
                                    href={`/automations/${row.id}`}
                                    className="block truncate text-sm font-medium hover:underline"
                                    title={row.name}
                                >
                                    {row.name}
                                </Link>
                                <p className="truncate text-xs text-muted-foreground">
                                    {t(
                                        `modes.${(core.AUTOMATION_MODES as readonly string[]).includes(row.mode) ? (row.mode as core.AutomationMode) : "single"}`
                                    )}
                                    {" - "}
                                    {row.lastRunAt
                                        ? t("list.lastRun", { when: when(row.lastRunAt, locale) })
                                        : t("list.never")}
                                </p>
                                {(row.folderId && folderName.has(row.folderId)) ||
                                row.tags.length > 0 ? (
                                    <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                                        {row.folderId && folderName.has(row.folderId) ? (
                                            <button
                                                type="button"
                                                className="min-w-0 max-w-[12rem]"
                                                title={t("folders.showFolder", {
                                                    name: folderName.get(row.folderId)!
                                                })}
                                                onClick={() => setFolder(row.folderId!)}
                                            >
                                                <Badge
                                                    variant="neutral"
                                                    className="max-w-full truncate"
                                                >
                                                    {folderName.get(row.folderId)}
                                                </Badge>
                                            </button>
                                        ) : null}
                                        {row.tags.map((entry) => (
                                            <button
                                                key={entry}
                                                type="button"
                                                className="min-w-0 max-w-[10rem]"
                                                title={t("tags.showTag", { tag: entry })}
                                                onClick={() => setTag(entry)}
                                            >
                                                <Badge
                                                    variant="primary"
                                                    className="max-w-full truncate"
                                                >
                                                    #{entry}
                                                </Badge>
                                            </button>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                            {row.lastStatus ? <StatusChip status={row.lastStatus} /> : null}
                            {!row.published ? (
                                <span className="text-xs text-muted-foreground">
                                    {t("list.draft")}
                                </span>
                            ) : null}
                            <span title={row.published ? undefined : t("list.notPublished")}>
                                <Switch
                                    checked={row.enabled}
                                    disabled={!data.canEdit || !row.published}
                                    onChange={(next: boolean) => toggle(row, next)}
                                    aria-label={t("list.switchLabel", { name: row.name })}
                                />
                            </span>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={t("folders.rowMenu", { name: row.name })}
                                        title={t("folders.rowMenuShort")}
                                    >
                                        <MoreHorizontal aria-hidden="true" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    {data.canEdit ? (
                                        <DropdownMenuItem
                                            disabled={!row.runnable}
                                            title={
                                                row.runnable
                                                    ? undefined
                                                    : !row.published
                                                      ? t("errors.notPublished")
                                                      : !row.enabled
                                                        ? t("list.runOff")
                                                        : t("editor.noManual")
                                            }
                                            onSelect={() => void runNow(row)}
                                        >
                                            <Play aria-hidden="true" />
                                            {t("editor.runNow")}
                                        </DropdownMenuItem>
                                    ) : null}
                                    <DropdownMenuItem asChild>
                                        <Link href={`/automations/runs?automation=${row.id}`}>
                                            <History aria-hidden="true" />
                                            {t("list.runs")}
                                        </Link>
                                    </DropdownMenuItem>
                                    {data.canEdit ? <DropdownMenuSeparator /> : null}
                                    {data.canEdit ? (
                                        <DropdownMenuSub>
                                            <DropdownMenuSubTrigger>
                                                <FolderInput aria-hidden="true" />
                                                {t("folders.moveTo")}
                                            </DropdownMenuSubTrigger>
                                            <DropdownMenuSubContent>
                                                <DropdownMenuItem
                                                    disabled={!row.folderId}
                                                    onSelect={() => move(row, null)}
                                                >
                                                    {t("folders.none")}
                                                </DropdownMenuItem>
                                                {folders.map((entry) => (
                                                    <DropdownMenuItem
                                                        key={entry.id}
                                                        disabled={row.folderId === entry.id}
                                                        onSelect={() => move(row, entry.id)}
                                                    >
                                                        <span className="truncate">
                                                            {entry.name}
                                                        </span>
                                                    </DropdownMenuItem>
                                                ))}
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    onSelect={() => setManaging(true)}
                                                >
                                                    <FolderPlus aria-hidden="true" />
                                                    {t("folders.newFolder")}
                                                </DropdownMenuItem>
                                            </DropdownMenuSubContent>
                                        </DropdownMenuSub>
                                    ) : null}
                                    {data.canEdit ? (
                                        <DropdownMenuItem onSelect={() => setTagging(row)}>
                                            <Tags aria-hidden="true" />
                                            {t("tags.edit")}
                                        </DropdownMenuItem>
                                    ) : null}
                                    {data.canEdit ? <DropdownMenuSeparator /> : null}
                                    {data.canEdit ? (
                                        <DropdownMenuItem
                                            className="text-danger focus:text-danger"
                                            onSelect={() => setDeleting(row)}
                                        >
                                            <Trash2 aria-hidden="true" />
                                            {t("editor.delete")}
                                        </DropdownMenuItem>
                                    ) : null}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </li>
                    ))}
                </ul>
            )}
            {after}
            {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
            {deleting ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setDeleting(null)}
                    name={deleting.name}
                    kind={t("title")}
                    requireTyping={false}
                    confirmLabel={t("editor.delete")}
                    onConfirm={() => void remove(deleting)}
                />
            ) : null}
            {managing && data ? (
                <FoldersDialog
                    folders={folders}
                    counts={(id) => data.rows.filter((row) => row.folderId === id).length}
                    onClose={() => setManaging(false)}
                    onChange={(next, rowsOut) =>
                        replace((current) => ({
                            ...current,
                            folders: next,
                            rows: rowsOut
                                ? current.rows.map((row) =>
                                      row.folderId === rowsOut ? { ...row, folderId: null } : row
                                  )
                                : current.rows
                        }))
                    }
                />
            ) : null}
            {tagging ? (
                <TagsDialog
                    row={tagging}
                    known={allTags}
                    onClose={() => setTagging(null)}
                    onSave={(tags) => {
                        const row = tagging;
                        setTagging(null);
                        if (JSON.stringify(tags) === JSON.stringify(row.tags)) return;
                        void patchRow(row, { tags }, () =>
                            setTagsAction({ automationId: row.id, tags })
                        );
                    }}
                />
            ) : null}
        </div>
    );
}

function FoldersDialog({
    folders,
    counts,
    onClose,
    onChange
}: {
    folders: readonly FolderRow[];
    counts: (id: string) => number;
    onClose: () => void;
    /** The new folder list; `emptied` names a deleted folder whose automations are now in none. */
    onChange: (folders: FolderRow[], emptied?: string) => void;
}) {
    const t = useTranslations("automations");
    const toast = useToast();
    const [name, setName] = useState("");
    const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
    const [deleting, setDeleting] = useState<FolderRow | null>(null);
    const [pending, start] = useTransition();
    const fresh = core.automationFolderNameSchema.safeParse(name);
    const taken = (value: string, except?: string) =>
        folders.some(
            (entry) => entry.id !== except && entry.name.toLowerCase() === value.toLowerCase()
        );
    const editCheck = editing ? core.automationFolderNameSchema.safeParse(editing.value) : null;
    const atLimit = folders.length >= core.AUTOMATION_ORGANIZE_LIMITS.foldersPerShelf;

    const create = () => {
        if (!fresh.success || taken(fresh.data) || atLimit) return;
        start(async () => {
            const answer = await createFolderAction({ name: fresh.data }).catch(() => null);
            if (!answer?.ok)
                return void toast.show({ title: answer?.error ?? t("errors.generic") });
            onChange([...folders, answer.folder].sort((a, b) => a.name.localeCompare(b.name)));
            setName("");
        });
    };

    const rename = async (folder: FolderRow, value: string) => {
        setEditing(null);
        const parsed = core.automationFolderNameSchema.safeParse(value);
        if (!parsed.success || parsed.data === folder.name || taken(parsed.data, folder.id)) return;
        const before = [...folders];
        onChange(
            folders.map((entry) =>
                entry.id === folder.id ? { ...entry, name: parsed.data } : entry
            )
        );
        const answer = await renameFolderAction({ folderId: folder.id, name: parsed.data }).catch(
            () => null
        );
        if (!answer?.ok) {
            onChange(before);
            toast.show({ title: answer?.error ?? t("errors.generic") });
        }
    };

    return (
        <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("folders.title")}</DialogTitle>
                    <DialogDescription>{t("folders.hint")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex min-w-0 gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        create();
                    }}
                >
                    <Input
                        className="min-w-0 flex-1"
                        value={name}
                        maxLength={core.AUTOMATION_ORGANIZE_LIMITS.folderNameLength}
                        placeholder={t("folders.namePlaceholder")}
                        aria-label={t("folders.name")}
                        aria-invalid={fresh.success && taken(fresh.data) ? true : undefined}
                        onChange={(event) => setName(event.target.value)}
                    />
                    <Button
                        type="submit"
                        disabled={!fresh.success || taken(fresh.data) || atLimit || pending}
                        aria-disabled={!fresh.success}
                    >
                        <FolderPlus aria-hidden="true" />
                        {t("folders.add")}
                    </Button>
                </form>
                {fresh.success && taken(fresh.data) ? (
                    <p className="text-xs text-danger">{t("folders.taken")}</p>
                ) : atLimit ? (
                    <p className="text-xs text-muted-foreground">{t("folders.atLimit")}</p>
                ) : null}
                {folders.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("folders.empty")}</p>
                ) : (
                    <ul className="max-h-80 divide-y divide-border overflow-y-auto overscroll-contain rounded-lg border border-border">
                        {folders.map((folder) => (
                            <li key={folder.id} className="flex min-w-0 items-center gap-2 p-2">
                                {editing?.id === folder.id ? (
                                    <Input
                                        autoFocus
                                        className="min-w-0 flex-1"
                                        value={editing.value}
                                        maxLength={core.AUTOMATION_ORGANIZE_LIMITS.folderNameLength}
                                        aria-label={t("folders.name")}
                                        aria-invalid={
                                            editCheck &&
                                            (!editCheck.success || taken(editCheck.data, folder.id))
                                                ? true
                                                : undefined
                                        }
                                        onChange={(event) =>
                                            setEditing({ id: folder.id, value: event.target.value })
                                        }
                                        onBlur={() => void rename(folder, editing.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                event.preventDefault();
                                                void rename(folder, editing.value);
                                            } else if (event.key === "Escape") {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                setEditing(null);
                                            }
                                        }}
                                    />
                                ) : (
                                    <span
                                        className="min-w-0 flex-1 truncate text-sm"
                                        title={folder.name}
                                    >
                                        {folder.name}
                                        <span className="ml-2 text-xs text-muted-foreground">
                                            {t("folders.count", { count: counts(folder.id) })}
                                        </span>
                                    </span>
                                )}
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={t("folders.rename")}
                                    title={t("folders.rename")}
                                    onClick={() =>
                                        setEditing({ id: folder.id, value: folder.name })
                                    }
                                >
                                    <Pencil aria-hidden="true" />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={t("folders.delete")}
                                    title={t("folders.delete")}
                                    onClick={() => setDeleting(folder)}
                                >
                                    <Trash2 aria-hidden="true" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("folders.done")}
                    </Button>
                </DialogFooter>
                {deleting ? (
                    <ConfirmDeleteDialog
                        open
                        onOpenChange={(open) => !open && setDeleting(null)}
                        name={deleting.name}
                        kind={t("folders.kind")}
                        requireTyping={false}
                        description={t("folders.deleteHint")}
                        confirmLabel={t("folders.delete")}
                        pending={pending}
                        onConfirm={() =>
                            start(async () => {
                                const folder = deleting;
                                const answer = await deleteFolderAction(folder.id).catch(
                                    () => null
                                );
                                setDeleting(null);
                                if (!answer?.ok)
                                    return void toast.show({
                                        title: answer?.error ?? t("errors.generic")
                                    });
                                onChange(
                                    folders.filter((entry) => entry.id !== folder.id),
                                    folder.id
                                );
                            })
                        }
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

function TagsDialog({
    row,
    known,
    onClose,
    onSave
}: {
    row: AutomationRow;
    known: readonly string[];
    onClose: () => void;
    onSave: (tags: string[]) => void;
}) {
    const t = useTranslations("automations");
    const [tags, setTags] = useState<string[]>([...row.tags]);
    const [draft, setDraft] = useState("");
    const typed = core.automationTagSchema.safeParse(draft);
    const full = tags.length >= core.AUTOMATION_ORGANIZE_LIMITS.tagsPerAutomation;
    // The same tags, in any order, are nothing to save.
    const unchanged = !isDirty(new Set(row.tags), new Set(tags));
    const add = (value: string) => {
        const parsed = core.automationTagSchema.safeParse(value);
        if (!parsed.success || tags.includes(parsed.data) || full) return;
        setTags([...tags, parsed.data]);
        setDraft("");
    };
    const suggestions = known
        .filter((entry) => !tags.includes(entry) && (!typed.success || entry.includes(typed.data)))
        .slice(0, 8);
    return (
        <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("tags.title")}</DialogTitle>
                    <DialogDescription className="truncate" title={row.name}>
                        {row.name}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex min-h-8 flex-wrap gap-1">
                    {tags.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("tags.none")}</p>
                    ) : null}
                    {tags.map((entry) => (
                        <span
                            key={entry}
                            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground"
                        >
                            <span className="truncate">#{entry}</span>
                            <button
                                type="button"
                                className="shrink-0 rounded hover:text-foreground"
                                aria-label={t("tags.remove", { tag: entry })}
                                title={t("tags.remove", { tag: entry })}
                                onClick={() => setTags(tags.filter((other) => other !== entry))}
                            >
                                <X className="size-3" aria-hidden="true" />
                            </button>
                        </span>
                    ))}
                </div>
                <form
                    className="flex min-w-0 gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        add(draft);
                    }}
                >
                    <Input
                        className="min-w-0 flex-1"
                        value={draft}
                        maxLength={core.AUTOMATION_ORGANIZE_LIMITS.tagLength + 8}
                        placeholder={t("tags.placeholder")}
                        aria-label={t("tags.add")}
                        aria-invalid={draft.trim() !== "" && !typed.success ? true : undefined}
                        disabled={full}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <Button
                        type="submit"
                        variant="outline"
                        disabled={!typed.success || tags.includes(typed.data) || full}
                        aria-disabled={!typed.success}
                    >
                        {t("tags.add")}
                    </Button>
                </form>
                {full ? (
                    <p className="text-xs text-muted-foreground">{t("tags.full")}</p>
                ) : draft.trim() !== "" && !typed.success ? (
                    <p className="text-xs text-danger">{t("tags.tooLong")}</p>
                ) : null}
                {suggestions.length > 0 && !full ? (
                    <div className="flex flex-wrap gap-1">
                        {suggestions.map((entry) => (
                            <Button
                                key={entry}
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 max-w-[10rem] px-2"
                                title={entry}
                                onClick={() => add(entry)}
                            >
                                <span className="truncate">#{entry}</span>
                            </Button>
                        ))}
                    </div>
                ) : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("create.cancel")}
                    </Button>
                    <Button onClick={() => onSave(tags)} disabled={unchanged}>
                        {t("tags.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
    const t = useTranslations("automations");
    const router = useRouter();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [orgId, setOrgId] = useState<string>("personal");
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();
    const shelves = useCachedAction("polaris.automations.shelves", creatableShelvesAction);
    const parsed = core.automationCreateSchema.safeParse({ name, description });

    const submit = () =>
        start(async () => {
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
            const answer = await createAutomationAction(
                { name, description, orgId: orgId === "personal" ? null : orgId },
                zone
            );
            if (!answer.ok) return setError(answer.error);
            router.push(`/automations/${answer.id}`);
        });

    const options = [
        { value: "personal", label: t("create.personal") },
        ...(shelves.data?.ok
            ? shelves.data.orgs.map((org) => ({ value: org.id, label: org.name }))
            : [])
    ];

    return (
        <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("create.title")}</DialogTitle>
                </DialogHeader>
                <form
                    className="space-y-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (parsed.success) submit();
                    }}
                >
                    <label className="block space-y-1 text-sm">
                        <span>{t("create.name")} *</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("create.namePlaceholder")}
                            maxLength={core.AUTOMATION_LIMITS.nameLength}
                            autoFocus
                        />
                    </label>
                    <label className="block space-y-1 text-sm">
                        <span>{t("create.descriptionLabel")}</span>
                        <Textarea
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            maxLength={core.AUTOMATION_LIMITS.descriptionLength}
                            rows={2}
                        />
                    </label>
                    {options.length > 1 ? (
                        <label className="block space-y-1 text-sm">
                            <span>{t("create.shelf")}</span>
                            <Select
                                value={orgId}
                                onValueChange={setOrgId}
                                options={options}
                                aria-label={t("create.shelf")}
                            />
                        </label>
                    ) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("create.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={!parsed.success || pending}
                            aria-disabled={!parsed.success}
                        >
                            {t("create.submit")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
