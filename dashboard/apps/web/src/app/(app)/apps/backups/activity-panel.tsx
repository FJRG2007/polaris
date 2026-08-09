"use client";

/**
 * What has run.
 *
 * Successes included, because the question this is usually opened for is "is it
 * still running" rather than "what broke" - and a log that only records failures
 * cannot answer the first one.
 */

import Link from "next/link";
import type { JobRow } from "./types";
import { readJson } from "./read-json";
import { formatBytes } from "@polaris/core";
import { useEffect, useState } from "react";
import { Badge, Card, Skeleton } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";

const VERB: Record<string, string> = {
    backup: "Backed up",
    restore: "Restored",
    prune: "Pruned",
    replicate: "Replicated"
};

export function ActivityPanel() {
    const format = useDisplayFormat();
    const [jobs, setJobs] = useState<JobRow[] | null>(null);

    useEffect(() => {
        let live = true;
        void readJson<{ jobs: JobRow[] }>("/api/backups/activity").then((data) => {
            // A failed read shows an empty history rather than skeletons that
            // never resolve; the console's own banner says what went wrong.
            if (live) setJobs(data.ok ? data.value.jobs : []);
        });
        return () => {
            live = false;
        };
    }, []);

    if (jobs === null) {
        return (
            <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton key={index} className="h-12 w-full" />
                ))}
            </div>
        );
    }

    if (jobs.length === 0) {
        return (
            <Card>
                <p className="py-10 text-center text-sm text-muted-foreground">Nothing has run yet.</p>
            </Card>
        );
    }

    return (
        <Card>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="border-b border-border text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">What</th>
                            <th className="px-3 py-2 font-medium">Started</th>
                            <th className="px-3 py-2 font-medium">Took</th>
                            <th className="px-3 py-2 text-right font-medium">Size</th>
                            <th className="px-3 py-2 font-medium">Result</th>
                        </tr>
                    </thead>
                    <tbody>
                        {jobs.map((job) => (
                            <tr key={job.id} className="border-b border-border last:border-0">
                                <td className="px-3 py-2.5">
                                    <span className="text-muted-foreground">{VERB[job.type] ?? job.type} </span>
                                    {job.resourceId && job.resourceName ? (
                                        <Link
                                            href={`/apps/backups/${job.resourceId}`}
                                            className="font-medium hover:underline"
                                        >
                                            {job.resourceName}
                                        </Link>
                                    ) : (
                                        <span className="font-medium">{job.resourceName ?? "something removed"}</span>
                                    )}
                                    <span className="ml-2 text-xs text-muted-foreground">
                                        {job.trigger === "scheduled" ? "on a schedule" : "by hand"}
                                    </span>
                                    {job.error ? <p className="text-xs text-danger">{job.error}</p> : null}
                                </td>
                                <td className="px-3 py-2.5 text-muted-foreground">
                                    {format.dateTime(job.startedAt)}
                                </td>
                                <td className="px-3 py-2.5 text-muted-foreground">
                                    {job.finishedAt
                                        ? formatElapsed(job.startedAt, job.finishedAt)
                                        : "still running"}
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                                    {job.bytes ? formatBytes(BigInt(job.bytes)) : "-"}
                                </td>
                                <td className="px-3 py-2.5">
                                    <Badge
                                        variant={
                                            job.status === "failed"
                                                ? "danger"
                                                : job.status === "running"
                                                  ? "neutral"
                                                  : "success"
                                        }
                                    >
                                        {job.status}
                                    </Badge>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Card>
    );
}

/** How long it took, in the coarsest unit that still says something. */
function formatElapsed(from: string, to: string): string {
    const ms = new Date(to).getTime() - new Date(from).getTime();
    if (ms < 1000) return "under a second";
    const seconds = Math.round(ms / 1000);
    if (seconds < 90) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m`;
    return `${Math.round(minutes / 60)}h`;
}
