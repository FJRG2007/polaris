"use client";

/**
 * The people directory. A row per account with the facts an operator actually
 * decides on - who they are, what they may do, whether they are locked out, and
 * when they were last here - and a dialog behind each one for everything else.
 *
 * Search and the filters run over the rows already on the page: an instance's
 * whole staff is a small list, and asking the server again for a substring would
 * be slower than reading it.
 */

import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { InviteDialog } from "./invite-dialog";
import { revokeInviteAction } from "./actions";
import { useEffect, useMemo, useState } from "react";
import type { RoleOption } from "@/lib/role-service";
import { RecoveryRequests } from "./recovery-requests";
import { UserDetailDialog } from "./user-detail-dialog";
import type { InviteListItem } from "@/lib/invite-service";
import type { DirectoryUser } from "@/lib/user-admin-service";
import { useDisplayFormat } from "@/components/display-format";
import type { AccessGroupOption } from "@/components/access-rules-editor";
import type { RecoveryRequestView } from "@/lib/account-recovery-service";
import { Badge, Button, Card, CardBody, Input, Select, cn } from "@polaris/ui";
import { Ban, Mail, MapPin, Search, Shield, Trash2, UserPlus } from "lucide-react";

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
    const format = useDisplayFormat();
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [inviting, setInviting] = useState(false);
    // Held by id, not by value: the row is re-read from the server after every
    // change, and a copy taken when the dialog opened would go stale behind it.
    const [openId, setOpenId] = useState<string | null>(openUserId ?? null);

    // A link arriving at ?user= must open that account however it arrives. Seeded
    // state alone only covers the first mount, so going back to a link already
    // followed - the ordinary way to return to it - left the dialog shut on a URL
    // that says it is open.
    useEffect(() => {
        if (openUserId) setOpenId(openUserId);
    }, [openUserId]);

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

    const open = users.find((user) => user.id === openId) ?? null;

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
                                <tr
                                    key={user.id}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={`Open ${user.name}`}
                                    onClick={() => setOpenId(user.id)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            setOpenId(user.id);
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
                                        {user.lastSeenAt
                                            ? format.dateTime(user.lastSeenAt)
                                            : "Never"}
                                        {user.lastCountry ? ` - ${user.lastCountry}` : ""}
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                        {format.date(user.createdAt)}
                                    </td>
                                </tr>
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

            {inviting ? (
                <InviteDialog
                    groups={groups}
                    roles={roles}
                    canSendMail={canSendMail}
                    onOpenChange={(next) => setInviting(next)}
                />
            ) : null}
            {open ? (
                <UserDetailDialog
                    user={open}
                    groups={groups}
                    roles={roles}
                    isSelf={open.id === viewerId}
                    onOpenChange={(next) => {
                        if (next) return;
                        setOpenId(null);
                        // Drop the id a link arrived with, so reloading the page
                        // after closing does not open the same account again.
                        if (openUserId) router.replace("/admin/users");
                    }}
                />
            ) : null}
        </div>
    );
}
