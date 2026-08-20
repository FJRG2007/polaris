"use client";

/**
 * The people directory. A row per account with the facts an operator actually
 * decides on - who they are, what they may do, whether they are locked out, and
 * when they were last here - and a dialog behind each one for everything else.
 *
 * Search and the filters run over the rows already on the page: an instance's
 * whole staff is a small list, and asking the server again for a substring would
 * be slower than reading it.
 *
 * A right-click on a row carries what an operator came here to do - open the
 * record, walk into the account, shut it, remove it - because the alternative is
 * what it was: open the record, find the control, come back. The record is still
 * where everything lives; this is the short way to the four decisions that are
 * made from the list itself.
 */

import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { InviteDialog } from "./invite-dialog";
import { SuspendDialog } from "./suspend-dialog";
import type { RoleOption } from "@/lib/role-service";
import { RecoveryRequests } from "./recovery-requests";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import type { InviteListItem } from "@/lib/invite-service";
import type { DirectoryUser } from "@/lib/user-admin-service";
import { viewAsUserAction } from "@/app/(app)/view-as-actions";
import { useDisplayFormat } from "@/components/display-format";
import { isOnline, OnlineDot, useNow } from "@/components/presence";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccessGroupOption } from "@/components/access-rules-editor";
import type { RecoveryRequestView } from "@/lib/account-recovery-service";
import { deleteUserAction, revokeInviteAction, unbanUserAction } from "./actions";
import { Ban, Eye, Mail, MapPin, Search, Shield, Trash2, Undo2, UserPlus } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    Input,
    Select,
    cn
} from "@polaris/ui";

/** The cuts an operator reaches for; anything finer is what search is for. */
const FILTERS = [
    { value: "all", label: "Everyone" },
    { value: "admins", label: "Administrators" },
    { value: "limited", label: "Limited" },
    { value: "banned", label: "Banned" }
] as const;

type Filter = (typeof FILTERS)[number]["value"];

/** How an invite is described in the pending list. */
const METHOD_LABELS: Record<InviteListItem["method"], string> = {
    link: "Link",
    magic: "Emailed link",
    code: "Code"
};

function hasLimits(user: DirectoryUser): boolean {
    const { enforced } = user;
    return (
        enforced.groupIds.length > 0 ||
        enforced.allowedCidrs.length > 0 ||
        enforced.allowedCountries.length > 0 ||
        enforced.allowedContinents.length > 0
    );
}

