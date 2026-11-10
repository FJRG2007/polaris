"use client";

/**
 * The issue list: searched, sorted, read a page at a time as it scrolls, with
 * a menu on every row and a bar for what is selected.
 *
 * Status and assignment change on the row at once and go back if the server
 * refuses; a row that no longer matches the search (resolved under
 * `is:unresolved`) leaves the list the same way, and returns on a refusal.
 */

import Link from "next/link";
import * as actions from "./actions";
import * as polls from "./telemetry-polls";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { copyText } from "@/app/(app)/chat/links";
import { useCursorList } from "./use-cursor-list";
import { IssueSearchBar } from "./issue-search-bar";
import { useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RelativeTime } from "@/components/relative-time";
import type { PickedPerson } from "@/components/people-picker";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { IssueListRow } from "@/lib/telemetry/workflow-service";
import { AssignDialog, CreateTaskDialog, issueHref, type TaskSource } from "./issue-dialogs";
import { parseIssueQuery, type IssueSort, type ResolveMode } from "@/lib/telemetry/issue-query";
import {
    CircleCheck,
    CircleDot,
    CircleSlash,
    ExternalLink,
    Link2,
    ListTodo,
    UserMinus,
    UserPlus,
    UserRound,
    X
} from "lucide-react";
import {
    Button,
    Checkbox,
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    EmptyState,
    Skeleton,
    useToast
} from "@polaris/ui";

export const LEVEL_TONE: Record<string, string> = {
    fatal: "bg-danger",
    error: "bg-danger/70",
    warning: "bg-warning",
    info: "bg-primary/60",
    debug: "bg-muted-foreground/50"
};

const ROW_HEIGHT = 60;

export function Sparkline({ daily, days }: { daily: readonly number[]; days: number }) {
    const t = useTranslations("telemetry");
    const peak = Math.max(1, ...daily);
    return (
        <span
            className="hidden h-7 shrink-0 items-end gap-px md:flex"
            aria-label={t("issues.howOften", { days })}
        >
            {daily.map((count, at) => (
                <span
                    key={at}
                    className={cn("w-1 rounded-sm", count > 0 ? "bg-primary/70" : "bg-muted")}
                    style={{ height: `${Math.max(6, (count / peak) * 100)}%` }}
                />
            ))}
        </span>
    );
}

type Change = { status?: string; assignee?: PickedPerson | null };

