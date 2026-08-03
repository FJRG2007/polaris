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
 * as what they are - a description - and never used to decide anything.
 */

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
    onActivity,
    onRevoke,
    emptyLabel
}: {
    sessions: SessionView[];
    /** The session with an action in flight, or "all" while every other one ends. */
    busyId: string | null;
    /** Left out where the reader has no business reading the account's log. */
    onActivity?: (session: SessionView) => void;
    onRevoke: (session: SessionView) => void;
    emptyLabel: string;
}) {
    return (
        <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
                <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                    <tr>
                        <th className="px-3 py-2 font-medium">Device</th>
                        <th className="hidden px-3 py-2 font-medium sm:table-cell">Address</th>
                        <th className="hidden px-3 py-2 font-medium md:table-cell">Domain</th>
                        <th className="hidden px-3 py-2 font-medium lg:table-cell">Last active</th>
                        <th className="px-3 py-2" />
                    </tr>
                </thead>
                <tbody>
                    {sessions.length === 0 ? (
                        <tr>
                            <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                                {emptyLabel}
                            </td>
                        </tr>
                    ) : (
                        sessions.map((session) => (
                            <tr
                                key={session.id}
                                className={cn("border-t border-border", busyId === session.id && "opacity-60")}
                            >
                                <td className="px-3 py-2">
                                    <div className="flex items-center gap-3">
                                        <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0">
                                            <p className="flex flex-wrap items-center gap-1.5">
                                                <span className="truncate">{session.device}</span>
                                                {session.current ? <Badge variant="primary">This device</Badge> : null}
                                                {session.locked ? <Badge>Locked</Badge> : null}
                                            </p>
                                            {/* The columns the narrow layouts drop, folded back in. */}
                                            <p className="truncate text-xs text-muted-foreground sm:hidden">
                                                {sessionOrigin(session)}
                                            </p>
                                        </div>
                                    </div>
                                </td>
                                <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground sm:table-cell">
                                    <DeviceAddress address={session} />
                                </td>
                                <td className="hidden max-w-[14rem] px-3 py-2 text-xs text-muted-foreground md:table-cell">
                                    <span className="block truncate">{session.host ?? "Not recorded"}</span>
                                </td>
                                <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                    <RelativeTime iso={session.lastSeenAt} />
                                </td>
                                <td className="px-3 py-2">
                                    <div className="flex justify-end gap-1">
                                        {onActivity ? (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                title="Activity from this session"
                                                aria-label={`Activity from ${session.device}`}
                                                onClick={() => onActivity(session)}
                                            >
                                                <History className="size-4" />
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
