"use client";

/**
 * The people directory. A row per account with the facts an operator actually
 * decides on - who they are, what they may do, whether they are locked out, and
 * when they were last here - and a dialog behind each one for everything else.
 *
 * Read a page at a time, and narrowed by the database: a search or a cut asks
 * the server again from the top, and the next page is asked for as the end
 * comes into view. Only the rows on screen are drawn. It used to read every
 * account and filter them here, which is a screen that grows with the instance
 * until it is the slowest one in it - the directory of a host with ten thousand
 * customers took the whole of that to paint.
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
import type { Page } from "@/lib/pagination/cursor";
import type { DirectoryUser } from "@/lib/user-admin-service";
import { usePagedList } from "@/components/paged-list/use-paged-list";
import { VirtualTableBody } from "@/components/paged-list/virtual-table-body";
import { DIRECTORY_FILTERS, type DirectoryFilter } from "@/lib/user-directory-filters";
import { viewAsUserAction } from "@/app/(app)/view-as-actions";
import { useDisplayFormat } from "@/components/display-format";
import { PersonName, PersonRow } from "@/components/person-name";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useState } from "react";
import { isOnline, OnlineDot, useNow } from "@/components/presence";
import type { AccessGroupOption } from "@/components/access-rules-editor";
import type { RecoveryRequestView } from "@/lib/account-recovery-service";
import {
    deleteUserAction,
    listUserDirectoryAction,
    revokeInviteAction,
    setContactVerifiedAction,
    unbanUserAction
} from "./actions";
import {
    Ban,
    Eye,
    Mail,
    MailCheck,
    MapPin,
    PhoneCall,
    Search,
    Shield,
    Trash2,
    Undo2,
    UserPlus
} from "lucide-react";
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

/** How long typing settles before the search asks the server. */
const SEARCH_SETTLE_MS = 300;

/** A row's height before it is measured: the avatar and two lines. */
const ROW_ESTIMATE = 57;

/** What the list is narrowed by. */
interface DirectoryParams {
    readonly query: string;
    readonly filter: DirectoryFilter;
}

const UNNARROWED: DirectoryParams = { query: "", filter: "all" };