export function UsersAdmin({
    users,
    invites,
    recoveries,
    groups,
    roles,
    canSendMail,
    viewerId,
    openUserId
}: {
    users: DirectoryUser[];
    invites: InviteListItem[];
    recoveries: RecoveryRequestView[];
    groups: AccessGroupOption[];
    /** Every role this instance defines, for the invite and the role picker. */
    roles: RoleOption[];
    canSendMail: boolean;
    viewerId: string;
    /** The account to open on arrival, from `?user=`. An id that matches nobody
     *  opens nothing, which is what a link to a deleted account should do. */
    openUserId?: string | null;
}) {
    const router = useRouter();
    const now = useNow();
    const format = useDisplayFormat();
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [inviting, setInviting] = useState(false);
    const [confirm, confirmElement] = useConfirm();
    /** Who is being shut out. Held here rather than in the row's own menu: the
     *  menu is unmounted the moment an item is chosen, and a dialog opened by
     *  something about to disappear never appears. */
    const [suspending, setSuspending] = useState<DirectoryUser | null>(null);
    const [error, setError] = useState("");

    // A link that names somebody - the firewall, saying who is signed in from an
    // address it is about to ban - hands the reader the account itself. That is
    // now a page, so the link is followed rather than held as state.
    useEffect(() => {
        if (openUserId) router.replace(`/admin/users/${openUserId}`);
    }, [openUserId, router]);

    // Who is here changes while this page is open, and the rows were whatever the
    // server said when it was rendered - so an operator watching the directory saw
    // an account go stale and never come back. The clock ages the "Online" mark on
    // its own; this asks the server for newer activity, and only while the tab is
    // actually being looked at, so a directory left open in a background tab costs
    // nothing.
    useEffect(() => {
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") router.refresh();
        }, 30_000);
        return () => clearInterval(timer);
    }, [router]);

    /** Leave the operator screens behind and carry on as this person. The root
     *  resolves where their own access starts, which is rarely where you are. */
    const openAccount = useCallback(
        async (user: DirectoryUser) => {
            setError("");
            const result = await viewAsUserAction(user.id);
            if (result.error) {
                setError(result.error);
                return;
            }
            router.push("/");
        },
        [router]
    );

    const liftBan = useCallback(
        async (user: DirectoryUser) => {
            setError("");
            const result = await unbanUserAction(user.id);
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        },
        [router]
    );

    const remove = useCallback(
        async (user: DirectoryUser) => {
            const ok = await confirm({
                title: `Delete ${user.name}?`,
                description:
                    "Their account and everything it owns - connections, deployments, shares and uploads - goes with it. This cannot be undone.",
                confirmLabel: "Delete account",
                danger: true
            });
            if (!ok) return;
            setError("");
            const result = await deleteUserAction(user.id);
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        },
        [confirm, router]
    );

    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return users.filter((user) => {
            if (filter === "admins" && !user.isAdmin) return false;
            if (filter === "banned" && !user.banned) return false;
            if (filter === "limited" && !hasLimits(user)) return false;
            if (!needle) return true;
            return [
                user.name,
                user.email,
                user.username,
                user.company,
                ...user.roles,
                ...user.groups
            ]
                .filter((value): value is string => Boolean(value))
                .some((value) => value.toLowerCase().includes(needle));
        });
    }, [users, query, filter]);

    return (
        <div className="flex flex-col gap-4">
            <RecoveryRequests requests={recoveries} />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="pl-9"
                        placeholder="Search by name, address, username, role or group"
                        aria-label="Search people"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                <Select
                    className="sm:w-48"
                    aria-label="Filter people"
                    value={filter}
                    onValueChange={(value) => setFilter(value as Filter)}
                    options={FILTERS.map((entry) => ({ value: entry.value, label: entry.label }))}
                />
                <Button onClick={() => setInviting(true)}>
                    <UserPlus className="size-4" />
                    Invite
                </Button>
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">Person</th>
                            <th className="hidden px-3 py-2 font-medium sm:table-cell">Access</th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">
                                Last seen
                            </th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">Joined</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={4}
                                    className="px-3 py-8 text-center text-muted-foreground"
                                >
                                    {users.length === 0
                                        ? "Nobody here yet."
                                        : "Nobody matches that."}
                                </td>
                            </tr>
                        ) : (
                            shown.map((user) => (
                                <ContextMenu key={user.id}>
                                    <ContextMenuTrigger asChild>
                                <tr
                                    tabIndex={0}
                                    role="button"
                                    aria-label={`Open ${user.name}`}
                                    onClick={() => router.push(`/admin/users/${user.id}`)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            router.push(`/admin/users/${user.id}`);
                                        }
                                    }}
                                    className={cn(
                                        "cursor-pointer border-t border-border hover:bg-card-hover",
                                        user.banned && "opacity-60"
                                    )}
                                >
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-3">
                                            <Avatar person={user} size={36} />
                                            <div className="min-w-0">
                                                <p className="flex items-center gap-1.5 truncate font-medium">
                                                    {user.name}
                                                    {user.id === viewerId ? (
                                                        <span className="text-xs text-muted-foreground">
                                                            (you)
                                                        </span>
                                                    ) : null}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    {user.email}
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="hidden px-3 py-2 sm:table-cell">
                                        <div className="flex flex-wrap items-center gap-1">
                                            {user.isAdmin ? (
                                                <Badge variant="primary">
                                                    <Shield className="size-3" />
                                                    admin
                                                </Badge>
                                            ) : null}
                                            {user.roles.map((role) => (
                                                <Badge key={role}>{role}</Badge>
                                            ))}
                                            {hasLimits(user) ? (
                                                <Badge variant="warning">
                                                    <MapPin className="size-3" />
                                                    limited
                                                </Badge>
                                            ) : null}
                                            {user.banned ? (
                                                <Badge variant="danger">
                                                    <Ban className="size-3" />
                                                    banned
                                                </Badge>
                                            ) : null}
                                            {user.twoFactorEnabled ? (
                                                <Badge variant="success">2FA</Badge>
                                            ) : null}
                                        </div>
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                        {isOnline(user.lastSeenAt, now) ? (
                                            <span
                                                className="flex items-center gap-1.5 text-success"
                                                title={
                                                    user.lastSeenAt
                                                        ? format.dateTime(user.lastSeenAt)
                                                        : undefined
                                                }
                                            >
                                                <OnlineDot />
                                                Online
                                            </span>
                                        ) : user.lastSeenAt ? (
                                            <span title={format.dateTime(user.lastSeenAt)}>
                                                <RelativeTime iso={user.lastSeenAt} />
                                            </span>
                                        ) : (
                                            "Never"
                                        )}
                                        {user.lastCountry ? ` - ${user.lastCountry}` : ""}
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                        {format.date(user.createdAt)}
                                    </td>
                                </tr>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent>
                                        <ContextMenuItem
                                            onSelect={() => router.push(`/admin/users/${user.id}`)}
                                        >
                                            <Shield className="size-4" />
                                            Open their record
                                        </ContextMenuItem>
                                        {/* Not offered on your own row: viewing
                                            as yourself does nothing, and the
                                            three below are all refused by the
                                            service anyway - an administrator
                                            cannot shut or delete themselves. */}
                                        {user.id !== viewerId && (
                                            <>
                                                <ContextMenuItem onSelect={() => void openAccount(user)}>
                                                    <Eye className="size-4" />
                                                    Open their account
                                                </ContextMenuItem>
                                                <ContextMenuSeparator />
                                                {user.banned ? (
                                                    <ContextMenuItem onSelect={() => void liftBan(user)}>
                                                        <Undo2 className="size-4" />
                                                        Lift the suspension
                                                    </ContextMenuItem>
                                                ) : (
                                                    <ContextMenuItem
                                                        variant="danger"
                                                        onSelect={() => setSuspending(user)}
                                                    >
                                                        <Ban className="size-4" />
                                                        Suspend the account
                                                    </ContextMenuItem>
                                                )}
                                                <ContextMenuItem
                                                    variant="danger"
                                                    onSelect={() => void remove(user)}
                                                >
                                                    <Trash2 className="size-4" />
                                                    Delete the account
                                                </ContextMenuItem>
                                            </>
                                        )}
                                    </ContextMenuContent>
                                </ContextMenu>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <h2 className="text-sm font-medium">Pending invites</h2>
                        <p className="text-xs text-muted-foreground">
                            Invites that have not been claimed yet. Revoking one stops it working
                            immediately.
                        </p>
                    </div>
                    {invites.length === 0 ? (
                        <p className="text-sm text-muted-foreground">None outstanding.</p>
                    ) : (
                        invites.map((invite) => (
                            <div
                                key={invite.id}
                                className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
                            >
                                <div className="min-w-0">
                                    <p className="flex flex-wrap items-center gap-1.5 text-sm">
                                        <span className="truncate">{invite.email}</span>
                                        <Badge>{METHOD_LABELS[invite.method]}</Badge>
                                        {invite.role ? <Badge>{invite.role}</Badge> : null}
                                        {invite.needsPassword ? (
                                            <Badge variant="warning">one-time password</Badge>
                                        ) : null}
                                        {invite.restricted ? (
                                            <Badge variant="warning">limited</Badge>
                                        ) : null}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        Expires {format.dateTime(invite.expiresAt)}
                                        {invite.sentAt
                                            ? ` - emailed ${format.dateTime(invite.sentAt)}`
                                            : ""}
                                    </p>
                                </div>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={`Revoke the invite for ${invite.email}`}
                                    title="Revoke"
                                    onClick={() =>
                                        void revokeInviteAction(invite.id).then(() =>
                                            router.refresh()
                                        )
                                    }
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </div>
                        ))
                    )}
                    {!canSendMail ? (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Mail className="size-3.5" />
                            No email channel is nominated, so Polaris cannot send invites itself.
                        </p>
                    ) : null}
                </CardBody>
            </Card>

            {error && (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            )}

            <SuspendDialog
                person={suspending}
                onOpenChange={(next) => !next && setSuspending(null)}
            />
            {confirmElement}

            {inviting ? (
                <InviteDialog
                    groups={groups}
                    roles={roles}
                    canSendMail={canSendMail}
                    onOpenChange={(next) => setInviting(next)}
                />
            ) : null}
        </div>
    );
}
