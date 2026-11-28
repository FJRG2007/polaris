"use client";

/**
 * The roster.
 *
 * A row is a person, not a record: their face, their name, the teams that face
 * turns up on, and the role that decides what they can do here. The role is a
 * picker over the organization's own roles rather than a fixed pair, so an
 * organization that invented "Contractor" hands somebody exactly that.
 *
 * The owner's row has no controls at all. Ownership moves in Settings, in one
 * deliberate place, and never by picking something out of a list on this screen.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { OrgMemberView } from "@/lib/orgs/org-service";
import { useDisplayFormat } from "@/components/display-format";
import { PersonName, PersonRow, PlainNames } from "@/components/person-name";
import type { OrgEmailInviteView, OrgInvitationView } from "@/lib/orgs/invitation-service";
import { Copy, Mail, MailQuestion, RotateCw, Search, UserPlus, Users, X } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    settingType,
    useToast,
    useResetOnOpen
} from "@polaris/ui";
import {
    inviteOrgMemberAction,
    removeOrgMemberAction,
    resendOrgEmailInviteAction,
    revokeOrgEmailInviteAction,
    revokeOrgInvitationAction,
    setOrgDefaultInviteRoleAction,
    setOrgMemberRoleAction
} from "@/app/(app)/account/organizations/actions";

export interface RoleOption {
    readonly slug: string;
    readonly name: string;
    readonly description: string;
}

/** Past this many people a roster is something you search rather than read, so
 *  the field appears instead of sitting there empty on a team of four. */
const SEARCH_FROM = 8;