export function IssueStream({
    projectId,
    query,
    sort,
    onSearch,
    viewerId,
    mayTask,
    windowDays
}: {
    /** A project's own list, or null for every project the reader can see. */
    projectId: string | null;
    query: string;
    sort: IssueSort;
    onSearch: (query: string, sort: IssueSort) => void;
    viewerId: string;
    mayTask: boolean;
    windowDays: number;
}) {
    const t = useTranslations("telemetry");
    const toast = useToast();
    const router = useRouter();
    const [editable, setEditable] = useState<ReadonlySet<string>>(new Set());
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [assigning, setAssigning] = useState<readonly IssueListRow[] | null>(null);
    const [tasking, setTasking] = useState<TaskSource | null>(null);
    const [error, setError] = useState("");
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

    const list = useCursorList<IssueListRow, actions.IssuePage>(
        (cursor, signal) => polls.telemetryIssues({ query, sort, cursor, projectId }, signal),
        `${projectId ?? ""}|${query}|${sort}`,
        (page) => setEditable((known) => new Set([...known, ...page.editable]))
    );
    const rows = list.items;
    const wantedStatus = useMemo(() => parseIssueQuery(query).status, [query]);

    useEffect(() => setSelected(new Set()), [query, sort, projectId]);

    const virtualizer = useVirtualizer({
        count: rows?.length ?? 0,
        getScrollElement: () => scroller,
        estimateSize: () => ROW_HEIGHT,
        overscan: 8,
        initialRect: { width: 800, height: ROW_HEIGHT * 10 }
    });
    const items = virtualizer.getVirtualItems();
    const lastIndex = items[items.length - 1]?.index ?? -1;
    useEffect(() => {
        if (rows && list.more && !list.paging && lastIndex >= rows.length - 8) list.loadMore();
    }, [rows, list, lastIndex]);

    /** Apply a change now, send it, and put the rows back if it is refused. */
    const apply = async (
        targets: readonly IssueListRow[],
        change: Change,
        send: () => Promise<{ error?: string }>
    ) => {
        const before = rows ?? [];
        const ids = new Set(targets.map((row) => row.id));
        list.setItems((current) =>
            current
                .map((row) =>
                    ids.has(row.id)
                        ? {
                              ...row,
                              ...(change.status ? { status: change.status } : {}),
                              ...(change.assignee !== undefined ? { assignee: change.assignee } : {})
                          }
                        : row
                )
                .filter((row) => !ids.has(row.id) || !wantedStatus || row.status === wantedStatus)
        );
        setSelected(new Set());
        const result = await runAction(send, setError);
        if (!result || result.error) {
            list.setItems(before);
            if (result?.error) setError(result.error);
            return;
        }
        setError("");
        router.refresh();
    };

    const setStatus = (targets: readonly IssueListRow[], status: string, mode?: ResolveMode) =>
        apply(targets, { status }, () =>
            actions.bulkStatusAction({
                issueIds: targets.map((row) => row.id),
                status,
                ...(mode ? { mode } : {})
            })
        );

    const assign = (targets: readonly IssueListRow[], person: PickedPerson | null) =>
        apply(targets, { assignee: person }, () =>
            actions.assignIssuesAction({
                issueIds: targets.map((row) => row.id),
                assigneeId: person?.id ?? null
            })
        );

    const chosen = (rows ?? []).filter((row) => selected.has(row.id));
    const chosenEditable = chosen.every((row) => editable.has(row.projectId));
    const sameProject = new Set(chosen.map((row) => row.projectId)).size === 1;

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <IssueSearchBar value={query} sort={sort} onChange={onSearch} showProject={projectId === null} />

            {(error || list.error) && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {error || list.error}
                </p>
            )}

            {chosen.length > 0 && (
                <div
                    role="toolbar"
                    aria-label={t("bulk.label")}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
                >
                    <span className="text-sm font-medium">{t("bulk.selected", { count: chosen.length })}</span>
                    <span
                        className="flex flex-wrap items-center gap-1"
                        title={chosenEditable ? undefined : t("bulk.readOnly")}
                    >
                        <Button size="sm" variant="ghost" disabled={!chosenEditable} onClick={() => setStatus(chosen, "resolved", "now")}>
                            <CircleCheck className="size-4" />
                            {t("issue.resolve")}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={!chosenEditable} onClick={() => setStatus(chosen, "ignored")}>
                            <CircleSlash className="size-4" />
                            {t("issue.ignore")}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={!chosenEditable} onClick={() => setStatus(chosen, "unresolved")}>
                            <CircleDot className="size-4" />
                            {t("menu.unresolve")}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={!chosenEditable || !sameProject}
                            title={sameProject ? undefined : t("bulk.oneProject")}
                            onClick={() => setAssigning(chosen)}
                        >
                            <UserPlus className="size-4" />
                            {t("menu.assign")}
                        </Button>
                    </span>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        className="ml-auto"
                        aria-label={t("bulk.clear")}
                        title={t("bulk.clear")}
                        onClick={() => setSelected(new Set())}
                    >
                        <X aria-hidden="true" />
                    </Button>
                </div>
            )}

            {rows === null ? (
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-busy="true">
                    {Array.from({ length: 6 }, (_, at) => (
                        <div key={at} className="flex items-center gap-3 px-3 py-3">
                            <Skeleton className="size-4" />
                            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                <Skeleton className="h-3.5 w-2/3" />
                                <Skeleton className="h-3 w-1/3" />
                            </div>
                            <Skeleton className="hidden h-7 w-28 md:block" />
                            <Skeleton className="h-4 w-10" />
                        </div>
                    ))}
                </div>
            ) : rows.length === 0 ? (
                <EmptyState icon={<CircleCheck />} title={t("issues.none")} description={t("issues.noneHint")} />
            ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                    <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                        <Checkbox
                            aria-label={t("bulk.all")}
                            checked={selected.size > 0 && selected.size === rows.length}
                            onChange={(event) =>
                                setSelected(event.target.checked ? new Set(rows.map((row) => row.id)) : new Set())
                            }
                        />
                        <span className="min-w-0 flex-1 truncate">{t("issues.issue")}</span>
                        <span className="hidden w-28 md:block">{t("issues.graph", { days: windowDays })}</span>
                        <span className="w-14 text-right">{t("issues.events")}</span>
                        <span className="hidden w-14 text-right sm:block">{t("issues.users")}</span>
                        <span className="hidden w-24 text-right sm:block">{t("issue.lastSeen")}</span>
                    </div>
                    <div
                        ref={setScroller}
                        className="max-h-[calc(100dvh-18rem)] min-h-48 overflow-y-auto overscroll-contain"
                    >
                        <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
                            {items.map((item) => {
                                const row = rows[item.index]!;
                                return (
                                    <li
                                        key={row.id}
                                        data-index={item.index}
                                        ref={virtualizer.measureElement}
                                        className="absolute inset-x-0 border-b border-border last:border-b-0"
                                        style={{ transform: `translateY(${item.start}px)` }}
                                    >
                                        <IssueRowItem
                                            row={row}
                                            selected={selected.has(row.id)}
                                            mayEdit={editable.has(row.projectId)}
                                            mayTask={mayTask}
                                            showProject={projectId === null}
                                            windowDays={windowDays}
                                            viewerId={viewerId}
                                            onSelect={(on) =>
                                                setSelected((current) => {
                                                    const next = new Set(current);
                                                    if (on) next.add(row.id);
                                                    else next.delete(row.id);
                                                    return next;
                                                })
                                            }
                                            onStatus={(status, mode) => setStatus([row], status, mode)}
                                            onAssign={(person) => assign([row], person)}
                                            onAssignOther={() => setAssigning([row])}
                                            onTask={() => setTasking(row)}
                                            onCopy={async () => {
                                                await copyText(
                                                    `${window.location.origin}${issueHref(row.projectId, row.id)}`
                                                );
                                                toast.show({ title: t("menu.copied") });
                                            }}
                                        />
                                    </li>
                                );
                            })}
                        </ul>
                        {list.paging && (
                            <div className="flex items-center gap-3 px-3 py-3" aria-busy="true">
                                <Skeleton className="h-3.5 w-1/2" />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {assigning && assigning.length > 0 && (
                <AssignDialog
                    open
                    onOpenChange={(open) => {
                        if (!open) setAssigning(null);
                    }}
                    projectId={assigning[0]!.projectId}
                    current={assigning.length === 1 ? assigning[0]!.assignee : null}
                    count={assigning.length}
                    viewerId={viewerId}
                    onAssign={(person) => void assign(assigning, person)}
                />
            )}
            <CreateTaskDialog
                issue={tasking}
                onOpenChange={(open) => {
                    if (!open) setTasking(null);
                }}
            />
        </div>
    );
}

function IssueRowItem({
    row,
    selected,
    mayEdit,
    mayTask,
    showProject,
    windowDays,
    viewerId,
    onSelect,
    onStatus,
    onAssign,
    onAssignOther,
    onTask,
    onCopy
}: {
    row: IssueListRow;
    selected: boolean;
    mayEdit: boolean;
    mayTask: boolean;
    showProject: boolean;
    windowDays: number;
    viewerId: string;
    onSelect: (on: boolean) => void;
    onStatus: (status: string, mode?: ResolveMode) => void;
    onAssign: (person: PickedPerson | null) => void;
    onAssignOther: () => void;
    onTask: () => void;
    onCopy: () => void;
}) {
    const t = useTranslations("telemetry");
    const router = useRouter();
    const href = issueHref(row.projectId, row.id);
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <div
                    className={cn(
                        "flex min-w-0 items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted",
                        selected && "bg-muted/60"
                    )}
                >
                    <span title={mayEdit ? undefined : t("bulk.readOnly")}>
                        <Checkbox
                            aria-label={t("bulk.pick", { title: row.title })}
                            checked={selected}
                            disabled={!mayEdit}
                            onChange={(event) => onSelect(event.target.checked)}
                        />
                    </span>
                    <span
                        aria-hidden="true"
                        className={cn("size-2 shrink-0 rounded-full", LEVEL_TONE[row.level] ?? LEVEL_TONE.error)}
                    />
                    <Link href={href} className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium" title={row.title}>
                                {row.title}
                            </span>
                            {row.status !== "unresolved" && (
                                <span className="shrink-0 rounded bg-muted px-1.5 text-[0.6875rem] text-muted-foreground">
                                    {t(`view.statuses.${row.status === "resolved" ? "resolved" : "ignored"}`)}
                                </span>
                            )}
                        </span>
                        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                            {showProject && (
                                <span className="max-w-32 shrink-0 truncate font-medium" title={row.projectName}>
                                    {row.projectName}
                                </span>
                            )}
                            <span className="min-w-0 truncate">
                                {row.culprit || t("issues.noStack")}
                                {row.lastRelease ? ` - ${row.lastRelease}` : ""}
                            </span>
                            {row.assignee && (
                                <span className="inline-flex max-w-32 shrink-0 items-center gap-1" title={row.assignee.name}>
                                    <UserRound className="size-3 shrink-0" />
                                    <span className="truncate">{row.assignee.name}</span>
                                </span>
                            )}
                        </span>
                    </Link>
                    <span className="hidden w-28 md:block">
                        <Sparkline daily={row.daily} days={windowDays} />
                    </span>
                    <span className="w-14 shrink-0 text-right text-sm tabular-nums">{row.timesSeen}</span>
                    <span className="hidden w-14 shrink-0 text-right text-sm tabular-nums sm:block">{row.userCount}</span>
                    <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground sm:block">
                        <RelativeTime iso={row.lastSeen} />
                    </span>
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem onSelect={() => router.push(href)}>
                    <ExternalLink className="size-4" />
                    {t("menu.open")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={onCopy}>
                    <Link2 className="size-4" />
                    {t("menu.copyLink")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                {row.status === "resolved" ? (
                    <ContextMenuItem disabled={!mayEdit} onSelect={() => onStatus("unresolved")}>
                        <CircleDot className="size-4" />
                        {t("menu.unresolve")}
                    </ContextMenuItem>
                ) : (
                    <>
                        <ContextMenuItem disabled={!mayEdit} onSelect={() => onStatus("resolved", "now")}>
                            <CircleCheck className="size-4" />
                            {t("issue.resolve")}
                        </ContextMenuItem>
                        {row.lastRelease && (
                            <ContextMenuItem disabled={!mayEdit} onSelect={() => onStatus("resolved", "nextRelease")}>
                                <CircleCheck className="size-4" />
                                {t("menu.resolveNext")}
                            </ContextMenuItem>
                        )}
                    </>
                )}
                {row.status === "ignored" ? (
                    <ContextMenuItem disabled={!mayEdit} onSelect={() => onStatus("unresolved")}>
                        <CircleDot className="size-4" />
                        {t("menu.unignore")}
                    </ContextMenuItem>
                ) : (
                    <ContextMenuItem disabled={!mayEdit} onSelect={() => onStatus("ignored")}>
                        <CircleSlash className="size-4" />
                        {t("issue.ignore")}
                    </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                {row.assignee?.id !== viewerId && (
                    <ContextMenuItem
                        disabled={!mayEdit}
                        onSelect={() => onAssign({ id: viewerId, name: t("assign.me") })}
                    >
                        <UserRound className="size-4" />
                        {t("assign.toMe")}
                    </ContextMenuItem>
                )}
                <ContextMenuItem disabled={!mayEdit} onSelect={onAssignOther}>
                    <UserPlus className="size-4" />
                    {t("menu.assign")}
                </ContextMenuItem>
                {row.assignee && (
                    <ContextMenuItem disabled={!mayEdit} onSelect={() => onAssign(null)}>
                        <UserMinus className="size-4" />
                        {t("assign.nobody")}
                    </ContextMenuItem>
                )}
                {mayTask && (
                    <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={onTask}>
                            <ListTodo className="size-4" />
                            {t("menu.createTask")}
                        </ContextMenuItem>
                    </>
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}
