"use client";

/**
 * The Telemetry screens: every project, every issue across them, and a
 * project's own inside - its issues, its event stream, its releases and its
 * setup - each a real address under /telemetry (see `paths.ts`).
 *
 * Each shell renders at once and the lists arrive into it a page at a time:
 * the heading, the section rail and the search bar never wait on the database.
 */

import Link from "next/link";
import * as paths from "./paths";
import * as actions from "./actions";
import * as polls from "./telemetry-polls";
import { useRouter } from "next/navigation";
import { EventPanel } from "./event-detail";
import { runAction } from "@/lib/run-action";
import { IssueStream } from "./issue-stream";
import { ProjectsGrid } from "./projects-grid";
import { AlertRules } from "./alert-rules";
import { ReporterRules } from "./reporter-rules";
import { IssueActivity } from "./issue-activity";
import { useCursorList } from "./use-cursor-list";
import { CopyButton } from "@/components/copy-button";
import { useShelfScope } from "@/components/shelf-scope";
import { useCallback, useEffect, useState } from "react";
import { SECTIONS, sectionFor } from "./project-sections";
import { RelativeTime } from "@/components/relative-time";
import type { PickedPerson } from "@/components/people-picker";
import { AssignDialog, CreateTaskDialog } from "./issue-dialogs";
import { EventStream, EventView, ReleaseList } from "./event-stream";
import { useDebounced } from "./use-debounced";
import {
    IGNORE_COUNTS,
    IGNORE_WINDOWS,
    ignoreColumns,
    withFilter,
    type IgnoreCondition,
    type IgnoreWindow,
    type IssueSort
} from "@/lib/telemetry/issue-query";
import {
    ArrowLeft,
    Bug,
    CircleCheck,
    CircleDot,
    ChevronDown,
    CircleSlash,
    ExternalLink,
    ListTodo,
    Plus,
    RotateCcw,
    Share2,
    Trash2,
    UserPlus,
    Search
} from "lucide-react";
import { ShareDialog } from "@/components/access/share-dialog";
import {
    Badge,
    Button,
    cn,
    ConfirmDeleteDialog,
    EmptyState,
    Input,
    ScrollRow,
    Skeleton,
    sameValue,
    Checkbox,
    publicDocHref,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

type Overview = actions.TelemetryOverview;
type Project = Overview["projects"][number];

export interface Viewer {
    readonly id: string;
    readonly name: string;
}

/** Every project, a page at a time. */
export function ProjectsHome({ mayCreate }: { mayCreate: boolean }) {
    const t = useTranslations("telemetry");
    const on = useShelfScope();
    const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
    const [draft, setDraft] = useState("");
    // Filtered by the database a page at a time, so it holds with thousands.
    const query = useDebounced(draft.trim(), 250);
    const list = useCursorList<Project>(
        (cursor, signal) => polls.telemetryProjects({ query, cursor }, signal),
        `${on}|${query}`
    );
    useEffect(() => {
        if (!sentinel || !list.more) return;
        const watcher = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) list.loadMore();
        });
        watcher.observe(sentinel);
        return () => watcher.disconnect();
    }, [sentinel, list]);

    const action = mayCreate ? <NewProject onDone={async () => list.reload()} /> : null;
    const search = (
        <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={80}
                placeholder={t("grid.search")}
                aria-label={t("grid.search")}
                className="h-8 pl-7 text-sm"
            />
        </div>
    );
    if (list.items === null) {
        return (
            <div className="flex flex-col gap-3" aria-busy="true">
                {(draft || query) && search}
                <div className="flex items-center justify-between gap-2">
                    <Skeleton className="h-4 w-24" />
                    {action}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                </div>
            </div>
        );
    }
    if (list.items.length === 0 && query) {
        return (
            <div className="flex flex-col gap-3">
                {search}
                <EmptyState icon={<Search />} title={t("grid.noMatch")} description={t("grid.noMatchHint")} />
                {list.error && <p role="alert" className="text-sm text-danger">{list.error}</p>}
            </div>
        );
    }
    if (list.items.length === 0) {
        return (
            <>
                <EmptyState
                    icon={<Bug />}
                    title={t("view.none")}
                    description={t("view.noneHint")}
                    action={action ?? undefined}
                />
                {list.error && <p className="mt-3 text-sm text-danger">{list.error}</p>}
            </>
        );
    }
    return (
        <div className="flex flex-col gap-4">
            {search}
            <ProjectsGrid projects={list.items} hrefFor={(id) => paths.projectHref(id)} action={action} />
            {list.error && <p role="alert" className="text-sm text-danger">{list.error}</p>}
            {list.more && (
                <div ref={setSentinel} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
                    <Skeleton className="h-24 w-full" />
                </div>
            )}
        </div>
    );
}

