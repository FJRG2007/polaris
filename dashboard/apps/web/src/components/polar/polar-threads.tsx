"use client";

/**
 * Polar's conversation list, laid out the way ChatGPT and Claude lay theirs out:
 * "New chat" on top, then the conversations grouped by when they were last
 * touched (Today, Yesterday, Previous 7 days, Previous 30 days, Older), the open
 * one highlighted, and each row's rename and delete behind a "..." menu that
 * shows on hover or focus. No heading above the list: the button and the group
 * names already say what it is.
 *
 * Used twice - as the /polar page's sidebar (and its drawer on a phone), and as
 * the side panel's history view - so the two never drift apart.
 */

import { useRef, useState, type ComponentType } from "react";
import { MoreHorizontal, Pencil, SquarePen, Trash2 } from "lucide-react";
import {
    Button,
    cn,
    ConfirmDeleteDialog,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input,
    keepFocusOnClose,
    useDeferredFocus
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { groupThreads, POLAR_TITLE_MAX, threadTitleSchema } from "@/lib/polar/shared";

export type ThreadRow = { id: string; title: string; updatedAt: string };

export function PolarThreads({
    threads,
    activeId,
    more,
    loadingMore,
    onOpen,
    onNew,
    onRename,
    onDelete,
    onLoadMore,
    hide
}: {
    /** Null while the first page is on its way. */
    threads: ThreadRow[] | null;
    activeId: string;
    more: boolean;
    loadingMore: boolean;
    onOpen: (id: string) => void;
    onNew: () => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    onLoadMore: () => void;
    /** The button beside "New chat" that puts the list away. */
    hide: { label: string; icon: ComponentType<{ className?: string }>; onClick: () => void };
}) {
    const t = useTranslations("polar");
    const [deleting, setDeleting] = useState<ThreadRow | null>(null);
    const HideIcon = hide.icon;
    return (
        <nav aria-label={t("history.title")} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 p-2">
                <Button
                    type="button"
                    variant="outline"
                    className="min-w-0 flex-1 justify-start gap-2"
                    onClick={onNew}
                >
                    <SquarePen className="size-4 shrink-0" />
                    <span className="truncate">{t("actions.new")}</span>
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={hide.label}
                    title={hide.label}
                    onClick={hide.onClick}
                >
                    <HideIcon className="size-4" />
                </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
                {threads === null ? (
                    <div className="space-y-2 p-2">
                        {[0, 1, 2].map((key) => (
                            <div key={key} className="h-6 rounded bg-muted motion-safe:animate-pulse" />
                        ))}
                    </div>
                ) : threads.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("history.empty")}</p>
                ) : (
                    <>
                        {groupThreads(threads).map(({ group, rows }) => (
                            <div key={group} role="group" aria-labelledby={`polar-group-${group}`}>
                                <p
                                    id={`polar-group-${group}`}
                                    className="px-2 pb-1 pt-3 text-xs font-medium text-foreground-subtle first:pt-1"
                                >
                                    {t(`history.groups.${group}`)}
                                </p>
                                {rows.map((row) => (
                                    <ThreadItem
                                        key={row.id}
                                        row={row}
                                        active={row.id === activeId}
                                        onOpen={() => onOpen(row.id)}
                                        onRename={(title) => onRename(row.id, title)}
                                        onDelete={() => setDeleting(row)}
                                    />
                                ))}
                            </div>
                        ))}
                        {more ? (
                            <button
                                type="button"
                                onClick={onLoadMore}
                                disabled={loadingMore}
                                className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-card-hover hover:text-foreground disabled:opacity-50"
                            >
                                {t("history.more")}
                            </button>
                        ) : null}
                    </>
                )}
            </div>
            {deleting ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                    name={deleting.title}
                    requireTyping={false}
                    kind={t("history.kind")}
                    title={t("history.deleteTitle")}
                    question={t("history.deleteQuestion", { title: deleting.title })}
                    confirmLabel={t("history.deleteConfirm")}
                    onConfirm={() => {
                        onDelete(deleting.id);
                        setDeleting(null);
                    }}
                />
            ) : null}
        </nav>
    );
}

function ThreadItem({
    row,
    active,
    onOpen,
    onRename,
    onDelete
}: {
    row: ThreadRow;
    active: boolean;
    onOpen: () => void;
    onRename: (title: string) => void;
    onDelete: () => void;
}) {
    const t = useTranslations("polar");
    const [renaming, setRenaming] = useState(false);
    const [draft, setDraft] = useState(row.title);
    // Whether the menu closed because an option was taken: then the focus goes
    // to what the option opened, not back to the "..." button.
    const chose = useRef(false);
    const field = useDeferredFocus<HTMLInputElement>(renaming);

    const finish = (save: boolean) => {
        setRenaming(false);
        if (!save) return;
        const title = threadTitleSchema.safeParse(draft);
        if (title.success && title.data !== row.title) onRename(title.data);
    };

    return (
        <div
            className={cn(
                "group/row flex min-w-0 items-center rounded-md",
                active ? "bg-card-hover" : "hover:bg-card-hover"
            )}
        >
            {renaming ? (
                <Input
                    ref={field}
                    value={draft}
                    maxLength={POLAR_TITLE_MAX}
                    aria-label={t("history.name")}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => finish(true)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            finish(true);
                        } else if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            finish(false);
                        }
                    }}
                    className="h-8 min-w-0 flex-1"
                />
            ) : (
                <button
                    type="button"
                    onClick={onOpen}
                    aria-current={active ? "page" : undefined}
                    title={row.title}
                    className={cn(
                        "min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm",
                        active ? "font-medium text-foreground" : "text-foreground"
                    )}
                >
                    {row.title}
                </button>
            )}
            {renaming ? null : (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            aria-label={t("history.options")}
                            title={t("history.options")}
                            className="mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-fast hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                        >
                            <MoreHorizontal className="size-4" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        align="end"
                        onCloseAutoFocus={(event) => {
                            if (chose.current) keepFocusOnClose(event);
                            chose.current = false;
                        }}
                    >
                        <DropdownMenuItem
                            onSelect={() => {
                                chose.current = true;
                                setDraft(row.title);
                                setRenaming(true);
                            }}
                        >
                            <Pencil />
                            {t("history.rename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            variant="danger"
                            onSelect={() => {
                                chose.current = true;
                                onDelete();
                            }}
                        >
                            <Trash2 />
                            {t("history.delete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    );
}
