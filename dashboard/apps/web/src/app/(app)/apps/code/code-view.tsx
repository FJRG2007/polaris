"use client";

/**
 * The list of pull requests and issues.
 *
 * Filters first, and they are the questions people actually arrive with:
 * what is waiting on my review, what did I open, what am I assigned. "Everything"
 * is last because it is the one nobody scrolls to the end of.
 *
 * The kind - pull requests or issues - is a segmented control rather than two
 * screens, because the answer to "what is waiting on me" spans both and the
 * filters either side of it are identical.
 *
 * A row is the whole state at a glance: the icon says open, merged, closed or
 * draft before the title is read, which is the one thing a list of thirty of
 * these has to get right.
 */

import Link from "next/link";
import { listWorkAction } from "./actions";
import { RelativeTime } from "@/components/relative-time";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn, EmptyState, SegmentedControl, Skeleton } from "@polaris/ui";
import type { CodeItem, CodeKind, CodeScope, CodeState } from "@/lib/code/code-service";
import {
    CircleDot,
    CircleSlash,
    ExternalLink,
    GitMerge,
    GitPullRequest,
    GitPullRequestDraft,
    MessageSquare,
    Search
} from "lucide-react";

/** How long typing pauses before the list is asked again. GitHub's search takes
 *  thirty requests a minute and a qualifier is thirty keystrokes, so a request
 *  per keystroke spends the whole allowance on one line of typing. Only typing
 *  waits: arriving and pressing a filter are one request each and go at once. */
const SEARCH_AFTER = 300;

/** The filters, in the order somebody reaches for them. */
const SCOPES: { value: CodeScope; label: string }[] = [
    { value: "review", label: "Waiting on my review" },
    { value: "assigned", label: "Assigned to me" },
    { value: "created", label: "Opened by me" },
    { value: "mentioned", label: "I was mentioned" },
    { value: "all", label: "Everything I am in" }
];