const IGNORE_WINDOW_KEYS: Readonly<Record<IgnoreWindow, NamespaceKey<"telemetry">>> = {
    "1h": "ignore.hour",
    "24h": "ignore.day",
    "7d": "ignore.week"
};

/** What an ignored issue's button says: until when, or for how many more. */
function ignoredLabel(
    t: ReturnType<typeof useTranslations<"telemetry">>,
    issue: Pick<actions.OpenIssue, "ignoredUntil" | "ignoreUntilSeen" | "timesSeen">,
    locale: string
): string {
    if (issue.ignoredUntil) {
        const at = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
            new Date(issue.ignoredUntil)
        );
        return t("ignore.until", { at });
    }
    if (issue.ignoreUntilSeen !== null) {
        return t("ignore.left", { count: Math.max(1, issue.ignoreUntilSeen - issue.timesSeen) });
    }
    return t("issue.ignored");
}

/** A search's address: the screen it is on, with the search and the order in it. */
function searchHref(base: string, query: string, sort: IssueSort): string {
    const params = new URLSearchParams();
    params.set("query", query);
    if (sort !== "lastSeen") params.set("sort", sort);
    return `${base}?${params.toString()}`;
}

/** Every issue across the projects this reader can see. */
export function IssuesHome({
    query,
    sort,
    viewer,
    mayTask
}: {
    query: string;
    sort: IssueSort;
    viewer: Viewer;
    mayTask: boolean;
}) {
    const router = useRouter();
    return (
        <IssueStream
            projectId={null}
            query={query}
            sort={sort}
            viewerId={viewer.id}
            mayTask={mayTask}
            windowDays={30}
            onSearch={(next, order) => router.replace(searchHref(paths.ISSUES_HREF, next, order))}
        />
    );
}

