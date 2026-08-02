"use client";

/**
 * One person's record, and everything an administrator can do about it. The
 * dialog is the whole account in one place - who they are, what they may do,
 * where they may do it from, and how to stop them - because deciding any of
 * those usually means looking at the others first.
 *
 * Each control saves on its own. A single Save over a form this wide would make
 * "sign them out" and "ban them" wait on a role change nobody asked to make.
 */

import { useRouter } from "next/navigation";
import { INVITE_ROLES } from "@polaris/core";
import { useConfirm } from "@/components/confirm-dialog";
import type { SessionView } from "@/lib/session-directory";
import { SessionsTable } from "@/components/sessions-table";
import type { DirectoryUser } from "@/lib/user-admin-service";
import { useDisplayFormat } from "@/components/display-format";
import { Ban, LogOut, Shield, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
    AccessRulesEditor,
    accessRulesAreEmpty,
    accessRulesEqual,
    type AccessGroupOption,
    type AccessRulesValue
} from "@/components/access-rules-editor";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    Switch
} from "@polaris/ui";
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
} from "./actions";

/** A labelled fact in the identity grid. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate text-sm">{children}</dd>
        </div>
    );
}

export function UserDetailDialog({
    user,
    groups,
    isSelf,
    onOpenChange
}: {
    user: DirectoryUser;
    groups: AccessGroupOption[];
    isSelf: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const format = useDisplayFormat();
    const [confirm, confirmElement] = useConfirm();
    const [limits, setLimits] = useState<AccessRulesValue>(user.enforced);
    const [banReason, setBanReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Null until the list arrives, so the section can hold its shape rather than
    // the dialog waiting on a query nobody opened it for.
    const [sessions, setSessions] = useState<SessionView[] | null>(null);

    /** The open sessions, re-read whenever an action may have ended one. The
     *  directory's own refresh only carries the count. */
    const loadSessions = useCallback(async () => {
        const result = await userSessionsAction(user.id);
        setSessions(result.sessions ?? []);
    }, [user.id]);

    useEffect(() => {
        void loadSessions();
    }, [loadSessions]);

    /** Run one action, keep its refusal on screen, and re-read the directory. */
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

    async function onDelete() {
        const ok = await confirm({
            title: `Delete ${user.name}?`,
            description:
                "Their account and everything it owns - connections, deployments, shares and uploads - goes with it. This cannot be undone.",
            confirmLabel: "Delete account",
            danger: true
        });
        if (!ok) return;
        if (await run(() => deleteUserAction(user.id))) onOpenChange(false);
    }

    const role = user.roles[0] ?? "";

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex flex-wrap items-center gap-2">
                        {user.name}
                        {user.isAdmin ? <Badge variant="primary">admin</Badge> : null}
                        {user.banned ? <Badge variant="danger">banned</Badge> : null}
                    </DialogTitle>
                    <DialogDescription>{user.email}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-5">
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <Fact label="Username">{user.username ?? "-"}</Fact>
                        <Fact label="Company">{user.company ?? "-"}</Fact>
                        <Fact label="Joined">{format.date(user.createdAt)}</Fact>
                        <Fact label="Email">{user.emailVerified ? "Verified" : "Unverified"}</Fact>
                        <Fact label="Two-factor">{user.twoFactorEnabled ? "On" : "Off"}</Fact>
                        <Fact label="Groups">{user.groups.length > 0 ? user.groups.join(", ") : "-"}</Fact>
                    </dl>

                    <section className="flex flex-col gap-3 border-t border-border pt-4">
                        <h3 className="text-sm font-medium">Access</h3>
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
                                options={INVITE_ROLES.map((name) => ({ value: name, label: name }))}
                            />
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
                            <h3 className="text-sm font-medium">Where they may sign in from</h3>
                            <p className="text-xs text-muted-foreground">
                                Applies on top of whatever they set for themselves, and they cannot remove it.
                                Saving signs them out everywhere.
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
                                <h3 className="text-sm font-medium">Sessions</h3>
                                <p className="text-xs text-muted-foreground">
                                    Every device signed in as {user.name}, and which of this instance&apos;s
                                    addresses each one came in on.
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
                                sessions={sessions}
                                busyId={busy ? "all" : null}
                                emptyLabel="Nothing is signed in."
                                onRevoke={(session) =>
                                    void run(() => revokeUserSessionAction(user.id, session.id))
                                }
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

                    <section className="flex flex-col gap-3 border-t border-border pt-4">
                        <h3 className="text-sm font-medium text-danger">Danger zone</h3>
                        {user.banned ? (
                            <div className="flex items-center justify-between gap-3">
                                <p className="text-xs text-muted-foreground">
                                    Banned {user.bannedAt ? format.dateTime(user.bannedAt) : ""}
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
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                <Input
                                    className="flex-1"
                                    placeholder="Reason (optional, kept for the record)"
                                    value={banReason}
                                    disabled={isSelf}
                                    onChange={(event) => setBanReason(event.target.value)}
                                />
                                <Button
                                    size="sm"
                                    variant="danger"
                                    disabled={busy || isSelf}
                                    onClick={() => void run(() => banUserAction(user.id, banReason))}
                                >
                                    <Ban className="size-4" />
                                    Ban
                                </Button>
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
                    </section>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
            </DialogContent>
            {confirmElement}
        </Dialog>
    );
}
