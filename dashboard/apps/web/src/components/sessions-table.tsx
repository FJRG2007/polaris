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
import type { ReactNode } from "react";
import { signInSummary } from "@polaris/core";
import { Badge, Button, cn } from "@polaris/ui";
import { History, KeyRound, LogOut } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import type { SessionView } from "@/lib/session-directory";
import { BrowserMark, SystemMark } from "@/components/client-marks";
import { addressLine, DeviceAddress } from "@/components/device-address";

/** Where a session came from, as one line, for the surfaces too narrow to hold
 *  the columns - and for the approval card, which is not a table at all. */
export function sessionOrigin(session: SessionView): string {
    return [addressLine(session), session.host].filter(Boolean).join(" - ") || "Unknown location";
}

/**
 * Which device let this session in, on the row for the session it let in.
 *
 * Two sign-ins here were not answered by the person signing in - one approved
 * from this very list, one let through by scanning the code on its screen - and
 * until this line existed the list said only that somebody had allowed them. The
 * device that gave the answer is the fact that matters: if it is one the owner
 * does not have any more, every session it let in is suspect, and this is the
 * screen where that is acted on.
 *
 * The label is what was recorded at the time. A session that has since been
 * signed out still names its device and simply stops linking anywhere - and so
 * does one an administrator is reading, since the history behind that link is
 * the account holder's own and this reader is not them.
 */
export function AuthorizedBy({ session, ownHistory }: { session: SessionView; ownHistory: boolean }) {
    const authorizer = session.authorizedBy;
    if (!authorizer) return null;
    const how = session.signIn.method === "qr-code" ? "Code scanned by" : "Allowed by";
    return (
        <p className="flex flex-wrap items-center gap-1 truncate text-xs text-muted-foreground">
            <KeyRound className="size-3 shrink-0" aria-hidden />
            <span>{how}</span>
            {authorizer.live && ownHistory ? (
                <Link
                    href={`/account/activity?session=${authorizer.sessionId}`}
                    className="min-w-0 truncate underline-offset-2 hover:text-foreground hover:underline"
                >
                    {authorizer.device}
                </Link>
            ) : (
                <span className="min-w-0 truncate">{authorizer.device}</span>
            )}
            {authorizer.current ? <Badge variant="neutral">This device</Badge> : null}
            {!authorizer.live ? <Badge variant="warning">Signed out since</Badge> : null}
        </p>
    );
}

/**
 * One of the two "what is this" columns: the mark, the name, and the version
 * where the client stated one.
 *
 * The version is quieter than the name on purpose. Somebody scanning this column
 * is looking for "which of these is Firefox", and only stops on the number once
 * they have found the row - so the number must not compete for the first read.
 * Where no version was claimed nothing is drawn: a dash would read as a version
 * that is missing rather than one that was never sent.
 */
function ClientCell({ mark, name, version }: { mark: ReactNode; name: string; version: string | null }) {
    return (
        <span className="flex items-center gap-2">
            {mark}
            <span className="truncate">{name}</span>
            {version ? <span className="tabular-nums text-muted-foreground">{version}</span> : null}
        </span>
    );
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
                                {/* The two halves of what the device claims to be,
                                    each its own column so a list can be scanned down
                                    one of them. They arrive before the address: what
                                    it is is asked more often than where it was. */}
                                <th className="hidden px-3 py-2 font-medium md:table-cell">App</th>
                                <th className="hidden px-3 py-2 font-medium md:table-cell">System</th>
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
                                colSpan={compact ? 2 : 7}
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
                                        {/* The browser's own mark rather than a
                                            generic screen: on a list of six rows it
                                            is what the eye lands on first. */}
                                        <BrowserMark browser={session.browser} />
                                        <div className="min-w-0">
                                            <p className="flex flex-wrap items-center gap-1.5">
                                                {/* min-w-0: a truncating flex item still refuses to
                                                    shrink past its text without it, which is what
                                                    widens the row on a phone. */}
                                                <span className="min-w-0 truncate font-medium">{session.name}</span>
                                                <span className="min-w-0 truncate text-muted-foreground">
                                                    {session.device}
                                                </span>
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
                                            {/* Whether this reader may open a session's
                                                history is already settled by activityHref;
                                                the authorizer's link answers to the same. */}
                                            <AuthorizedBy
                                                session={session}
                                                ownHistory={activityHref !== undefined}
                                            />
                                        </div>
                                    </div>
                                </td>
                                {compact ? null : (
                                    <>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs md:table-cell">
                                            <ClientCell
                                                mark={<BrowserMark browser={session.browser} />}
                                                name={session.browser}
                                                version={session.browserVersion}
                                            />
                                        </td>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs md:table-cell">
                                            <ClientCell
                                                mark={<SystemMark os={session.os} />}
                                                name={session.os}
                                                version={session.osVersion}
                                            />
                                        </td>
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
