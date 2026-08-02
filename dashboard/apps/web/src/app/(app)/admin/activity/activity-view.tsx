"use client";

/**
 * The activity table. The rows arrive from /api/admin/activity after the screen
 * has painted, so opening Activity never waits on the audit query - the header
 * and the table chrome are there immediately and only the rows are sketched.
 *
 * A revisit paints the previous answer from the session cache while the fresh
 * one is on its way, and the feed keeps itself current without a reload.
 */

import { RefreshCw } from "lucide-react";
import { ActivityDetails } from "./activity-details";
import type { ActivityEntry } from "@/lib/audit-service";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import { Badge, Button, PageHeader, Skeleton } from "@polaris/ui";

/** How often the feed re-reads. An audit trail is appended to, not edited, so
 *  this is gentle - the refresh control covers wanting it now. */
const POLL_MS = 30_000;

/** Rows sketched while the first answer is in flight; about a screenful. */
const SKELETON_ROWS = 12;

export function ActivityView() {
    const format = useDisplayFormat();
    const { data, loading, error, stale, refreshing, refresh } = useLiveResource<ActivityEntry[]>({
        url: "/api/admin/activity",
        cacheKey: "admin.activity",
        intervalMs: POLL_MS,
        select: (body) => {
            const items = (body as { items?: unknown }).items;
            return Array.isArray(items) ? (items as ActivityEntry[]) : [];
        }
    });

    return (
        <>
            <PageHeader
                title="Activity"
                description="A global history of actions across Polaris - connections, reads, writes, and management."
                actions={
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={refresh}
                        disabled={refreshing}
                        aria-label="Refresh"
                        title="Refresh"
                    >
                        <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
                    </Button>
                }
            />
            {stale ? <p className="mb-3 text-sm text-warning">{stale}</p> : null}
            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">When</th>
                            <th className="px-3 py-2 font-medium">Who</th>
                            <th className="px-3 py-2 font-medium">Action</th>
                            <th className="hidden px-3 py-2 font-medium md:table-cell">Details</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading ? (
                            <ActivityRowsSkeleton />
                        ) : error ? (
                            <tr>
                                <td colSpan={4} className="px-3 py-8 text-center text-danger">
                                    {error}
                                </td>
                            </tr>
                        ) : (data?.length ?? 0) === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                                    No activity recorded yet.
                                </td>
                            </tr>
                        ) : (
                            data?.map((event) => (
                                <tr key={event.id} className="border-t border-border hover:bg-card-hover">
                                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                        {format.dateTime(event.at)}
                                    </td>
                                    <td className="px-3 py-2">{event.actor}</td>
                                    <td className="px-3 py-2">
                                        <Badge variant="neutral">{event.action}</Badge>
                                    </td>
                                    <td className="hidden px-3 py-2 align-top text-xs text-muted-foreground md:table-cell">
                                        <ActivityDetails metadata={event.metadata} />
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </>
    );
}

/** The rows' own shape, so the table does not jump when they arrive. */
function ActivityRowsSkeleton() {
    return (
        <>
            {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
                <tr key={index} className="border-t border-border">
                    <td className="px-3 py-2">
                        <Skeleton className="h-4 w-32" />
                    </td>
                    <td className="px-3 py-2">
                        <Skeleton className="h-4 w-28" />
                    </td>
                    <td className="px-3 py-2">
                        <Skeleton className="h-5 w-24 rounded-full" />
                    </td>
                    <td className="hidden px-3 py-2 md:table-cell">
                        <Skeleton className="h-4 w-full max-w-md" />
                    </td>
                </tr>
            ))}
        </>
    );
}
