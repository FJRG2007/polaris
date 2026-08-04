"use client";

/**
 * The account's own history, with a filter for the session it came from.
 *
 * The filter is a URL parameter rather than local state, so the session list can
 * link straight to one device's history and so a reader can hand that view to
 * themselves on another screen. Narrowing re-asks the server instead of hiding
 * rows already fetched: the feed is capped, and a session whose entries fall
 * past the cap is exactly the one somebody is looking for.
 *
 * The rows arrive after the screen has painted, so opening this never waits on
 * the audit query.
 */

import { RefreshCw } from "lucide-react";
import { Button, Select } from "@polaris/ui";
import { useRouter, useSearchParams } from "next/navigation";
import type { UserActivityEntry } from "@/lib/audit-service";
import { useDisplayFormat } from "@/components/display-format";
import { sessionName, type DisplayFormat } from "@polaris/core";
import { useLiveResource } from "@/components/use-live-resource";
import { ActivityTable, type ActivityRow } from "@/components/activity-table";

/** How often the feed re-reads. An audit trail is appended to, not edited, so
 *  this is gentle - the refresh control covers wanting it now. */
const POLL_MS = 30_000;

/** The filter value standing for no narrowing at all. Radix refuses an empty
 *  option value, so the "everything" choice is named rather than blank. */
const ALL = "all";

/** The value the API answers to for the entries that came from no session. */
const NO_SESSION = "none";

interface ActivitySession {
    id: string;
    /** What the session is called, or null once it has ended and nothing names it. */
    label: string | null;
    current: boolean;
    lastAt: string | null;
}

interface ActivityPayload {
    items: UserActivityEntry[];
    sessions: ActivitySession[];
}

/**
 * How one session reads in the filter and in the table's own column.
 *
 * The name leads and the device follows it, because a filter listing "Chrome on
 * Windows" three times is a filter nobody can pick from. The name is derived
 * from the id here rather than sent with the row: it is a pure function of
 * something the payload already carries, so shipping it would be shipping a
 * second copy of the same fact.
 */
function sessionLabel(session: ActivitySession, format: DisplayFormat): string {
    if (session.id === NO_SESSION) return "Outside a session";
    const name = sessionName(session.id);
    // Nothing names a session that has ended, so the row has to. The derived name
    // still leads - it is what this session was called in the list while it was
    // live, which is how somebody recognises it here - but it cannot stand on its
    // own, or a session that is gone reads exactly like one still signed in.
    if (!session.label) {
        return session.lastAt ? `${name} - signed out ${format.date(session.lastAt)}` : `${name} - signed out`;
    }
    const named = `${name} - ${session.label}`;
    return session.current ? `${named} (this device)` : named;
}

export function ActivityView() {
    const router = useRouter();
    const params = useSearchParams();
    const format = useDisplayFormat();
    const selected = params.get("session") ?? ALL;

    const { data, loading, error, stale, refreshing, refresh } = useLiveResource<ActivityPayload>({
        url: `/api/account/activity${selected === ALL ? "" : `?session=${encodeURIComponent(selected)}`}`,
        // Per filter, so switching back to one already read paints it at once.
        cacheKey: `account.activity:${selected}`,
        intervalMs: POLL_MS,
        select: (body) => {
            const payload = body as Partial<ActivityPayload>;
            return {
                items: Array.isArray(payload.items) ? payload.items : [],
                sessions: Array.isArray(payload.sessions) ? payload.sessions : []
            };
        }
    });

    const sessions = data?.sessions ?? [];
    const names = new Map(sessions.map((session) => [session.id, sessionLabel(session, format)]));
    const rows: ActivityRow[] | null =
        data?.items.map((entry) => ({
            id: entry.id,
            at: entry.at,
            context: names.get(entry.sessionId ?? NO_SESSION) ?? "Signed-out session",
            action: entry.action,
            detail: entry.target,
            metadata: entry.metadata
        })) ?? null;

    function filterBy(value: string) {
        const next = new URLSearchParams(params.toString());
        if (value === ALL) next.delete("session");
        else next.set("session", value);
        const query = next.toString();
        router.replace(query ? `/account/activity?${query}` : "/account/activity", { scroll: false });
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Select
                    value={selected}
                    onValueChange={filterBy}
                    aria-label="Filter by session"
                    className="h-8 w-full sm:w-72"
                    options={[
                        { value: ALL, label: "All sessions" },
                        ...sessions.map((session) => ({ value: session.id, label: sessionLabel(session, format) }))
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

            {stale ? <p className="text-sm text-warning">{stale}</p> : null}

            <ActivityTable
                rows={rows}
                loading={loading}
                error={error}
                contextLabel="Session"
                emptyLabel={
                    selected === ALL ? "Nothing recorded yet." : "Nothing recorded from this session yet."
                }
            />
        </div>
    );
}
