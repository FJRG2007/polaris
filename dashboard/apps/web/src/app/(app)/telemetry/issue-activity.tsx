"use client";

/**
 * An issue's log: what people said about it and what they did to it, newest
 * first, with a box to add to it. A comment shows at once and is taken back if
 * the server refuses it. Older entries arrive as the end of the log scrolls
 * into view, through the same cursor walk every other Telemetry list uses.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import * as actions from "./actions";
import * as polls from "./telemetry-polls";
import { runAction } from "@/lib/run-action";
import { useCursorList } from "./use-cursor-list";
import { Button, Skeleton, Textarea } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ActivityRow } from "@/lib/telemetry/workflow-service";

export function IssueActivity({
    projectId,
    issueId,
    viewer,
    version
}: {
    projectId: string;
    issueId: string;
    viewer: { id: string; name: string };
    /** Bumped by the screen after it changes the issue, so the log reads again. */
    version: number;
}) {
    const t = useTranslations("telemetry");
    const [body, setBody] = useState("");
    const [error, setError] = useState("");
    const [sentinel, setSentinel] = useState<HTMLLIElement | null>(null);
    const list = useCursorList<ActivityRow>(
        (cursor, signal) => polls.telemetryActivity({ projectId, issueId, cursor }, signal),
        `${projectId}|${issueId}|${version}`
    );
    const { more, loadMore } = list;

    // The next page is asked for when the end of the log comes into view, a
    // little before it, so scrolling down never stops on an empty edge.
    useEffect(() => {
        if (!sentinel || !more) return;
        const watcher = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) loadMore();
            },
            { rootMargin: "200px 0px" }
        );
        watcher.observe(sentinel);
        return () => watcher.disconnect();
    }, [sentinel, more, loadMore]);

    const say = (row: ActivityRow): React.ReactNode => {
        switch (row.kind) {
            case "comment":
                return <p className="whitespace-pre-wrap break-words text-sm">{row.body}</p>;
            case "status":
                if (row.body === "regressed") return t("activity.regressed");
                if (row.body === "unignored") return t("activity.unignored");
                return t("activity.status", {
                    status: t(
                        row.body === "resolvedNextRelease"
                            ? "activity.resolvedNextRelease"
                            : row.body === "resolved"
                              ? "view.statuses.resolved"
                              : row.body === "ignored"
                                ? "view.statuses.ignored"
                                : "view.statuses.unresolved"
                    )
                });
            case "assign":
                return row.body ? t("activity.assigned", { name: row.body }) : t("activity.unassigned");
            case "task":
                return row.ref ? (
                    <>
                        {t("activity.task")}{" "}
                        <Link href={`/tasks/t/${row.ref}`} className="text-primary hover:underline">
                            {row.body}
                        </Link>
                    </>
                ) : (
                    t("activity.task")
                );
            default:
                return row.body;
        }
    };

    const send = async () => {
        const text = body.trim();
        if (!text) return;
        const draft: ActivityRow = {
            id: `draft-${Date.now()}`,
            kind: "comment",
            body: text,
            ref: null,
            at: new Date().toISOString(),
            actor: viewer
        };
        list.setItems((rows) => [draft, ...rows]);
        setBody("");
        const result = await runAction(
            () => actions.commentIssueAction({ projectId, issueId, body: text }),
            setError
        );
        if (!result || result.error) {
            list.setItems((rows) => rows.filter((row) => row.id !== draft.id));
            setBody(text);
            if (result?.error) setError(result.error);
        } else setError("");
    };

    return (
        <section className="flex flex-col gap-3" aria-label={t("activity.title")}>
            <h3 className="text-sm font-medium">{t("activity.title")}</h3>
            <div className="flex flex-col gap-2">
                <Textarea
                    value={body}
                    rows={2}
                    maxLength={5000}
                    placeholder={t("activity.placeholder")}
                    aria-label={t("activity.placeholder")}
                    onChange={(event) => setBody(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            void send();
                        }
                    }}
                />
                <div className="flex items-center justify-between gap-2">
                    {error ? (
                        <p role="alert" className="min-w-0 text-xs text-danger">
                            {error}
                        </p>
                    ) : (
                        <span />
                    )}
                    <Button size="sm" disabled={!body.trim()} onClick={() => void send()}>
                        {t("activity.send")}
                    </Button>
                </div>
            </div>
            {list.items === null ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
            ) : list.items.length === 0 ? (
                <p className="text-xs text-muted-foreground">{list.error || t("activity.none")}</p>
            ) : (
                <ol className="flex flex-col gap-2">
                    {list.items.map((row) => (
                        <li key={row.id} className="flex min-w-0 flex-col gap-0.5 rounded-md bg-surface px-3 py-2">
                            <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                                <span className="truncate font-medium text-foreground">
                                    {row.actor?.name ??
                                        (row.kind === "status" && (row.body === "regressed" || row.body === "unignored")
                                            ? t("activity.automatic")
                                            : t("activity.someone"))}
                                </span>
                                <RelativeTime iso={row.at} />
                            </span>
                            <div className="min-w-0 text-sm">{say(row)}</div>
                        </li>
                    ))}
                    {list.more &&
                        (list.error && !list.paging ? (
                            <li className="flex items-center justify-between gap-2">
                                <p role="alert" className="min-w-0 text-xs text-danger">
                                    {list.error}
                                </p>
                                <Button size="sm" variant="ghost" onClick={list.loadMore}>
                                    {t("activity.retry")}
                                </Button>
                            </li>
                        ) : (
                            <li ref={setSentinel} aria-busy="true" aria-label={t("activity.more")}>
                                <Skeleton className="h-10 w-full" />
                            </li>
                        ))}
                </ol>
            )}
        </section>
    );
}
