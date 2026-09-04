"use client";

/**
 * What broke, and one of them in full.
 *
 * Two states of the same screen rather than two routes: a list of faults, and a
 * fault opened. Which one is in the URL, so a link to a crash is a link to that
 * crash rather than to "the telemetry app, go and find it".
 *
 * The list is ordered by when each fault was last seen, because the question
 * somebody opens this with is what is happening now. Everything else - how often,
 * since when, in which release - is on the row, so the answer to "is this the one
 * I fixed on Tuesday" does not need a click.
 */

import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { CopyButton } from "@/components/copy-button";
import { RelativeTime } from "@/components/relative-time";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventDetail, IssueDetail, IssueRow } from "@/lib/telemetry/report-service";
import {
    ArrowLeft,
    Bug,
    CircleCheck,
    CircleSlash,
    Plus,
    RotateCcw,
    Search,
    Trash2
} from "lucide-react";
import {
    cn,
    Button,
    ConfirmDeleteDialog,
    EmptyState,
    Input,
    SegmentedControl,
    Select,
    Skeleton
} from "@polaris/ui";

type Overview = actions.TelemetryOverview;

const STATUS_TABS = [
    { value: "unresolved", label: "Unresolved" },
    { value: "resolved", label: "Resolved" },
    { value: "ignored", label: "Ignored" },
    { value: "all", label: "All" }
];

/** What a level looks like. Colour rather than a word, because the word is
 *  already in the title of half the rows. */
const LEVEL_TONE: Record<string, string> = {
    fatal: "bg-danger",
    error: "bg-danger/70",
    warning: "bg-warning",
    info: "bg-primary/60",
    debug: "bg-muted-foreground/50"
};

export function TelemetryView({
    projectId,
    issueId,
    status
}: {
    projectId: string | null;
    issueId: string | null;
    status: string;
}) {
    const router = useRouter();
    const [data, setData] = useState<Overview | null>(null);
    const [issue, setIssue] = useState<IssueDetail | null>(null);
    const [query, setQuery] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        const result = await actions.telemetryOverviewAction({ projectId, status, query });
        if (result.error) {
            setError(result.error);
            return;
        }
        setData(result.data ?? null);
    }, [projectId, status, query]);

    useEffect(() => {
        void load();
    }, [load]);

    const project = useMemo(
        () => data?.projects.find((entry) => entry.id === projectId) ?? data?.projects[0] ?? null,
        [data, projectId]
    );

    useEffect(() => {
        if (!issueId || !project) {
            setIssue(null);
            return;
        }
        let live = true;
        void actions.openIssueAction(project.id, issueId).then((result) => {
            if (!live) return;
            if (result.error) setError(result.error);
            setIssue(result.issue ?? null);
        });
        return () => {
            live = false;
        };
    }, [issueId, project]);

    const go = (next: { project?: string; issue?: string | null; status?: string }) => {
        const params = new URLSearchParams();
        const chosen = next.project ?? project?.id;
        if (chosen) params.set("project", chosen);
        const wanted = next.issue === undefined ? issueId : next.issue;
        if (wanted) params.set("issue", wanted);
        params.set("status", next.status ?? status);
        router.push(`/apps/telemetry?${params.toString()}`);
    };

    const act = async (run: () => Promise<{ error?: string }>) => {
        setBusy(true);
        const result = await runAction(run, setError);
        setBusy(false);
        if (!result?.error) {
            await load();
            router.refresh();
        }
        return result;
    };

    if (!data) {
        return (
            <div className="flex flex-col gap-3">
                <Skeleton className="h-9 w-72" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (data.projects.length === 0) {
        return (
            <>
                <EmptyState
                    icon={<Bug />}
                    title="Nothing is reporting yet."
                    description="Make a project and point an application at the address it gives you. Polaris opens one for itself the first time it has something to report."
                    action={<NewProject onDone={load} />}
                />
                {error && <p className="mt-3 text-sm text-danger">{error}</p>}
            </>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    value={project?.id ?? ""}
                    onValueChange={(value) => go({ project: value, issue: null })}
                    className="w-64"
                    options={data.projects.map((entry) => ({
                        value: entry.id,
                        label: entry.openIssues > 0 ? `${entry.name} (${entry.openIssues})` : entry.name
                    }))}
                />
                <NewProject onDone={load} />
                <div className="ml-auto flex items-center gap-2">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Find a fault"
                            aria-label="Find a fault"
                            className="h-8 w-52 rounded-md border border-border bg-field pl-7 pr-2 text-xs hover:border-border-strong focus:border-border-strong"
                        />
                    </div>
                </div>
            </div>

            {project && <ProjectAddress project={project} onDone={load} />}

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error}
                </p>
            )}

            {issue && project ? (
                <IssuePanel
                    issue={issue}
                    busy={busy}
                    onBack={() => go({ issue: null })}
                    onStatus={(next) =>
                        act(() => actions.setIssueStatusAction(project.id, issue.id, next))
                    }
                    onDelete={async () => {
                        const result = await act(() => actions.deleteIssueAction(project.id, issue.id));
                        if (!result?.error) go({ issue: null });
                    }}
                />
            ) : (
                <>
                    <SegmentedControl
                        value={status}
                        onValueChange={(value) => go({ status: value, issue: null })}
                        options={STATUS_TABS.map((tab) => ({
                            value: tab.value,
                            label:
                                data.counts[tab.value] === undefined
                                    ? tab.label
                                    : `${tab.label} ${data.counts[tab.value]}`
                        }))}
                    />
                    <IssueList
                        issues={data.issues}
                        windowDays={data.windowDays}
                        onOpen={(id) => go({ issue: id })}
                    />
                </>
            )}
        </div>
    );
}

