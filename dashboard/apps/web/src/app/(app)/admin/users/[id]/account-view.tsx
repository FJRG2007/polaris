"use client";

/**
 * One person's record, and everything an administrator can do about it.
 *
 * This was a dialog over the people list. It stopped fitting: an account is who
 * they are, what they may do, where they may do it from, every device signed in
 * as them, and how to stop them - and deciding any of those usually means
 * reading the others first. A panel that has to scroll inside a page that also
 * scrolls is the wrong container for that, it cannot be linked to, and the one
 * explanation an administrator actually arrives for - why this person can do
 * that - was a link out of it to somewhere else.
 *
 * So the record is the page, and the resolution below it on the same page. What
 * is left of the list is a list.
 *
 * Each control still saves on its own. A single Save over a form this wide would
 * make "sign them out" and "ban them" wait on a role change nobody asked to make.
 */

import { useRouter } from "next/navigation";
import type { RoleOption } from "@/lib/role-service";
import { BAN_LENGTHS } from "../ban-lengths";
import { useConfirm } from "@/components/confirm-dialog";
import type { SessionView } from "@/lib/session-directory";
import { SessionsTable } from "@/components/sessions-table";
import type { DirectoryUser } from "@/lib/user-admin-service";
import { viewAsUserAction } from "@/app/(app)/view-as-actions";
import { useDisplayFormat } from "@/components/display-format";
import { Ban, Eye, LogOut, Shield, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Card, CardBody, Input, Select, Skeleton, Switch } from "@polaris/ui";
import {
    AccessRulesEditor,
    accessRulesAreEmpty,
    accessRulesEqual,
    type AccessGroupOption,
    type AccessRulesValue
} from "@/components/access-rules-editor";
import {
    banUserAction,
    deleteUserAction,
    revokeUserSessionAction,
    revokeUserSessionsAction,
    setAdminAccessAction,
    setUserLimitsAction,
    setUserRoleAction,
    unbanUserAction,
    userSessionsAction
} from "../actions";

