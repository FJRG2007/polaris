"use client";

/**
 * The account's own history, with a filter for the session it came from.
 *
 * The session filter is a URL parameter rather than local state, so the session
 * list can link straight to one device's history and so a reader can hand that
 * view to themselves on another screen. Everything else - the area, the phrase,
 * the time range, the paging and the export - is the feed every audit screen
 * shares; the session is this screen's own question.
 */

import { Select } from "@polaris/ui";
import { useCallback, useState } from "react";
import { AuditFeed } from "@/components/audit-feed";
import { useRouter, useSearchParams } from "next/navigation";
import { useDisplayFormat } from "@/components/display-format";
import { sessionName, type DisplayFormat } from "@polaris/core";

/** The filter value standing for no narrowing at all. Radix refuses an empty
 *  option value, so the "everything" choice is named rather than blank. */
const ALL = "all";

/** The value the API answers to for the entries that came from no session. */
const NO_SESSION = "none";

const PATH = "/account/activity";

interface ActivitySession {
    id: string;
    /** What the session is called, or null once it has ended and nothing names it. */
    label: string | null;
    current: boolean;
    lastAt: string | null;
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
        return session.lastAt
            ? `${name} - signed out ${format.date(session.lastAt)}`
            : `${name} - signed out`;
    }
    const named = `${name} - ${session.label}`;
    return session.current ? `${named} (this device)` : named;
}

export function ActivityView() {
    const router = useRouter();
    const params = useSearchParams();
    const format = useDisplayFormat();
    const selected = params.get("session") ?? ALL;
    const [sessions, setSessions] = useState<ActivitySession[]>([]);

    // The sessions ride on the first page, so the filter learns them from the
    // same request that brings the rows rather than asking twice.
    const onPage = useCallback((body: unknown) => {
        const listed = (body as { sessions?: unknown }).sessions;
        if (Array.isArray(listed)) setSessions(listed as ActivitySession[]);
    }, []);

    const names = new Map(sessions.map((session) => [session.id, sessionLabel(session, format)]));

    function filterBy(value: string) {
        const next = new URLSearchParams(params.toString());
        if (value === ALL) next.delete("session");
        else next.set("session", value);
        const query = next.toString();
        router.replace(query ? `${PATH}?${query}` : PATH, { scroll: false });
    }

    return (
        <AuditFeed
            endpoint="/api/account/activity"
            exportEndpoint="/api/account/activity/export"
            path={PATH}
            cacheKey="account.activity"
            contextLabel="Session"
            emptyLabel={
                selected === ALL
                    ? "Nothing recorded yet."
                    : "Nothing recorded from this session yet."
            }
            showActor={false}
            context={(entry) => names.get(entry.sessionId ?? NO_SESSION) ?? "Signed-out session"}
            detail={(entry) =>
                entry.targetType ? [entry.targetType, entry.targetId].filter(Boolean).join(" ") : ""
            }
            extra={{ key: "session", value: selected === ALL ? null : selected }}
            onPage={onPage}
            ownFilter={
                <Select
                    value={selected}
                    onValueChange={filterBy}
                    aria-label="Filter by session"
                    className="h-8 w-full sm:w-72"
                    options={[
                        { value: ALL, label: "All sessions" },
                        ...sessions.map((session) => ({
                            value: session.id,
                            label: sessionLabel(session, format)
                        }))
                    ]}
                />
            }
        />
    );
}