export function CodeView() {
    const [kind, setKind] = useState<CodeKind>("pr");
    const [scope, setScope] = useState<CodeScope>("review");
    const [state, setState] = useState<CodeState>("open");
    const [query, setQuery] = useState("");
    const [items, setItems] = useState<readonly CodeItem[] | null>(null);
    const [error, setError] = useState("");
    // Answers can come back out of order; only the newest one may win.
    const asked = useRef(0);

    // Issues have no review to wait on, so the filter that makes no sense for
    // them is corrected rather than left to return nothing forever.
    const effectiveScope: CodeScope = kind === "issue" && scope === "review" ? "assigned" : scope;

    useEffect(() => {
        const mine = ++asked.current;
        setItems(null);
        setError("");
        const timer = setTimeout(
            async () => {
                const result = await listWorkAction({ kind, scope: effectiveScope, state, query });
                if (mine !== asked.current) return;
                if (result.error) {
                    setError(result.error);
                    setItems([]);
                    return;
                }
                setItems(result.items ?? []);
            },
            query.trim() ? SEARCH_AFTER : 0
        );
        return () => clearTimeout(timer);
    }, [kind, effectiveScope, state, query]);

    const scopes = useMemo(
        () => (kind === "issue" ? SCOPES.filter((entry) => entry.value !== "review") : SCOPES),
        [kind]
    );

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                    value={kind}
                    onValueChange={(next) => setKind(next as CodeKind)}
                    aria-label="What to list"
                    options={[
                        { value: "pr", label: "Pull requests" },
                        { value: "issue", label: "Issues" }
                    ]}
                />
                <SegmentedControl
                    value={state}
                    onValueChange={(next) => setState(next as CodeState)}
                    size="sm"
                    aria-label="Which ones"
                    options={[
                        { value: "open", label: "Open" },
                        { value: "closed", label: "Closed" },
                        { value: "all", label: "All" }
                    ]}
                />
                <div className="relative ml-auto min-w-[12rem] flex-1 sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Narrow it: repo:owner/name, label:bug"
                        aria-label="Narrow the list"
                        className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs hover:border-border-strong focus:border-border-strong"
                    />
                </div>
            </div>

            <div className="flex flex-wrap gap-1">
                {scopes.map((entry) => (
                    <button
                        key={entry.value}
                        type="button"
                        onClick={() => setScope(entry.value)}
                        className={cn(
                            "rounded-md px-2 py-1 text-xs transition-colors",
                            effectiveScope === entry.value
                                ? "bg-card-hover font-medium text-foreground"
                                : "text-muted-foreground hover:bg-muted"
                        )}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>

            {error && (
                <p
                    role="alert"
                    className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
                >
                    {error}
                </p>
            )}

            {items === null ? (
                <div className="flex flex-col gap-2" aria-hidden="true">
                    {[0, 1, 2, 3, 4].map((row) => (
                        <Skeleton key={row} className="h-14 w-full" />
                    ))}
                </div>
            ) : items.length === 0 && !error ? (
                <EmptyState
                    icon={<GitPullRequest />}
                    title="Nothing here."
                    description={
                        kind === "pr"
                            ? "No pull request matches that filter."
                            : "No issue matches that filter."
                    }
                />
            ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                    {items.map((item) => (
                        <li key={item.id}>
                            <WorkRow item={item} />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function WorkRow({ item }: { item: CodeItem }) {
    const [owner, repo] = item.repo.split("/");
    const href = owner && repo ? `/apps/code/${owner}/${repo}/${item.number}` : item.url;

    return (
        <div className="flex items-start gap-3 bg-card px-3 py-2.5 transition-colors hover:bg-card-hover">
            <StateIcon state={item.state} kind={item.kind} />
            <div className="min-w-0 flex-1">
                <Link href={href} className="block truncate text-sm font-medium" title={item.title}>
                    {item.title}
                </Link>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="truncate" title={item.repo}>
                        {item.repo}
                    </span>
                    <span>#{item.number}</span>
                    <span>
                        by {item.authorLogin}, updated <RelativeTime iso={item.updatedAt} />
                    </span>
                    {item.labels.slice(0, 3).map((label) => (
                        <span
                            key={label.name}
                            className="rounded-full px-1.5 py-px text-[10px] ring-1"
                            style={{
                                color: label.color,
                                boxShadow: `inset 0 0 0 1px ${label.color}55`
                            }}
                        >
                            {label.name}
                        </span>
                    ))}
                </p>
            </div>
            {item.comments > 0 && (
                <span className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted-foreground">
                    <MessageSquare className="size-3.5" />
                    {item.comments}
                </span>
            )}
            <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open on GitHub"
                title="Open on GitHub"
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <ExternalLink className="size-3.5" />
            </a>
        </div>
    );
}

/** The state, before the title is read. Four shapes and four colours, which is
 *  what GitHub itself settled on and what everybody who reads these already
 *  knows. */
export function StateIcon({ state, kind }: { state: CodeItem["state"]; kind: CodeKind }) {
    if (kind === "issue") {
        return state === "closed" ? (
            <CircleSlash className="mt-0.5 size-4 shrink-0 text-[#8957e5]" aria-label="Closed" />
        ) : (
            <CircleDot className="mt-0.5 size-4 shrink-0 text-[#3fb950]" aria-label="Open" />
        );
    }
    if (state === "merged") {
        return <GitMerge className="mt-0.5 size-4 shrink-0 text-[#a371f7]" aria-label="Merged" />;
    }
    if (state === "closed") {
        return (
            <GitPullRequest className="mt-0.5 size-4 shrink-0 text-[#f85149]" aria-label="Closed" />
        );
    }
    if (state === "draft") {
        return (
            <GitPullRequestDraft
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-label="Draft"
            />
        );
    }
    return <GitPullRequest className="mt-0.5 size-4 shrink-0 text-[#3fb950]" aria-label="Open" />;
}