/** A labelled fact in the identity grid. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate text-sm">{children}</dd>
        </div>
    );
}

export function AccountView({
    user,
    groups,
    roles,
    isSelf
}: {
    user: DirectoryUser;
    groups: AccessGroupOption[];
    /** Every role this instance defines, for the picker. */
    roles: RoleOption[];
    isSelf: boolean;
}) {
    const router = useRouter();
    const format = useDisplayFormat();
    const [confirm, confirmElement] = useConfirm();
    const [limits, setLimits] = useState<AccessRulesValue>(user.enforced);
    const [banReason, setBanReason] = useState("");
    /** How long the ban runs for, in minutes. Zero is a ban with no end, which is
     *  what this control was before it existed and stays the deliberate choice
     *  rather than the default. */
    const [banFor, setBanFor] = useState("1440");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Null until the list arrives, so the section holds its shape rather than the
    // page waiting on a query nothing above it needs.
    const [sessions, setSessions] = useState<SessionView[] | null>(null);

    /** The open sessions, re-read whenever an action may have ended one. */
    const loadSessions = useCallback(async () => {
        const result = await userSessionsAction(user.id);
        setSessions(result.sessions ?? []);
    }, [user.id]);

    useEffect(() => {
        void loadSessions();
    }, [loadSessions]);

    /** Run one action, keep its refusal on screen, and re-read the page. */
    async function run(action: () => Promise<{ error?: string }>) {
        setBusy(true);
        setError(null);
        const result = await action();
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return false;
        }
        await loadSessions();
        router.refresh();
        return true;
    }

    /** Leave the operator screens behind and carry on as this person. The root
     *  resolves where their own access starts, which is rarely where you are. */
    async function onViewAs() {
        if (await run(() => viewAsUserAction(user.id))) router.push("/");
    }

    async function onDelete() {
        const ok = await confirm({
            title: `Delete ${user.name}?`,
            description:
                "Their account and everything it owns - connections, deployments, shares and uploads - goes with it. This cannot be undone.",
            confirmLabel: "Delete account",
            danger: true
        });
        if (!ok) return;
        // The account this page is about is gone, so there is no page left to be
        // on - back to the list rather than a record of nobody.
        if (await run(() => deleteUserAction(user.id))) router.push("/admin/users");
    }

    const role = user.roles[0] ?? "";

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-5">
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <Fact label="Username">{user.username ?? "-"}</Fact>
                        <Fact label="Company">{user.company ?? "-"}</Fact>
                        <Fact label="Joined">{format.date(user.createdAt)}</Fact>
                        <Fact label="Email">{user.emailVerified ? "Verified" : "Unverified"}</Fact>
                        <Fact label="Two-factor">{user.twoFactorEnabled ? "On" : "Off"}</Fact>
                        <Fact label="Groups">{user.groups.length > 0 ? user.groups.join(", ") : "-"}</Fact>
                    </dl>

                    <section className="flex flex-col gap-3 border-t border-border pt-4">
                        <h2 className="text-sm font-medium">Access</h2>
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-sm">Role</p>
                                <p className="text-xs text-muted-foreground">
                                    What they may do across Polaris, before any policy attached to them.
                                </p>
                            </div>
                            <Select
                                className="w-40"
                                aria-label={`Role for ${user.name}`}
                                value={role}
                                placeholder="No role"
                                disabled={busy}
                                onValueChange={(next) => void run(() => setUserRoleAction(user.id, next))}
                                options={roles.map((option) => ({ value: option.name, label: option.name }))}
                            />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="flex items-center gap-1.5 text-sm">
                                    <Eye className="size-4 text-muted-foreground" />
                                    Open their account
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    Use Polaris as {user.name}, to see what they see and fix it where they are.
                                    Nothing is signed in on their side and it is written to the activity log.
                                </p>
                            </div>
                            <Button size="sm" variant="ghost" disabled={busy || isSelf} onClick={() => void onViewAs()}>
                                <Eye className="size-4" />
                                Open
                            </Button>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="flex items-center gap-1.5 text-sm">
                                    <Shield className="size-4 text-muted-foreground" />
                                    Administrator
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    Opens the operator surfaces: people, policies, domains and activity.
                                </p>
                            </div>
                            <Switch
                                checked={user.isAdmin}
                                disabled={busy || isSelf}
                                aria-label={`Administrator access for ${user.name}`}
                                onChange={(checked) => void run(() => setAdminAccessAction(user.id, checked))}
                            />
                        </div>
                    </section>

                    <section className="flex flex-col gap-3 border-t border-border pt-4">
                        <div>
                            <h2 className="text-sm font-medium">Where they may sign in from</h2>
                            <p className="text-xs text-muted-foreground">
                                Applies on top of whatever they set for themselves, and they cannot remove it. Saving
                                signs them out everywhere.
                            </p>
                        </div>
                        <AccessRulesEditor value={limits} groups={groups} onChange={setLimits} />
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-muted-foreground">
                                {accessRulesAreEmpty(limits)
                                    ? "No limit - they may sign in from anywhere."
                                    : "They may only sign in from what is listed."}
                            </p>
                            <Button
                                size="sm"
                                disabled={busy || accessRulesEqual(limits, user.enforced)}
                                onClick={() => void run(() => setUserLimitsAction(user.id, limits))}
                            >
                                Save limits
                            </Button>
                        </div>
                    </section>

                    <section className="flex flex-col gap-3 border-t border-border pt-4">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <h2 className="text-sm font-medium">Sessions</h2>
                                <p className="text-xs text-muted-foreground">
                                    Every device signed in as {user.name}, and which of this instance&apos;s addresses
                                    each one came in on.
                                </p>
                            </div>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy || sessions?.length === 0}
                                onClick={() => void run(() => revokeUserSessionsAction(user.id))}
                            >
                                <LogOut className="size-4" />
                                Sign out everywhere
                            </Button>
                        </div>
                        {sessions ? (
                            <SessionsTable
                                compact
                                sessions={sessions}
                                busyId={busy ? "all" : null}
                                emptyLabel="Nothing is signed in."
                                onRevoke={(session) => void run(() => revokeUserSessionAction(user.id, session.id))}
                            />
                        ) : (
                            <Skeleton className="h-24 w-full rounded-lg" />
                        )}
                        <p className="text-xs text-muted-foreground">
                            {user.lastSeenAt ? `Last seen ${format.dateTime(user.lastSeenAt)}` : "Never seen."}
                            {user.lastIp ? ` from ${user.lastIp}` : ""}
                            {user.lastCountry ? ` (${user.lastCountry})` : ""}
                        </p>
                    </section>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <h2 className="text-sm font-medium text-danger">Danger zone</h2>
                    {user.banned ? (
                        <div className="flex items-center justify-between gap-3">
                            <p className="text-xs text-muted-foreground">
                                {user.bannedUntil ? "Suspended" : "Banned"}{" "}
                                {user.bannedAt ? format.dateTime(user.bannedAt) : ""}
                                {/* When it ends, for one that does. Said here
                                    because "banned" and "back on Tuesday" are
                                    different answers to what an administrator
                                    opened this page to ask. */}
                                {user.bannedUntil
                                    ? `, back ${format.dateTime(user.bannedUntil)}`
                                    : ""}
                                {user.banReason ? `: ${user.banReason}` : ""}
                            </p>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void run(() => unbanUserAction(user.id))}
                            >
                                <Undo2 className="size-4" />
                                Lift the ban
                            </Button>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                <Input
                                    className="flex-1"
                                    placeholder="Reason (optional, kept for the record)"
                                    value={banReason}
                                    disabled={isSelf}
                                    onChange={(event) => setBanReason(event.target.value)}
                                />
                                {/* How long, beside the button that does it. A
                                    ban that has to be lifted by somebody
                                    remembering a week later is the one every
                                    administrator actually wanted to be a
                                    suspension. */}
                                <Select
                                    value={banFor}
                                    className="sm:w-44"
                                    aria-label="How long"
                                    disabled={isSelf}
                                    onValueChange={setBanFor}
                                    options={BAN_LENGTHS.map((length) => ({
                                        value: String(length.minutes),
                                        label: length.label
                                    }))}
                                />
                                <Button
                                    size="sm"
                                    variant="danger"
                                    disabled={busy || isSelf}
                                    onClick={() =>
                                        void run(() =>
                                            banUserAction(user.id, banReason, Number(banFor) || 0)
                                        )
                                    }
                                >
                                    <Ban className="size-4" />
                                    {Number(banFor) > 0 ? "Suspend" : "Ban"}
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Either one signs them out everywhere at once. A suspension lifts
                                itself when its time is up; a ban stays until somebody lifts it.
                            </p>
                        </div>
                    )}
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-muted-foreground">
                            Deleting takes everything the account owns with it.
                        </p>
                        <Button size="sm" variant="danger" disabled={busy || isSelf} onClick={() => void onDelete()}>
                            <Trash2 className="size-4" />
                            Delete account
                        </Button>
                    </div>
                </CardBody>
            </Card>

            {confirmElement}
        </div>
    );
}