export function PeopleView({
    orgId,
    orgSlug,
    members,
    invitations,
    emailed,
    roles,
    defaultInviteRole,
    currentUserId,
    canManage,
    canInviteNewPeople,
    memberLimit
}: {
    orgId: string;
    orgSlug: string;
    members: OrgMemberView[];
    /** People asked and not yet answered. They are not on the roster and reach
     *  nothing here until they accept. */
    invitations: OrgInvitationView[];
    /** Addresses with no account yet, emailed a link that makes one. */
    emailed: OrgEmailInviteView[];
    roles: RoleOption[];
    /** What an invitation offers unless the person sending it picks otherwise. */
    defaultInviteRole: string;
    currentUserId: string;
    canManage: boolean;
    canInviteNewPeople: boolean;
    memberLimit: number;
}) {
    const t = useTranslations("accountOrgs");
    const router = useRouter();
    const format = useDisplayFormat();
    const toast = useToast();
    const [confirm, confirmElement] = useConfirm();
    const [error, setError] = useState("");
    const [query, setQuery] = useState("");
    const [lastLink, setLastLink] = useState<string | null>(null);

    // Invitations count against the cap: they are people who have been promised
    // a place, and the moment to say the room is full is before asking.
    const full =
        memberLimit > 0 && members.length + invitations.length + emailed.length >= memberLimit;
    const waiting = invitations.length + emailed.length;
    const options = roles.map((role) => ({ value: role.slug, label: role.name }));

    const needle = query.trim().toLowerCase();
    const shown = needle
        ? members.filter(
              (member) =>
                  member.name.toLowerCase().includes(needle) ||
                  member.contact.toLowerCase().includes(needle) ||
                  member.teams.some((team) => team.toLowerCase().includes(needle))
          )
        : members;

    const run = async (work: () => Promise<{ error?: string } | null>): Promise<boolean> => {
        setError("");
        const result = await work();
        if (result?.error) {
            setError(result.error);
            return false;
        }
        router.refresh();
        return true;
    };

    return (
        <PlainNames>
            <div className="flex flex-col gap-4">
                {error && (
                    <p role="alert" className={cn(settingType.body, "bg-danger-soft text-danger-ink rounded-md px-3 py-2")}>
                        {error}
                    </p>
                )}

                <Card>
                    <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                        <CardTitle className="flex items-center gap-2">
                            <Users className="size-4 shrink-0" /> {t("people.title")}
                            <span className={cn(settingType.hint, "font-normal")}>
                                {memberLimit > 0
                                    ? t("form.ofLimit", { count: members.length, limit: memberLimit })
                                    : members.length}
                            </span>
                        </CardTitle>
                        {members.length >= SEARCH_FROM && (
                            <label className="relative w-full sm:w-56">
                                <Search className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-3.5 shrink-0 -translate-y-1/2" />
                                <Input
                                    value={query}
                                    placeholder={t("people.search")}
                                    aria-label={t("people.search")}
                                    className={cn(settingType.body, "h-8 ps-7")}
                                    onChange={(event) => setQuery(event.target.value)}
                                />
                            </label>
                        )}
                    </CardHeader>
                    <CardBody className="p-0">
                        {/* A table, the way the account list under Administration
                            draws one. A roster is read by scanning down a column -
                            who is an owner, who joined when, who is on which team -
                            and a stack of cards turns every one of those into a
                            search instead of a glance. */}
                        <div className="overflow-x-auto">
                            <table className={cn(settingType.body, "w-full")}>
                                <thead className={cn(settingType.small, "bg-surface/60 text-muted-foreground text-start")}>
                                    <tr>
                                        <th className="px-3 py-2 font-medium">{t("people.columns.person")}</th>
                                        <th className="hidden px-3 py-2 font-medium sm:table-cell">
                                            {t("people.columns.teams")}
                                        </th>
                                        <th className="hidden px-3 py-2 font-medium lg:table-cell">
                                            {t("people.columns.joined")}
                                        </th>
                                        <th className="px-3 py-2 font-medium">{t("people.columns.role")}</th>
                                        <th className="w-10 px-3 py-2" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {shown.length === 0 ? (
                                        <tr>
                                            <td
                                                colSpan={5}
                                                className="text-muted-foreground px-3 py-8 text-center"
                                            >
                                                {t("people.noMatch", { query: query.trim() })}
                                            </td>
                                        </tr>
                                    ) : (
                                        shown.map((member) => {
                                            const self = member.userId === currentUserId;
                                            const owner = member.role === "owner";
                                            return (
                                                <PersonRow
                                                    as="tr"
                                                    key={member.userId}
                                                    personId={member.userId}
                                                    className="border-border hover:bg-muted border-t"
                                                >
                                                    <td className="px-3 py-2">
                                                        <span className="flex min-w-0 items-center gap-2">
                                                            <Avatar
                                                                person={{
                                                                    id: member.userId,
                                                                    name: member.name
                                                                }}
                                                                size={28}
                                                            />
                                                            <span className="flex min-w-0 flex-col leading-tight">
                                                                <span className="truncate">
                                                                    <PersonName
                                                                        id={member.userId}
                                                                        name={member.name}
                                                                    >
                                                                        {self ? (
                                                                            <span className="text-muted-foreground">
                                                                                {" "}
                                                                                {t("form.you")}
                                                                            </span>
                                                                        ) : null}
                                                                    </PersonName>
                                                                </span>
                                                                <span
                                                                    className={cn(settingType.hint, "truncate")}
                                                                    title={member.contact}
                                                                >
                                                                    {member.contact}
                                                                </span>
                                                            </span>
                                                        </span>
                                                    </td>
                                                    <td
                                                        className={cn(settingType.hint, "hidden max-w-0 truncate px-3 py-2 sm:table-cell")}
                                                        title={member.teams.join(", ")}
                                                    >
                                                        {member.teams.length > 0
                                                            ? member.teams.join(", ")
                                                            : t("people.noTeams")}
                                                    </td>
                                                    <td className={cn(settingType.hint, "hidden whitespace-nowrap px-3 py-2 lg:table-cell")}>
                                                        {member.joinedAt
                                                            ? format.date(member.joinedAt)
                                                            : ""}
                                                    </td>
                                                    <td className="px-3 py-2">
                                                        {owner || !canManage ? (
                                                            <Badge
                                                                variant={owner ? "primary" : "neutral"}
                                                            >
                                                                {member.roleName}
                                                            </Badge>
                                                        ) : (
                                                            <Select
                                                                value={member.role}
                                                                options={options}
                                                                aria-label={t("form.roleFor", { name: member.name })}
                                                                className={cn(settingType.body, "h-8 w-32")}
                                                                onValueChange={(next) =>
                                                                    void run(() =>
                                                                        setOrgMemberRoleAction(
                                                                            orgId,
                                                                            member.userId,
                                                                            next
                                                                        )
                                                                    )
                                                                }
                                                            />
                                                        )}
                                                    </td>
                                                    <td className="px-3 py-2 text-end">
                                                        {!owner && (canManage || self) && (
                                                            <button
                                                                type="button"
                                                                aria-label={
                                                                    self
                                                                        ? t("people.leaveOrg")
                                                                        : t("form.removeName", { name: member.name })
                                                                }
                                                                title={self ? t("form.leave") : t("form.remove")}
                                                                className="text-muted-foreground hover:bg-danger-soft hover:text-danger rounded p-1 transition-colors"
                                                                onClick={async () => {
                                                                    const ok = await confirm({
                                                                        title: self
                                                                            ? t("people.leaveTitle")
                                                                            : t("people.removeTitle", { name: member.name }),
                                                                        description: self
                                                                            ? t("people.leaveBody")
                                                                            : t("people.removeBody"),
                                                                        confirmLabel: self
                                                                            ? t("form.leave")
                                                                            : t("form.remove"),
                                                                        danger: true
                                                                    });
                                                                    if (!ok) return;
                                                                    const done = await run(() =>
                                                                        removeOrgMemberAction(
                                                                            orgId,
                                                                            member.userId
                                                                        )
                                                                    );
                                                                    if (done && self) {
                                                                        router.push(
                                                                            "/account/organizations"
                                                                        );
                                                                    }
                                                                }}
                                                            >
                                                                <X className="size-4 shrink-0" />
                                                            </button>
                                                        )}
                                                    </td>
                                                </PersonRow>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </CardBody>
                </Card>

                {waiting > 0 && (
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <MailQuestion className="size-4 shrink-0" /> {t("people.waiting")}
                                <span className={cn(settingType.hint, "font-normal")}>
                                    {waiting}
                                </span>
                            </CardTitle>
                        </CardHeader>
                        <CardBody className="flex flex-col gap-1">
                            {emailed.map((invite) => (
                                <div
                                    key={invite.id}
                                    className="hover:bg-muted flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5"
                                >
                                    <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full">
                                        <Mail className="size-4 shrink-0" aria-hidden />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className={cn(settingType.body, "truncate")} title={invite.email}>
                                            {invite.email}
                                        </p>
                                        <p className={cn(settingType.hint, "truncate")}>
                                            {invite.sentAt
                                                ? t("people.emailedBy", { name: invite.invitedBy })
                                                : t("people.notEmailed", { name: invite.invitedBy })}
                                        </p>
                                    </div>
                                    <span className={cn(settingType.hint, "hidden min-w-0 max-w-full shrink-0 truncate lg:inline")} title={t("people.until", { date: format.date(invite.expiresAt) })}>
                                        {t("people.until", { date: format.date(invite.expiresAt) })}
                                    </span>
                                    <Badge variant="neutral">{invite.roleName}</Badge>
                                    {canManage && (
                                        <>
                                            <button
                                                type="button"
                                                title={t("people.sendAgain")}
                                                aria-label={t("people.sendAgainLabel", { email: invite.email })}
                                                className="text-muted-foreground hover:bg-card-hover hover:text-foreground rounded p-1 transition-colors"
                                                onClick={async () => {
                                                    setError("");
                                                    const result = await resendOrgEmailInviteAction(orgId, invite.id);
                                                    if (result.error) {
                                                        setError(result.error);
                                                        return;
                                                    }
                                                    if (result.sendError) {
                                                        setError(t("people.sendAgainFailed", { reason: result.sendError }));
                                                        setLastLink(result.url ?? null);
                                                    } else {
                                                        toast.show({ title: t("people.sentAgain", { email: invite.email }) });
                                                    }
                                                    router.refresh();
                                                }}
                                            >
                                                <RotateCw className="size-4 shrink-0" />
                                            </button>
                                            <button
                                                type="button"
                                                title={t("people.withdraw")}
                                                aria-label={t("people.withdrawLabel", { name: invite.email })}
                                                className="text-muted-foreground hover:bg-danger-soft hover:text-danger rounded p-1 transition-colors"
                                                onClick={async () => {
                                                    const ok = await confirm({
                                                        title: t("people.withdrawTitle", { name: invite.email }),
                                                        description: t("people.withdrawEmailBody"),
                                                        confirmLabel: t("people.withdraw"),
                                                        danger: true
                                                    });
                                                    if (!ok) return;
                                                    await run(() => revokeOrgEmailInviteAction(orgId, invite.id));
                                                }}
                                            >
                                                <X className="size-4 shrink-0" />
                                            </button>
                                        </>
                                    )}
                                </div>
                            ))}
                            {invitations.map((invitation) => (
                                <PersonRow
                                    key={invitation.id}
                                    personId={invitation.userId}
                                    className="hover:bg-muted flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5"
                                >
                                    <Avatar
                                        person={{ id: invitation.userId, name: invitation.name }}
                                        size={32}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p className={cn(settingType.body, "truncate")} title={invitation.name}>
                                            <PersonName
                                                id={invitation.userId}
                                                name={invitation.name}
                                            />
                                        </p>
                                        <p className={cn(settingType.hint, "truncate")}>
                                            {invitation.contact
                                                ? t("people.invitedByWithContact", {
                                                      name: invitation.invitedBy,
                                                      contact: invitation.contact
                                                  })
                                                : t("people.invitedBy", { name: invitation.invitedBy })}
                                        </p>
                                    </div>
                                    <span className={cn(settingType.hint, "hidden min-w-0 max-w-full shrink-0 truncate lg:inline")} title={t("people.until", { date: format.date(invitation.expiresAt) })}>
                                        {t("people.until", { date: format.date(invitation.expiresAt) })}
                                    </span>
                                    <Badge variant="neutral">{invitation.roleName}</Badge>
                                    {canManage && (
                                        <button
                                            type="button"
                                            title={t("people.withdraw")}
                                            aria-label={t("people.withdrawLabel", { name: invitation.name })}
                                            className="text-muted-foreground hover:bg-danger-soft hover:text-danger rounded p-1 transition-colors"
                                            onClick={async () => {
                                                const ok = await confirm({
                                                    title: t("people.withdrawTitle", { name: invitation.name }),
                                                    description: t("people.withdrawAccountBody"),
                                                    confirmLabel: t("people.withdraw"),
                                                    danger: true
                                                });
                                                if (!ok) return;
                                                await run(() =>
                                                    revokeOrgInvitationAction(orgId, invitation.id)
                                                );
                                            }}
                                        >
                                            <X className="size-4 shrink-0" />
                                        </button>
                                    )}
                                </PersonRow>
                            ))}
                        </CardBody>
                    </Card>
                )}

                {canManage && (
                    <InvitePerson
                        orgId={orgId}
                        orgSlug={orgSlug}
                        roles={roles}
                        options={options}
                        defaultRole={defaultInviteRole}
                        canInviteNewPeople={canInviteNewPeople}
                        full={full}
                        memberLimit={memberLimit}
                        lastLink={lastLink}
                        onLink={setLastLink}
                        onRun={run}
                    />
                )}
                {confirmElement}
            </div>
        </PlainNames>
    );
}

function InvitePerson({
    orgId,
    orgSlug,
    roles,
    options,
    defaultRole,
    canInviteNewPeople,
    full,
    memberLimit,
    lastLink,
    onLink,
    onRun
}: {
    orgId: string;
    orgSlug: string;
    roles: RoleOption[];
    options: { value: string; label: string }[];
    defaultRole: string;
    canInviteNewPeople: boolean;
    full: boolean;
    memberLimit: number;
    /** A link Polaris could not email, to be handed over some other way. */
    lastLink: string | null;
    onLink: (link: string | null) => void;
    onRun: (work: () => Promise<{ error?: string } | null>) => Promise<boolean>;
}) {
    const t = useTranslations("accountOrgs");
    const router = useRouter();
    const toast = useToast();
    const [inviting, setInviting] = useState(false);
    const [identifier, setIdentifier] = useState("");
    // The organization's own default, when it still has that role; the seeded
    // member otherwise, which every organization has.
    const initial = roles.some((entry) => entry.slug === defaultRole)
        ? defaultRole
        : (roles.find((entry) => entry.slug === "member")?.slug ?? roles[0]?.slug ?? "member");
    const [role, setRole] = useState(initial);
    useResetOnOpen(inviting, () => {
        setIdentifier("");
        setRole(initial);
    });
    const [savingDefault, setSavingDefault] = useState(false);

    const hint = roles.find((entry) => entry.slug === role)?.description ?? "";

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                <CardTitle>{t("people.invite.title")}</CardTitle>
                <Button
                    size="sm"
                    disabled={full}
                    title={full ? t("people.invite.full", { limit: memberLimit }) : undefined}
                    onClick={() => setInviting(true)}
                >
                    <UserPlus className="size-4 shrink-0" /> {t("people.invite.open")}
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">

                {lastLink ? (
                    <div className="border-border flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
                        <span className={cn(settingType.hint, "w-full")}>
                            {t("people.invite.linkHint")}
                        </span>
                        <code className="min-w-0 flex-1 truncate text-xs" title={lastLink}>
                            {lastLink}
                        </code>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("people.invite.copyLink")}
                            title={t("people.invite.copyLink")}
                            onClick={() =>
                                void navigator.clipboard
                                    .writeText(lastLink)
                                    .then(() => toast.show({ title: t("people.invite.copied") }))
                            }
                        >
                            <Copy className="size-4 shrink-0" />
                        </Button>
                    </div>
                ) : null}

                <label className={cn(settingType.hint, "flex flex-wrap items-center gap-2")}>
                    {t.rich("people.invite.defaultRole", {
                        picker: (
                            <Select
                                key="picker"
                                value={roles.some((entry) => entry.slug === defaultRole) ? defaultRole : initial}
                                options={options}
                                aria-label={t("people.invite.defaultRoleLabel")}
                                className="h-8 w-40"
                                disabled={savingDefault}
                                onValueChange={async (next) => {
                                    setSavingDefault(true);
                                    const done = await onRun(() => setOrgDefaultInviteRoleAction(orgId, next));
                                    setSavingDefault(false);
                                    if (done) {
                                        setRole(next);
                                        router.refresh();
                                    }
                                }}
                            />
                        )
                    })}
                </label>
            </CardBody>
            <Dialog open={inviting} onOpenChange={setInviting}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("people.invite.title")}</DialogTitle>
                        <DialogDescription>{t("people.invite.dialogHint")}</DialogDescription>
                    </DialogHeader>
                    <form
                        className="flex flex-col gap-3"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            const typed = identifier.trim();
                            if (!typed) return;
                            onLink(null);
                            let emailed: { emailed?: boolean; url?: string; sendError?: string } = {};
                            const done = await onRun(async () => {
                                const result = await inviteOrgMemberAction(orgId, typed, role);
                                emailed = result;
                                return result;
                            });
                            if (!done) return;
                            setIdentifier("");
                            setInviting(false);
                            if (emailed.sendError) {
                                onLink(emailed.url ?? null);
                                toast.show({ title: t("people.invite.notEmailed") });
                            } else if (emailed.emailed) {
                                toast.show({ title: t("people.invite.emailed", { email: typed }) });
                            } else {
                                toast.show({ title: t("people.invite.sent") });
                            }
                        }}
                    >
                        <label className={cn(settingType.hint, "flex flex-col gap-1")}>
                            {t("form.identifier")}
                            <Input
                                autoFocus
                                value={identifier}
                                placeholder={t("form.identifierPlaceholder")}
                                className="h-9"
                                disabled={full}
                                maxLength={254}
                                onChange={(event) => setIdentifier(event.target.value)}
                            />
                        </label>
                        <Select
                            value={role}
                            options={options}
                            aria-label={t("form.role")}
                            className="h-9"
                            onValueChange={setRole}
                        />
                        <p className={cn(settingType.hint, "w-full")}>
                            {full
                                ? t("people.invite.full", { limit: memberLimit })
                                : hint ||
                                  t.rich("people.invite.rolesHint", {
                                      roles: (chunks) => (
                                          <a
                                              key="roles"
                                              href={`/account/organizations/${orgSlug}/roles`}
                                              className="hover:text-foreground underline"
                                          >
                                              {chunks}
                                          </a>
                                      )
                                  })}
                        </p>
                        <p className={cn(settingType.hint, "w-full")}>
                            {canInviteNewPeople ? t("people.invite.newPeople") : t("people.invite.existingOnly")}
                        </p>
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => setInviting(false)}>
                                {t("people.invite.cancel")}
                            </Button>
                            <Button type="submit" aria-disabled={!identifier.trim() || full}>
                                <UserPlus className="size-4 shrink-0" /> {t("people.invite.submit")}
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
