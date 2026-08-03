"use client";

/**
 * The table of signed-in sessions, shared by the account's own list and by the
 * administrator reading somebody else's. One component so both show the same
 * facts about a session and neither grows a column the other lacks.
 *
 * The address a session was opened on is a column of its own because a
 * deployment answers on several names - polaris.local on the LAN, its domain
 * from outside - and the session cookie is host-only. The same person on the
 * same machine therefore holds one session per name, and without the address
 * those rows are indistinguishable.
 *
 * The device label and the address both come from the client, so they are shown
 * as what they are - a description - and never used to decide anything. How each
 * session signed in is the one fact here that is not a claim: it is what the
 * server watched happen, which is why it sits on the row rather than behind it.
 */

import Link from "next/link";
import { signInSummary } from "@polaris/core";
import { Badge, Button, cn } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import type { SessionView } from "@/lib/session-directory";
import { History, LogOut, MonitorSmartphone } from "lucide-react";
import { addressLine, DeviceAddress } from "@/components/device-address";

/** Where a session came from, as one line, for the surfaces too narrow to hold
 *  the columns - and for the approval card, which is not a table at all. */
export function sessionOrigin(session: SessionView): string {
    return [addressLine(session), session.host].filter(Boolean).join(" - ") || "Unknown location";
}

export function SessionsTable({
    sessions,
    busyId,
    activityHref,
    onRevoke,
    emptyLabel,
    compact = false
}: {
    sessions: SessionView[];
    /** The session with an action in flight, or "all" while every other one ends. */
    busyId: string | null;
    /** Where this session's history is read. Left out where the reader has no
     *  business reading the account's log. */
    activityHref?: (session: SessionView) => string;
    onRevoke: (session: SessionView) => void;
    emptyLabel: string;
    /** For the dialogs, whose box is a fixed width the viewport says nothing
     *  about. The columns fold into the device cell rather than being decided by
     *  a breakpoint that would put the table on a scrollbar at every size. */
    compact?: boolean;
}) {
    return (
        <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
                <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                    {/* Nothing arrives at md: the navigation rail appears there, so the
                        content area is narrower than it was a breakpoint earlier and a
                        column added then only scrolls the table sideways. */}
                    <tr>
                        {/* w-full max-w-0: without the cap, the folded origin line is
                            nowrap text and sets a floor under the column that no
                            amount of truncating gets below, so the table spills
                            sideways. Capped, the column takes what is left instead. */}
                        <th className="w-full max-w-0 px-3 py-2 font-medium">Device</th>
                        {compact ? null : (
                            <>
                                <th className="hidden px-3 py-2 font-medium lg:table-cell">Address</th>
                                <th className="hidden px-3 py-2 font-medium xl:table-cell">Domain</th>
                                <th className="hidden px-3 py-2 font-medium lg:table-cell">Last active</th>
                            </>
                        )}
                        <th className="px-3 py-2" />
                    </tr>
                </thead>
                <tbody>
                    {sessions.length === 0 ? (
                        <tr>
                            <td
                                colSpan={compact ? 2 : 5}
                                className="px-3 py-8 text-center text-muted-foreground"
                            >
                                {emptyLabel}
                            </td>
                        </tr>
                    ) : (
                        sessions.map((session) => (
                            <tr
                                key={session.id}
                                className={cn("border-t border-border", busyId === session.id && "opacity-60")}
                            >
                                <td className="w-full max-w-0 px-3 py-2">
                                    <div className="flex items-center gap-3">
                                        <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0">
                                            <p className="flex flex-wrap items-center gap-1.5">
                                                {/* min-w-0: a truncating flex item still refuses to
                                                    shrink past its text without it, which is what
                                                    widens the row on a phone. */}
                                                <span className="min-w-0 truncate">{session.device}</span>
                                                {session.current ? <Badge variant="primary">This device</Badge> : null}
                                                {session.locked ? <Badge>Locked</Badge> : null}
                                                {/* How it got in, beside what it is: the two questions a
                                                    person scanning this list is asking at once. */}
                                                <Badge>{signInSummary(session.signIn)}</Badge>
                                            </p>
                                            {/* The columns the narrow layouts drop, folded back in. */}
                                            <p
                                                className={cn(
                                                    "truncate text-xs text-muted-foreground",
                                                    !compact && "lg:hidden"
                                                )}
                                            >
                                                {sessionOrigin(session)}
                                            </p>
                                            {compact ? (
                                                <p className="truncate text-xs text-muted-foreground">
                                                    Last active <RelativeTime iso={session.lastSeenAt} />
                                                </p>
                                            ) : null}
                                        </div>
                                    </div>
                                </td>
                                {compact ? null : (
                                    <>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                            <DeviceAddress address={session} />
                                        </td>
                                        <td className="hidden max-w-[12rem] px-3 py-2 text-xs text-muted-foreground xl:table-cell">
                                            <span className="block truncate">{session.host ?? "Not recorded"}</span>
                                        </td>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                            <RelativeTime iso={session.lastSeenAt} />
                                        </td>
                                    </>
                                )}
                                <td className="px-3 py-2">
                                    <div className="flex justify-end gap-1">
                                        {activityHref ? (
                                            <Button variant="ghost" size="icon" asChild>
                                                <Link
                                                    href={activityHref(session)}
                                                    title="Activity from this session"
                                                    aria-label={`Activity from ${session.device}`}
                                                >
                                                    <History className="size-4" />
                                                </Link>
                                            </Button>
                                        ) : null}
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            title="Sign out"
                                            aria-label={`Sign ${session.device} out`}
                                            disabled={busyId !== null}
                                            onClick={() => onRevoke(session)}
                                        >
                                            <LogOut className="size-4" />
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
            </table>
        </div>
    );
}
