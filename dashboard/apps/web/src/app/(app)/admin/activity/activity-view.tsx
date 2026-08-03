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
import { Button, PageHeader } from "@polaris/ui";
import type { ActivityEntry } from "@/lib/audit-service";
import { useLiveResource } from "@/components/use-live-resource";
import { ActivityTable, type ActivityRow } from "@/components/activity-table";

/** How often the feed re-reads. An audit trail is appended to, not edited, so
 *  this is gentle - the refresh control covers wanting it now. */
const POLL_MS = 30_000;

export function ActivityView() {
    const { data, loading, error, stale, refreshing, refresh } = useLiveResource<ActivityEntry[]>({
        url: "/api/admin/activity",
        cacheKey: "admin.activity",
        intervalMs: POLL_MS,
        select: (body) => {
            const items = (body as { items?: unknown }).items;
            return Array.isArray(items) ? (items as ActivityEntry[]) : [];
        }
    });

    const rows: ActivityRow[] | null =
        data?.map((event) => ({
            id: event.id,
            at: event.at,
            context: event.actor,
            action: event.action,
            metadata: event.metadata
        })) ?? null;

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
            <ActivityTable
                rows={rows}
                loading={loading}
                error={error}
                contextLabel="Who"
                emptyLabel="No activity recorded yet."
            />
        </>
    );
}
