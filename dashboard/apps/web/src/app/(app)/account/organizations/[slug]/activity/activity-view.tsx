"use client";

/**
 * The organization's feed, with a filter for one person.
 *
 * The filter is a URL parameter rather than local state, so a reader can hand
 * "what has Ana done here" to somebody else as a link. Narrowing re-asks the
 * server instead of hiding rows already fetched: the feed is capped, and somebody
 * whose entries fall past the cap is exactly who is being looked for.
 *
 * The rows arrive after the screen has painted, so opening this never waits on
 * the audit query.
 */

import { RefreshCw } from "lucide-react";
import { Button, Select } from "@polaris/ui";
import type { OrgActivityEntry } from "@/lib/audit-service";
import { useRouter, useSearchParams } from "next/navigation";
import { useLiveResource } from "@/components/use-live-resource";
import { ActivityTable, type ActivityRow } from "@/components/activity-table";

/** How often the feed re-reads. An audit trail is appended to, not edited, so
 *  this is gentle - the refresh control covers wanting it now. */
const POLL_MS = 30_000;

/** The filter value standing for no narrowing at all. Radix refuses an empty
 *  option value, so the "everybody" choice is named rather than blank. */
const ALL = "all";

interface ActivityPayload {
    items: OrgActivityEntry[];
    actors: { id: string; name: string }[];
}

export function ActivityView({ slug }: { slug: string }) {
    const router = useRouter();
    const params = useSearchParams();
    const selected = params.get("actor") ?? ALL;

    const base = `/account/organizations/${slug}/activity`;
    const { data, loading, error, stale, refreshing, refresh } = useLiveResource<ActivityPayload>({
        url: `/api/orgs/${encodeURIComponent(slug)}/activity${
            selected === ALL ? "" : `?actor=${encodeURIComponent(selected)}`
        }`,
        // Per organization and per filter, so switching back to one already read
        // paints it at once.
        cacheKey: `org.activity:${slug}:${selected}`,
        intervalMs: POLL_MS,
        select: (body) => {
            const payload = body as Partial<ActivityPayload>;
            return {
                items: Array.isArray(payload.items) ? payload.items : [],
                actors: Array.isArray(payload.actors) ? payload.actors : []
            };
        }
    });

    const actors = data?.actors ?? [];
    const rows: ActivityRow[] | null =
        data?.items.map((entry) => ({
            id: entry.id,
            at: entry.at,
            context: entry.actorName,
            action: entry.action,
            metadata: entry.metadata
        })) ?? null;

    function filterBy(value: string) {
        const next = new URLSearchParams(params.toString());
        if (value === ALL) next.delete("actor");
        else next.set("actor", value);
        const query = next.toString();
        router.replace(query ? `${base}?${query}` : base, { scroll: false });
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Select
                    value={selected}
                    onValueChange={filterBy}
                    aria-label="Filter by person"
                    className="h-8 w-full sm:w-72"
                    options={[
                        { value: ALL, label: "Everybody" },
                        ...actors.map((actor) => ({ value: actor.id, label: actor.name }))
                    ]}
                />
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
            </div>

            {stale ? <p className="text-warning text-sm">{stale}</p> : null}

            <ActivityTable
                rows={rows}
                loading={loading}
                error={error}
                contextLabel="Who"
                emptyLabel={
                    selected === ALL ? "Nothing has been done here yet." : "This person has done nothing here yet."
                }
            />
        </div>
    );
}