export function TelemetryView({
    projectId,
    section,
    itemId,
    query,
    sort,
    viewer,
    mayTask
}: {
    projectId: string;
    section: string;
    /** The issue or the event a section is open on. */
    itemId: string | null;
    query: string;
    sort: IssueSort;
    viewer: Viewer;
    mayTask: boolean;
}) {
    const t = useTranslations("telemetry");
    const router = useRouter();
    const [data, setData] = useState<Overview | null>(null);
    const on = useShelfScope();
    const [error, setError] = useState("");
    const [sharing, setSharing] = useState(false);

    const load = useCallback(async () => {
        void on;
        const result = await runAction(() => polls.telemetryOverview({ projectId }), setError);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setData(result.data ?? null);
    }, [on, projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    const project = data?.projects[0] ?? null;
    const readOnly = project?.access === "view";
    const open = sectionFor(section);
    const visible = SECTIONS.filter(
        (entry) =>
            (!readOnly || entry.readOnly) &&
            (entry.key !== "releases" || data?.hasReleases || open === "releases") &&
            (entry.key !== "environments" || data?.hasEnvironments || open === "environments")
    );

    const failure = error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
            {error}
        </p>
    );

    if (data && !project) {
        return (
            <div className="flex flex-col gap-3">
                <Link href={paths.PROJECTS_HREF} className="text-sm text-primary hover:underline">
                    {t("view.projects")}
                </Link>
                {failure}
            </div>
        );
    }

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" asChild>
                    <Link href={paths.PROJECTS_HREF}>
                        <ArrowLeft className="size-3.5" />
                        {t("view.projects")}
                    </Link>
                </Button>
                <span className="text-muted-foreground/40">/</span>
                {project ? (
                    <h2 className="min-w-0 truncate text-sm font-medium">{project.name}</h2>
                ) : (
                    <Skeleton className="h-4 w-32" />
                )}
                {project?.shared ? (
                    <Badge variant="neutral">
                        {project.access === "edit" ? t("view.sharedToEdit") : t("view.sharedWithYou")}
                    </Badge>
                ) : null}
                {project?.access === "owner" ? (
                    <Button variant="outline" size="sm" className="shrink-0" onClick={() => setSharing(true)}>
                        <Share2 aria-hidden="true" />
                        {t("view.share")}
                    </Button>
                ) : null}
                {sharing && project ? (
                    <ShareDialog
                        open
                        onOpenChange={(next) => {
                            if (!next) setSharing(false);
                        }}
                        subject="telemetry.project"
                        subjectId={project.id}
                        name={project.name}
                    />
                ) : null}
            </div>

            {failure}

            <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:gap-6">
                <SectionNav projectId={projectId} open={open} sections={visible} counts={data?.counts ?? null} />
                <div className="min-w-0 flex-1">
                    {open === "issues" &&
                        (itemId ? (
                            <IssueScreen
                                projectId={projectId}
                                issueId={itemId}
                                readOnly={readOnly || !project}
                                viewer={viewer}
                                mayTask={mayTask}
                                onChanged={load}
                            />
                        ) : (
                            <IssueStream
                                projectId={projectId}
                                query={query}
                                sort={sort}
                                viewerId={viewer.id}
                                mayTask={mayTask}
                                windowDays={data?.windowDays ?? 30}
                                onSearch={(next, order) =>
                                    router.replace(searchHref(paths.projectHref(projectId), next, order))
                                }
                            />
                        ))}
                    {open === "events" &&
                        (itemId ? (
                            <EventView
                                projectId={projectId}
                                eventId={itemId}
                                backHref={paths.projectHref(projectId, "events")}
                                issueHref={(issueId) => paths.issueHref(projectId, issueId)}
                            />
                        ) : (
                            <EventStream
                                projectId={projectId}
                                hrefFor={(event) => paths.projectHref(projectId, "events", event.id)}
                            />
                        ))}
                    {open === "releases" && (
                        <ReleaseList
                            projectId={projectId}
                            issuesHref={(release) =>
                                searchHref(
                                    paths.projectHref(projectId),
                                    withFilter("", { release }),
                                    "lastSeen"
                                )
                            }
                        />
                    )}
                    {open === "environments" && (
                        <ReleaseList
                            kind="environment"
                            projectId={projectId}
                            issuesHref={(environment) =>
                                searchHref(
                                    paths.projectHref(projectId),
                                    withFilter("", { environment }),
                                    "lastSeen"
                                )
                            }
                        />
                    )}
                    {!project &&
                        open !== "issues" &&
                        open !== "events" &&
                        open !== "releases" &&
                        open !== "environments" && (
                        <div className="flex flex-col gap-3" aria-busy="true">
                            <Skeleton className="h-8 w-72 max-w-full" />
                            <Skeleton className="h-40 w-full" />
                        </div>
                    )}
                    {project && !readOnly && open === "client" && <ProjectAddress project={project} onDone={load} />}
                    {project && !readOnly && open === "reporters" && <ReporterRules project={project} onDone={load} />}
                    {project && !readOnly && open === "alerts" && (
                        <AlertRules projectId={project.id} />
                    )}
                    {project && !readOnly && open === "settings" && (
                        <ProjectSettings project={project} onDone={load} />
                    )}
                    {project && readOnly && !SECTIONS.find((entry) => entry.key === open)?.readOnly && (
                        <p className="text-sm text-muted-foreground">{t("view.ownerOnly")}</p>
                    )}
                </div>
            </div>
        </div>
    );
}

