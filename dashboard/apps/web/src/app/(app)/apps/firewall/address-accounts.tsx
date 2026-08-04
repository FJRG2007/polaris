"use client";

/**
 * The accounts an address has been seen on, inside the dialog that judges it.
 *
 * The edge log says what an address asked for and never who it was, and "is that
 * one of ours?" is the question an operator asks next: a route flood from an
 * address somebody is signed in from is a member's machine or their stolen
 * session, and a ban is the wrong answer to both. Sign-ins that were refused are
 * here for the opposite reason - an address failing its way through the network
 * rules of an account it does not own is the clearest thing an attacker leaves
 * behind, and no list of open sessions can show it, because none of them ever
 * became one.
 *
 * Rendered only for a reader the server was willing to name accounts to, so an
 * empty list here means nobody has ever signed in from the address, never that
 * this reader may not be told.
 */

import Link from "next/link";
import { Badge } from "@polaris/ui";
import { Users } from "lucide-react";
import { grouped } from "./page-parts";
import { Avatar } from "@/components/avatar";
import { signInSummary } from "@polaris/core";
import { RelativeTime } from "@/components/relative-time";
import type { AddressAccount, AddressAccounts as AddressAccountsView } from "@/lib/address-accounts";

/** As many accounts and sessions as read as a list rather than as a wall. Each
 *  is followed by a line saying what was left out, since an address behind an
 *  office gateway carries more of both than anybody wants to scroll. */
const ACCOUNT_ROWS = 6;
const SESSION_ROWS = 3;

export function AddressAccounts({ accounts }: { accounts: AddressAccountsView }) {
    const { list, more } = accounts;
    return (
        <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Users className="size-4" />
                Accounts seen here
            </div>
            {list.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    No account has signed in from this address.
                </p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {list.slice(0, ACCOUNT_ROWS).map((account) => (
                        <li key={account.id} className="rounded-md border border-border p-2">
                            <div className="flex items-start gap-2">
                                <Avatar person={account} size={28} />
                                <div className="min-w-0 flex-1">
                                    <p className="flex flex-wrap items-center gap-1.5 text-sm">
                                        {/* The name opens the account rather than sitting here
                                            as text: whatever is decided about the person behind
                                            this address is decided on that screen. */}
                                        <Link
                                            href={`/admin/users?user=${account.id}`}
                                            className="min-w-0 truncate font-medium text-primary underline-offset-2 hover:underline"
                                        >
                                            {account.name}
                                        </Link>
                                        {account.live > 0 ? (
                                            <Badge variant="primary">
                                                {account.live} signed in now
                                            </Badge>
                                        ) : null}
                                        {account.banned ? (
                                            <Badge variant="danger">Banned</Badge>
                                        ) : null}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {account.email}
                                    </p>
                                    <SignInTally signIns={account.signIns} />
                                    <ul className="mt-1 flex flex-col gap-0.5">
                                        {account.sessions.slice(0, SESSION_ROWS).map((session) => (
                                            <li
                                                key={session.id}
                                                className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
                                            >
                                                <span className="min-w-0 truncate text-foreground">
                                                    {session.device}
                                                </span>
                                                {session.host ? (
                                                    <span className="min-w-0 truncate">
                                                        {session.host}
                                                    </span>
                                                ) : null}
                                                <span>{signInSummary(session.signIn)}</span>
                                                <span>
                                                    {session.live ? "Active " : "Last active "}
                                                    <RelativeTime iso={session.lastSeenAt} />
                                                </span>
                                                {!session.live ? <Badge>Expired</Badge> : null}
                                                {session.approval === "pending" ? (
                                                    <Badge variant="warning">
                                                        Waiting for approval
                                                    </Badge>
                                                ) : null}
                                                {session.approval === "denied" ? (
                                                    <Badge variant="danger">Refused</Badge>
                                                ) : null}
                                            </li>
                                        ))}
                                    </ul>
                                    {account.sessions.length > SESSION_ROWS ? (
                                        <p className="mt-0.5 text-xs text-muted-foreground">
                                            and {grouped(account.sessions.length - SESSION_ROWS)}{" "}
                                            more session
                                            {account.sessions.length - SESSION_ROWS === 1
                                                ? ""
                                                : "s"}
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        </li>
                    ))}
                    {/* "at least" whenever the server itself had to cut: on a shared
                        address the rest is exactly what an exact-looking number would
                        be hiding, and this line is read as the whole picture. */}
                    {list.length > ACCOUNT_ROWS || more ? (
                        <li className="text-xs text-muted-foreground">
                            and {more ? "at least " : ""}
                            {grouped(Math.max(list.length - ACCOUNT_ROWS, 1))} more, least recently
                            seen
                        </li>
                    ) : null}
                </ul>
            )}
        </div>
    );
}

/** How the sign-ins from this address turned out, as one line. Coloured by the
 *  refusals, which are the half that means somebody was trying. */
function SignInTally({ signIns }: { signIns: AddressAccount["signIns"] }) {
    const parts = [
        signIns.accepted > 0 ? `${grouped(signIns.accepted)} signed in` : null,
        signIns.refused > 0 ? `${grouped(signIns.refused)} refused` : null,
        signIns.awaiting > 0 ? `${grouped(signIns.awaiting)} left waiting for approval` : null
    ].filter(Boolean);
    if (parts.length === 0) return null;
    return (
        <p className={`text-xs ${signIns.refused > 0 ? "text-danger" : "text-muted-foreground"}`}>
            {parts.join(" - ")}
        </p>
    );
}