/** A page, as the list asks for one. */
function loadDirectory(cursor: string | null, params: DirectoryParams, limit?: number) {
    return listUserDirectoryAction({ cursor, query: params.query, filter: params.filter, limit });
}

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
    first,
    invites,
    recoveries,
    groups,
    roles,
    canSendMail,
    viewerId,
    openUserId
}: {
    /** The top of the directory, unnarrowed, as the server rendered it. */
    first: Page<DirectoryUser>;
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
    const t = useTranslations("admin");
    const router = useRouter();
    const now = useNow();
    const format = useDisplayFormat();
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<DirectoryFilter>("all");
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

    /**
     * Say that an address or a number is theirs, without them proving it.
     *
     * Confirmed on the way in only when it is being turned ON, which is the
     * direction that grants something. Taking it back is recoverable by doing it
     * again, and asking twice about that would be a dialog for a shrug.
     */
    const verify = useCallback(
        async (user: DirectoryUser, what: "email" | "phone", on: boolean) => {
            const label = what === "email" ? user.email : user.phone;
            if (on) {
                const ok = await confirm({
                    title: t("users.verify.title", { hasLabel: label ? "yes" : "no", label: label ?? "" }),
                    description: t("users.verify.description", { name: user.name }),
                    confirmLabel: t("users.verify.confirm")
                });
                if (!ok) return;
            }
            setError("");
            const result = await setContactVerifiedAction(user.id, what, on);
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        },
        [confirm, router, t]
    );

    const remove = useCallback(
        async (user: DirectoryUser) => {
            const ok = await confirm({
                title: t("users.remove.title", { name: user.name }),
                description: t("users.remove.description"),
                confirmLabel: t("users.remove.confirm"),
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
        [confirm, router, t]
    );

    // Typing settles before the server is asked, so a name is one request
    // rather than one per letter.
    useEffect(() => {
        const timer = setTimeout(() => setSearch(query.trim()), SEARCH_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [query]);

    const list = usePagedList({
        first,
        params: { query: search, filter },
        initialParams: UNNARROWED,
        load: loadDirectory
    });
    const shown = list.items;
    const narrowed = search !== "" || filter !== "all";

    return (
        <div className="flex flex-col gap-4">
            <RecoveryRequests requests={recoveries} />
            {error && (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            )}

            {/* Above the directory, which loads more as it is scrolled and so has
                no end to put anything under. Absent when there is nothing to say. */}
            {invites.length > 0 || !canSendMail ? (
                <Card>
                    <CardBody className="flex flex-col gap-3">
                        <div>
                            <h2 className="text-sm font-medium">{t("users.invites.title")}</h2>
                            <p className="text-xs text-muted-foreground">{t("users.invites.hint")}</p>
                        </div>
                        {invites.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("users.invites.none")}</p>
                        ) : (
                            invites.map((invite) => (
                                <div
                                    key={invite.id}
                                    className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
                                >
                                    <div className="min-w-0">
                                        <p className="flex flex-wrap items-center gap-1.5 text-sm">
                                            <span className="truncate">{invite.email}</span>
                                            <Badge>{t(`users.methods.${invite.method}`)}</Badge>
                                            {invite.role ? <Badge>{invite.role}</Badge> : null}
                                            {invite.needsPassword ? (
                                                <Badge variant="warning">{t("users.invites.oneTimePassword")}</Badge>
                                            ) : null}
                                            {invite.restricted ? (
                                                <Badge variant="warning">{t("users.invites.limited")}</Badge>
                                            ) : null}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {invite.sentAt
                                                ? t("users.invites.expiresEmailed", {
                                                      expires: format.dateTime(invite.expiresAt),
                                                      sent: format.dateTime(invite.sentAt)
                                                  })
                                                : t("users.invites.expires", {
                                                      expires: format.dateTime(invite.expiresAt)
                                                  })}
                                        </p>
                                    </div>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={t("users.invites.revokeLabel", { email: invite.email })}
                                        title={t("users.invites.revoke")}
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
                                {t("users.invites.noMail")}
                            </p>
                        ) : null}
                    </CardBody>
                </Card>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="pl-9"
                        placeholder={t("users.directory.searchPlaceholder")}
                        aria-label={t("users.directory.searchLabel")}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                <Select
                    className="sm:w-48"
                    aria-label={t("users.directory.filterLabel")}
                    value={filter}
                    onValueChange={(value) => setFilter(value as DirectoryFilter)}
                    options={DIRECTORY_FILTERS.map((value) => ({ value, label: t(`users.filters.${value}`) }))}
                />
                <Button onClick={() => setInviting(true)}>
                    <UserPlus className="size-4" />
                    {t("users.directory.invite")}
                </Button>
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="w-full max-w-0 px-3 py-2 font-medium">{t("users.directory.columns.person")}</th>
                            <th className="hidden px-3 py-2 font-medium sm:table-cell">
                                {t("users.directory.columns.access")}
                            </th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">
                                {t("users.directory.columns.lastSeen")}
                            </th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">
                                {t("users.directory.columns.joined")}
                            </th>
                        </tr>
                    </thead>
                    {shown.length === 0 ? (
                        <tbody>
                            <tr>
                                <td
                                    colSpan={4}
                                    className="px-3 py-8 text-center text-muted-foreground"
                                >
                                    {list.loading
                                        ? t("users.directory.loading")
                                        : list.error
                                          ? t("users.directory.loadFailed")
                                          : narrowed
                                            ? t("users.directory.noMatch")
                                            : t("users.directory.empty")}
                                </td>
                            </tr>
                        </tbody>
                    ) : (
                        <VirtualTableBody
                            items={shown}
                            estimate={ROW_ESTIMATE}
                            colSpan={4}
                            getKey={(user) => user.id}
                            onNearEnd={list.loadMore}
                            footer={
                                list.loading || list.error ? (
                                    <tr className="border-t border-border">
                                        <td
                                            colSpan={4}
                                            className="px-3 py-3 text-center text-xs text-muted-foreground"
                                        >
                                            {list.error ? (
                                                <span className="inline-flex items-center gap-2">
                                                    {t("users.directory.loadFailed")}
                                                    <Button size="sm" variant="ghost" onClick={list.loadMore}>
                                                        {t("users.directory.retry")}
                                                    </Button>
                                                </span>
                                            ) : (
                                                t("users.directory.loadingMore")
                                            )}
                                        </td>
                                    </tr>
                                ) : null
                            }
                            renderRow={(user, row) => (
                                <ContextMenu key={user.id}>
                                    <ContextMenuTrigger asChild>
                                <tr
                                    {...row}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={t("users.directory.open", { name: user.name })}
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
                                    <td className="w-full max-w-0 px-3 py-2">
                                        {/* The plate goes on this rather than on
                                            the row: a table row painted edge to
                                            edge is a band across the whole
                                            directory, not somebody's nameplate. */}
                                        <PersonRow
                                            personId={user.id}
                                            className="flex items-center gap-3 rounded-md px-1.5 py-0.5"
                                        >
                                            <Avatar person={user} size={36} />
                                            <div className="min-w-0">
                                                <p className="flex items-center gap-1.5 font-medium" title={user.name}>
                                                    <span className="min-w-0 truncate">
                                                        <PersonName id={user.id} name={user.name} />
                                                    </span>
                                                    {user.id === viewerId ? (
                                                        <span className="shrink-0 text-xs text-muted-foreground">
                                                            {t("users.directory.you")}
                                                        </span>
                                                    ) : null}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    {user.email}
                                                </p>
                                            </div>
                                        </PersonRow>
                                    </td>
                                    <td className="hidden px-3 py-2 sm:table-cell">
                                        <div className="flex flex-wrap items-center gap-1">
                                            {user.isAdmin ? (
                                                <Badge variant="primary">
                                                    <Shield className="size-3" />
                                                    {t("users.directory.badges.admin")}
                                                </Badge>
                                            ) : null}
                                            {user.roles.map((role) => (
                                                <Badge key={role}>{role}</Badge>
                                            ))}
                                            {hasLimits(user) ? (
                                                <Badge variant="warning">
                                                    <MapPin className="size-3" />
                                                    {t("users.directory.badges.limited")}
                                                </Badge>
                                            ) : null}
                                            {user.banned ? (
                                                <Badge variant="danger">
                                                    <Ban className="size-3" />
                                                    {t("users.directory.badges.banned")}
                                                </Badge>
                                            ) : null}
                                            {user.twoFactorEnabled ? (
                                                <Badge variant="success">2FA</Badge> // i18n-ignore: the same abbreviation in every language
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
                                                {t("users.directory.online")}
                                            </span>
                                        ) : user.lastSeenAt ? (
                                            <span title={format.dateTime(user.lastSeenAt)}>
                                                <RelativeTime iso={user.lastSeenAt} />
                                            </span>
                                        ) : (
                                            t("users.directory.never")
                                        )}
                                        {user.lastCountry
                                            ? t("users.directory.country", { country: user.lastCountry })
                                            : ""}
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
                                            {t("users.menu.openRecord")}
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        {/* Asserting it rather than proving it,
                                            which is what an administrator is
                                            for here: an address on a domain
                                            this instance cannot deliver to, or
                                            a number in a country the message
                                            never arrives in, left somebody
                                            permanently half-signed-up. It goes
                                            into the audit trail as an assertion,
                                            because that is the difference
                                            anybody later asking how we know
                                            needs to see. */}
                                        <ContextMenuItem
                                            onSelect={() =>
                                                void verify(user, "email", !user.emailVerified)
                                            }
                                        >
                                            <MailCheck className="size-4" />
                                            {user.emailVerified
                                                ? t("users.menu.emailUnverify")
                                                : t("users.menu.emailVerify")}
                                        </ContextMenuItem>
                                        {/* Nothing to verify where there is no
                                            number: a factor confirmed and absent
                                            is a state nobody can get out of. */}
                                        {user.phone && (
                                            <ContextMenuItem
                                                onSelect={() =>
                                                    void verify(user, "phone", !user.phoneVerified)
                                                }
                                            >
                                                <PhoneCall className="size-4" />
                                                {user.phoneVerified
                                                    ? t("users.menu.phoneUnverify")
                                                    : t("users.menu.phoneVerify")}
                                            </ContextMenuItem>
                                        )}
                                        {/* Not offered on your own row: viewing
                                            as yourself does nothing, and the
                                            three below are all refused by the
                                            service anyway - an administrator
                                            cannot shut or delete themselves. */}
                                        {user.id !== viewerId && (
                                            <>
                                                <ContextMenuItem onSelect={() => void openAccount(user)}>
                                                    <Eye className="size-4" />
                                                    {t("users.menu.openAccount")}
                                                </ContextMenuItem>
                                                <ContextMenuSeparator />
                                                {user.banned ? (
                                                    <ContextMenuItem onSelect={() => void liftBan(user)}>
                                                        <Undo2 className="size-4" />
                                                        {t("users.menu.liftSuspension")}
                                                    </ContextMenuItem>
                                                ) : (
                                                    <ContextMenuItem
                                                        variant="danger"
                                                        onSelect={() => setSuspending(user)}
                                                    >
                                                        <Ban className="size-4" />
                                                        {t("users.menu.suspend")}
                                                    </ContextMenuItem>
                                                )}
                                                <ContextMenuItem
                                                    variant="danger"
                                                    onSelect={() => void remove(user)}
                                                >
                                                    <Trash2 className="size-4" />
                                                    {t("users.menu.delete")}
                                                </ContextMenuItem>
                                            </>
                                        )}
                                    </ContextMenuContent>
                                </ContextMenu>
                            )}
                        />
                    )}
                </table>
            </div>

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