/** The project's own rail: each section is an address, so a link lands on it. */
function SectionNav({
    projectId,
    open,
    sections,
    counts
}: {
    projectId: string;
    open: string;
    sections: typeof SECTIONS;
    counts: Readonly<Record<string, number>> | null;
}) {
    const t = useTranslations("telemetry");
    return (
        <nav className="lg:w-48 lg:shrink-0" aria-label={t("view.sections")}>
            <ScrollRow
                as="ul"
                className="-mx-1 flex gap-1 px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0"
            >
                {sections.map((section) => {
                    const active = section.key === open;
                    const Icon = section.icon;
                    return (
                        <li key={section.key} className="shrink-0 lg:shrink">
                            <Link
                                href={paths.projectHref(projectId, section.key)}
                                title={t(`sections.${section.key}.hint` as NamespaceKey<"telemetry">)}
                                aria-current={active ? "page" : undefined}
                                className={cn(
                                    "flex w-full min-w-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted",
                                    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
                                )}
                            >
                                <Icon className="size-3.5 shrink-0" />
                                <span className="truncate">
                                    {t(`sections.${section.key}.label` as NamespaceKey<"telemetry">)}
                                </span>
                                {section.key === "issues" && counts?.unresolved !== undefined && (
                                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                                        {counts.unresolved}
                                    </span>
                                )}
                            </Link>
                        </li>
                    );
                })}
            </ScrollRow>
        </nav>
    );
}