function NewProject({ onDone }: { onDone: () => Promise<void> }) {
    const [name, setName] = useState("");
    const [open, setOpen] = useState(false);
    const [error, setError] = useState("");

    if (!open) {
        return (
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
                <Plus className="size-4" />
                New project
            </Button>
        );
    }
    return (
        <div className="flex items-center gap-2">
            <Input
                value={name}
                autoFocus
                placeholder="Name"
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
    const [dsn, setDsn] = useState(project.dsn);
    const [error, setError] = useState("");
    const [removing, setRemoving] = useState(false);

    useEffect(() => setDsn(project.dsn), [project.dsn]);

    return (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Report to</span>
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                    {dsn}
                </code>
                <CopyButton value={dsn} label="Copy the address" />
                <button
                    type="button"
                    title="Replace the key"
                    aria-label="Replace the key"
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
                {!project.system && (
                    <button
                        type="button"
                        title="Delete this project"
                        aria-label="Delete this project"
                        onClick={() => setRemoving(true)}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                    >
                        <Trash2 className="size-3.5" />
                    </button>
                )}
            </div>
            <p className="text-xs text-muted-foreground">
                Set it as the DSN of any Sentry client. Events older than {project.retentionDays} days
                are removed; how often each fault happened is kept.
            </p>
            {error && <p className="text-xs text-danger">{error}</p>}

            <ConfirmDeleteDialog
                open={removing}
                onOpenChange={setRemoving}
                name={project.name}
                kind="project"
                requireTyping
                description="Every fault it recorded goes with it, and the address stops being accepted."
                confirmLabel="Delete project"
                onConfirm={async () => {
                    await runAction(() => actions.deleteTelemetryProjectAction(project.id), setError);
                    setRemoving(false);
                    await onDone();
                }}
            />
        </div>
    );
}

function IssueList({
    issues,
    windowDays,
    onOpen
}: {
    issues: readonly IssueRow[];
    windowDays: number;
    onOpen: (id: string) => void;
}) {
    if (issues.length === 0) {
        return (
            <EmptyState
                icon={<CircleCheck />}
                title="Nothing here."
                description="No fault in this project matches what you are looking at."
            />
        );
    }
    return (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {issues.map((issue) => (
                <li key={issue.id}>
                    <button
                        type="button"
                        onClick={() => onOpen(issue.id)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted"
                    >
                        <span
                            aria-hidden="true"
                            className={cn("size-2 shrink-0 rounded-full", LEVEL_TONE[issue.level] ?? LEVEL_TONE.error)}
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate text-sm font-medium" title={issue.title}>
                                {issue.title}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                                {issue.culprit || "No stack"}
                                {issue.lastRelease ? ` - ${issue.lastRelease}` : ""}
                            </span>
                        </span>
                        <Sparkline daily={issue.daily} days={windowDays} />
                        <span className="w-16 shrink-0 text-right text-sm tabular-nums">
                            {issue.timesSeen}
                        </span>
                        <span className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground sm:block">
                            <RelativeTime iso={issue.lastSeen} />
                        </span>
                    </button>
                </li>
            ))}
        </ul>
    );
}

/** How often, over the window. Bars rather than a line: what somebody reads off
 *  this is "every day" against "once, last Tuesday", and a line between two
 *  points invents the days in between. */
function Sparkline({ daily, days }: { daily: readonly number[]; days: number }) {
    const peak = Math.max(1, ...daily);
    return (
        <span
            className="hidden h-7 shrink-0 items-end gap-px sm:flex"
            aria-label={`How often over the last ${days} days`}
        >
            {daily.map((count, at) => (
                <span
                    // The window is a fixed run of days, so the position is the
                    // identity: there is nothing else to key on and nothing moves.
                    key={at}
                    className={cn("w-1 rounded-sm", count > 0 ? "bg-primary/70" : "bg-muted")}
                    style={{ height: `${Math.max(6, (count / peak) * 100)}%` }}
                />
            ))}
        </span>
    );
}

function IssuePanel({
    issue,
    busy,
    onBack,
    onStatus,
    onDelete
}: {
    issue: IssueDetail;
    busy: boolean;
    onBack: () => void;
    onStatus: (status: string) => void;
    onDelete: () => void;
}) {
    const [removing, setRemoving] = useState(false);
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start gap-2">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back to the list"
                    className="mt-0.5 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ArrowLeft className="size-4" />
                </button>
                <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold" title={issue.title}>
                        {issue.title}
                    </h2>
                    <p className="truncate text-xs text-muted-foreground">{issue.culprit}</p>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant={issue.status === "resolved" ? "secondary" : "primary"}
                        disabled={busy}
                        onClick={() => onStatus(issue.status === "resolved" ? "unresolved" : "resolved")}
                    >
                        <CircleCheck className="size-4" />
                        {issue.status === "resolved" ? "Resolved" : "Resolve"}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onStatus(issue.status === "ignored" ? "unresolved" : "ignored")}
                    >
                        <CircleSlash className="size-4" />
                        {issue.status === "ignored" ? "Ignored" : "Ignore"}
                    </Button>
                    <button
                        type="button"
                        title="Delete this fault"
                        aria-label="Delete this fault"
                        onClick={() => setRemoving(true)}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                    >
                        <Trash2 className="size-4" />
                    </button>
                </div>
            </div>

            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Fact label="Times seen" value={String(issue.timesSeen)} />
                <Fact label="First seen" value={<RelativeTime iso={issue.firstSeen} />} />
                <Fact label="Last seen" value={<RelativeTime iso={issue.lastSeen} />} />
                <Fact
                    label="Where"
                    value={issue.environments.join(", ") || issue.lastRelease || "Not stated"}
                />
            </dl>

            {issue.latest ? (
                <EventPanel event={issue.latest} kept={issue.kept} />
            ) : (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                    Every occurrence of this has been removed by the project&apos;s retention. How
                    often it happened is kept.
                </p>
            )}

            <ConfirmDeleteDialog
                open={removing}
                onOpenChange={setRemoving}
                name={issue.title}
                kind="fault"
                requireTyping={false}
                description="Every occurrence goes with it. If it happens again it comes back as a new fault."
                confirmLabel="Delete"
                onConfirm={() => {
                    setRemoving(false);
                    onDelete();
                }}
            />
        </div>
    );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="rounded-lg border border-border bg-surface px-3 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate text-sm font-medium" title={typeof value === "string" ? value : undefined}>
                {value}
            </dd>
        </div>
    );
}