/** One issue: what it is, who has it, what was done about it, and its events. */
function IssueScreen({
    projectId,
    issueId,
    readOnly,
    viewer,
    mayTask,
    onChanged
}: {
    projectId: string;
    issueId: string;
    readOnly: boolean;
    viewer: Viewer;
    mayTask: boolean;
    onChanged: () => Promise<void>;
}) {
    const t = useTranslations("telemetry");
    const locale = useLocale();
    const router = useRouter();
    const [issue, setIssue] = useState<actions.OpenIssue | null>(null);
    const [error, setError] = useState("");
    const [removing, setRemoving] = useState(false);
    const [assigning, setAssigning] = useState(false);
    const [tasking, setTasking] = useState(false);
    const [tab, setTab] = useState<"latest" | "events">("latest");
    const [version, setVersion] = useState(0);

    useEffect(() => {
        let live = true;
        setIssue(null);
        void runAction(() => polls.telemetryIssue(projectId, issueId), setError).then((result) => {
            if (!live || !result) return;
            if (result.error) setError(result.error);
            setIssue(result.issue ?? null);
        });
        return () => {
            live = false;
        };
    }, [projectId, issueId]);

    /** Show the change now, and put it back if the server says no. */
    const change = async (
        next: Partial<actions.OpenIssue>,
        send: () => Promise<{ error?: string }>
    ) => {
        if (!issue) return;
        const before = issue;
        setIssue({ ...issue, ...next });
        const result = await runAction(send, setError);
        if (!result || result.error) {
            setIssue(before);
            if (result?.error) setError(result.error);
            return;
        }
        setError("");
        setVersion((value) => value + 1);
        await onChanged();
    };

    const status = (value: string, mode?: "now" | "nextRelease") =>
        change(
            {
                status: value,
                resolvedInRelease: value === "resolved" && mode === "nextRelease" ? issue?.lastRelease ?? null : null,
                ignoredUntil: null,
                ignoreUntilSeen: null
            },
            () => actions.bulkStatusAction({ issueIds: [issueId], status: value, ...(mode ? { mode } : {}) })
        );
    const ignore = (condition: IgnoreCondition = {}) => {
        const until = ignoreColumns(condition, issue?.timesSeen ?? 0, new Date());
        return change(
            {
                status: "ignored",
                resolvedInRelease: null,
                ignoredUntil: until.ignoredUntil?.toISOString() ?? null,
                ignoreUntilSeen: until.ignoreUntilSeen
            },
            () => actions.bulkStatusAction({ issueIds: [issueId], status: "ignored", ...condition })
        );
    };
    const assign = (person: PickedPerson | null) =>
        change({ assignee: person }, () =>
            actions.assignIssuesAction({ issueIds: [issueId], assigneeId: person?.id ?? null })
        );

    const back = paths.projectHref(projectId);
    if (!issue) {
        return (
            <div className="flex flex-col gap-4" aria-busy={!error}>
                <div className="flex items-center gap-2">
                    <Link
                        href={back}
                        aria-label={t("issue.back")}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <ArrowLeft className="size-4" />
                    </Link>
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : (
                        <Skeleton className="h-5 w-72 max-w-full" />
                    )}
                </div>
                {!error && (
                    <>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <Skeleton className="h-14 w-full" />
                            <Skeleton className="h-14 w-full" />
                            <Skeleton className="h-14 w-full" />
                            <Skeleton className="h-14 w-full" />
                        </div>
                        <Skeleton className="h-64 w-full" />
                    </>
                )}
            </div>
        );
    }

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="flex min-w-0 flex-wrap items-start gap-2">
                <Link
                    href={back}
                    aria-label={t("issue.back")}
                    className="mt-0.5 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                <div className="min-w-0 flex-1">
                    <h2 className="line-clamp-3 break-words text-base font-semibold" title={issue.title}>
                        {issue.title}
                    </h2>
                    <p className="break-all text-xs text-muted-foreground">{issue.culprit}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2" title={readOnly ? t("bulk.readOnly") : undefined}>
                    {issue.status === "resolved" ? (
                        <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => status("unresolved")}>
                            <CircleDot className="size-4" />
                            {issue.resolvedInRelease
                                ? t("issue.resolvedIn", { release: issue.resolvedInRelease })
                                : t("issue.resolved")}
                        </Button>
                    ) : (
                        <>
                            <Button size="sm" disabled={readOnly} onClick={() => status("resolved", "now")}>
                                <CircleCheck className="size-4" />
                                {t("issue.resolve")}
                            </Button>
                            {issue.lastRelease && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={readOnly}
                                    title={t("menu.resolveNextHint", { release: issue.lastRelease })}
                                    onClick={() => status("resolved", "nextRelease")}
                                >
                                    {t("menu.resolveNext")}
                                </Button>
                            )}
                        </>
                    )}
                    {issue.status === "ignored" ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={readOnly}
                            title={t("menu.unignore")}
                            onClick={() => status("unresolved")}
                        >
                            <CircleSlash className="size-4" />
                            <span className="max-w-56 truncate">{ignoredLabel(t, issue, locale)}</span>
                        </Button>
                    ) : (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="ghost" disabled={readOnly}>
                                    <CircleSlash className="size-4" />
                                    {t("issue.ignore")}
                                    <ChevronDown className="size-3.5" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => void ignore()}>{t("ignore.forever")}</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {IGNORE_WINDOWS.map((window) => (
                                    <DropdownMenuItem key={window} onSelect={() => void ignore({ ignoreFor: window })}>
                                        {t(IGNORE_WINDOW_KEYS[window])}
                                    </DropdownMenuItem>
                                ))}
                                <DropdownMenuSeparator />
                                {IGNORE_COUNTS.map((count) => (
                                    <DropdownMenuItem key={count} onSelect={() => void ignore({ ignoreCount: count })}>
                                        {t("ignore.count", { count })}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                    <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => setAssigning(true)}>
                        <UserPlus className="size-4" />
                        <span className="max-w-32 truncate">{issue.assignee?.name ?? t("menu.assign")}</span>
                    </Button>
                    {mayTask && (
                        <Button size="sm" variant="ghost" onClick={() => setTasking(true)}>
                            <ListTodo className="size-4" />
                            {t("menu.createTask")}
                        </Button>
                    )}
                    {!readOnly && (
                        <button
                            type="button"
                            title={t("issue.delete")}
                            aria-label={t("issue.delete")}
                            onClick={() => setRemoving(true)}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                        >
                            <Trash2 className="size-4" />
                        </button>
                    )}
                </div>
            </div>
            {error && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {error}
                </p>
            )}

            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                <Fact label={t("issue.timesSeen")} value={String(issue.timesSeen)} />
                <Fact label={t("issue.users")} value={String(issue.userCount)} />
                <Fact label={t("issue.firstSeen")} value={<RelativeTime iso={issue.firstSeen} />} />
                <Fact label={t("issue.lastSeen")} value={<RelativeTime iso={issue.lastSeen} />} />
                <Fact
                    label={t("issue.where")}
                    value={issue.environments.join(", ") || issue.lastRelease || t("issue.notStated")}
                />
            </dl>

            <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
                {(["latest", "events"] as const).map((key) => (
                    <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={tab === key}
                        onClick={() => setTab(key)}
                        className={cn(
                            "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-1.5 text-sm transition-colors",
                            tab === key
                                ? "border-primary font-medium text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {key === "latest" ? t("issue.latestTab") : t("issue.eventsTab", { count: issue.kept })}
                    </button>
                ))}
            </div>
            {tab === "latest" ? (
                issue.latest ? (
                    <EventPanel event={issue.latest} kept={issue.kept} />
                ) : (
                    <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                        {t("issue.pruned")}
                    </p>
                )
            ) : (
                <EventStream
                    projectId={projectId}
                    issueId={issueId}
                    hrefFor={(event) => paths.projectHref(projectId, "events", event.id)}
                />
            )}

            <IssueActivity projectId={projectId} issueId={issueId} viewer={viewer} version={version} />

            <AssignDialog
                open={assigning}
                onOpenChange={setAssigning}
                projectId={projectId}
                current={issue.assignee}
                count={1}
                viewerId={viewer.id}
                onAssign={(person) => void assign(person)}
            />
            <CreateTaskDialog
                issue={tasking ? { ...issue, projectId } : null}
                onOpenChange={setTasking}
                onCreated={() => setVersion((value) => value + 1)}
            />
            <ConfirmDeleteDialog
                open={removing}
                onOpenChange={setRemoving}
                name={issue.title}
                kind={t("issue.kind")}
                requireTyping={false}
                description={t("issue.deleteBody")}
                confirmLabel={t("issue.deleteConfirm")}
                onConfirm={async () => {
                    setRemoving(false);
                    const result = await runAction(() => actions.deleteIssueAction(projectId, issueId), setError);
                    if (!result?.error) {
                        await onChanged();
                        router.push(back);
                    }
                }}
            />
        </div>
    );
}

/** How long this project keeps what it is sent, and whether it is listening at
 *  all. The two things about a project that are not its address. */
function ProjectSettings({
    project,
    onDone
}: {
    project: Overview["projects"][number];
    onDone: () => Promise<void>;
}) {
    const t = useTranslations("telemetry");
    const [days, setDays] = useState(String(project.retentionDays));
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => setDays(String(project.retentionDays)), [project.retentionDays]);

    return (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
            <div>
                <p className="text-sm font-medium">{t("settings.keepFor")}</p>
                <p className="text-xs text-muted-foreground">{t("settings.keepHint")}</p>
            </div>
            <div className="flex items-center gap-2">
                <Input
                    type="number"
                    min={1}
                    max={365}
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                    aria-label={t("settings.daysLabel")}
                    className="w-28"
                />
                <span className="text-xs text-muted-foreground">{t("settings.days")}</span>
                <Button
                    size="sm"
                    disabled={saving || sameValue(days, project.retentionDays)}
                    onClick={async () => {
                        setSaving(true);
                        await runAction(
                            () =>
                                actions.updateTelemetryProjectAction(project.id, {
                                    retentionDays: Number(days)
                                }),
                            setError
                        );
                        setSaving(false);
                        await onDone();
                    }}
                >
                    {t("settings.save")}
                </Button>
            </div>
            <label className="flex items-center gap-2 text-sm">
                <Checkbox
                    checked={project.enabled}
                    onChange={async (event) => {
                        await runAction(
                            () =>
                                actions.updateTelemetryProjectAction(project.id, {
                                    enabled: event.target.checked
                                }),
                            setError
                        );
                        await onDone();
                    }}
                />
                {t("settings.accept")}
            </label>
            <p className="text-xs text-muted-foreground">{t("settings.acceptHint")}</p>
            {error && <p className="text-xs text-danger">{error}</p>}
        </div>
    );
}