/** The occurrence itself: the stack, then what was happening around it. */
function EventPanel({ event, kept }: { event: EventDetail; kept: number }) {
    const tags = Object.entries(event.tags);
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                    Most recent of {kept === 1 ? "one kept occurrence" : `${kept} kept occurrences`}
                </span>
                {event.method && event.url && (
                    <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono">
                        {event.method} {event.url}
                    </code>
                )}
                {event.serverName && <span>on {event.serverName}</span>}
                {event.userLabel && <span>for {event.userLabel}</span>}
            </div>

            {event.frames.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-border">
                    <p className="border-b border-border bg-surface px-3 py-1.5 text-xs font-medium">
                        Stack
                    </p>
                    <ol className="divide-y divide-border">
                        {/* Innermost last, which is the order every client sends
                            and every debugger prints. */}
                        {event.frames.map((frame, at) => (
                            <li
                                key={`${frame.file}:${frame.line}:${at}`}
                                className={cn(
                                    "flex flex-wrap items-baseline gap-x-2 px-3 py-1.5 font-mono text-xs",
                                    frame.inApp ? "bg-transparent" : "bg-muted/40 text-muted-foreground"
                                )}
                            >
                                <span className="font-medium">{frame.function || "<anonymous>"}</span>
                                <span className="min-w-0 truncate" title={frame.file}>{frame.file}</span>
                                {frame.line !== null && <span className="text-muted-foreground">:{frame.line}</span>}
                                {frame.context && (
                                    <span className="w-full truncate pt-0.5 text-muted-foreground">
                                        {frame.context.trim()}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ol>
                </div>
            )}

            {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {tags.map(([name, value]) => (
                        <span
                            key={name}
                            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
                        >
                            {name}: <span className="text-foreground">{value}</span>
                        </span>
                    ))}
                </div>
            )}

            {event.breadcrumbs.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-border">
                    <p className="border-b border-border bg-surface px-3 py-1.5 text-xs font-medium">
                        What happened before it
                    </p>
                    <ol className="divide-y divide-border">
                        {event.breadcrumbs.map((crumb, at) => (
                            <li
                                key={`${crumb.at ?? at}:${at}`}
                                className="flex items-baseline gap-2 px-3 py-1.5 text-xs"
                            >
                                <span className="w-20 shrink-0 truncate text-muted-foreground">
                                    {crumb.category || crumb.type}
                                </span>
                                <span className="min-w-0 flex-1 truncate" title={crumb.message}>{crumb.message}</span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
        </div>
    );
}