function NewProject({ onDone }: { onDone: () => Promise<void> }) {
    const t = useTranslations("telemetry");
    const [name, setName] = useState("");
    const [open, setOpen] = useState(false);
    const [error, setError] = useState("");

    if (!open) {
        return (
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
                <Plus className="size-4" />
                {t("view.newProject")}
            </Button>
        );
    }
    return (
        <div className="flex items-center gap-2">
            <Input
                value={name}
                autoFocus
                placeholder={t("view.name")}
                className="h-8 w-44"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={async (event) => {
                    if (event.key !== "Enter" || !name.trim()) return;
                    const result = await runAction(
                        () => actions.createTelemetryProjectAction(name.trim()),
                        setError
                    );
                    if (!result?.error) {
                        setOpen(false);
                        setName("");
                        await onDone();
                    }
                }}
            />
            {error && <span className="text-xs text-danger">{error}</span>}
        </div>
    );
}

/**
 * The address, which is the whole integration.
 *
 * Shown as the string a client wants rather than as a key and a host to assemble:
 * what somebody does with this screen is copy one line into a configuration file,
 * and anything that makes them build it themselves is a step where it goes wrong.
 */
function ProjectAddress({
    project,
    onDone
}: {
    project: Overview["projects"][number];
    onDone: () => Promise<void>;
}) {
    const t = useTranslations("telemetry");
    const locale = useLocale();
    const [dsn, setDsn] = useState(project.dsn);
    const [error, setError] = useState("");
    const [removing, setRemoving] = useState(false);

    useEffect(() => setDsn(project.dsn), [project.dsn]);

    return (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                    {t("client.reportTo")}
                </span>
                <code className="min-w-0 flex-1 basis-64 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                    {dsn}
                </code>
                <CopyButton value={dsn} label={t("client.copy")} />
                {/* A new key breaks every client reporting with the old one, and
                    deleting the project loses everything it recorded: both stay
                    with its owner, as the server answers them. */}
                {project.access === "owner" && (
                    <button
                        type="button"
                        title={t("client.rotate")}
                        aria-label={t("client.rotate")}
                        onClick={async () => {
                            const result = await runAction(
                                () => actions.rotateTelemetryKeyAction(project.id),
                                setError
                            );
                            if (result?.dsn) setDsn(result.dsn);
                            await onDone();
                        }}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <RotateCcw className="size-3.5" />
                    </button>
                )}
                {project.access === "owner" && !project.system && (
                    <button
                        type="button"
                        title={t("client.delete")}
                        aria-label={t("client.delete")}
                        onClick={() => setRemoving(true)}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                    >
                        <Trash2 className="size-3.5" />
                    </button>
                )}
            </div>
            <p className="text-xs text-muted-foreground">
                {t("client.hint", { days: project.retentionDays })}
            </p>
            <a
                href={publicDocHref(locale, "telemetry")}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
            >
                {t("client.guide")}
                <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
            {error && <p className="text-xs text-danger">{error}</p>}

            <ConfirmDeleteDialog
                open={removing}
                onOpenChange={setRemoving}
                name={project.name}
                kind={t("client.kind")}
                requireTyping
                description={t("client.deleteBody")}
                confirmLabel={t("client.deleteConfirm")}
                onConfirm={async () => {
                    await runAction(
                        () => actions.deleteTelemetryProjectAction(project.id),
                        setError
                    );
                    setRemoving(false);
                    await onDone();
                }}
            />
        </div>
    );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="rounded-lg border border-border bg-surface px-3 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd
                className="truncate text-sm font-medium"
                title={typeof value === "string" ? value : undefined}
            >
                {value}
            </dd>
        </div>
    );
}
