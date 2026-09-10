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
import type { OrgMemberView } from "@/lib/orgs/org-service";
import { useDisplayFormat } from "@/components/display-format";
import { PersonName, PersonRow, PlainNames } from "@/components/person-name";
import type { OrgEmailInviteView, OrgInvitationView } from "@/lib/orgs/invitation-service";
import { Copy, Mail, MailQuestion, RotateCw, Search, UserPlus, Users, X } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select, useToast } from "@polaris/ui";
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
                    <p role="alert" className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm">
                        {error}
                    </p>
                )}

                <Card>
                    <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                        <CardTitle className="flex items-center gap-2">
                            <Users className="size-4 shrink-0" /> People
                            <span className="text-muted-foreground text-xs font-normal">
                                {members.length}
                                {memberLimit > 0 ? ` of ${memberLimit}` : ""}
                            </span>
                        </CardTitle>
                        {members.length >= SEARCH_FROM && (
                            <label className="relative w-full sm:w-56">
                                <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 shrink-0 -translate-y-1/2" />
                                <Input
                                    value={query}
                                    placeholder="Search people"
                                    aria-label="Search people"
                                    className="h-8 pl-7 text-xs"
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
                            <table className="w-full text-sm">
                                <thead className="bg-surface/60 text-muted-foreground text-left text-xs">
                                    <tr>
                                        <th className="px-3 py-2 font-medium">Person</th>
                                        <th className="hidden px-3 py-2 font-medium sm:table-cell">
                                            Teams
                                        </th>
                                        <th className="hidden px-3 py-2 font-medium lg:table-cell">
                                            Joined
                                        </th>
                                        <th className="px-3 py-2 font-medium">Role</th>
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
                                                Nobody here matches &ldquo;{query.trim()}&rdquo;.
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
                                                                                (you)
                                                                            </span>
                                                                        ) : null}
                                                                    </PersonName>
                                                                </span>
                                                                <span
                                                                    className="text-muted-foreground truncate text-xs"
                                                                    title={member.contact}
                                                                >
                                                                    {member.contact}
                                                                </span>
                                                            </span>
                                                        </span>
                                                    </td>
                                                    <td
                                                        className="text-muted-foreground hidden max-w-0 truncate px-3 py-2 text-xs sm:table-cell"
                                                        title={member.teams.join(", ")}
                                                    >
                                                        {member.teams.length > 0
                                                            ? member.teams.join(", ")
                                                            : "None"}
                                                    </td>
                                                    <td className="text-muted-foreground hidden whitespace-nowrap px-3 py-2 text-xs lg:table-cell">
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
                                                                aria-label={`Role for ${member.name}`}
                                                                className="h-8 w-32 text-xs"
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
                                                    <td className="px-3 py-2 text-right">
                                                        {!owner && (canManage || self) && (
                                                            <button
                                                                type="button"
                                                                aria-label={
                                                                    self
                                                                        ? "Leave this organization"
                                                                        : `Remove ${member.name}`
                                                                }
                                                                title={self ? "Leave" : "Remove"}
                                                                className="text-muted-foreground hover:bg-danger-soft hover:text-danger rounded p-1 transition-colors"
                                                                onClick={async () => {
                                                                    const ok = await confirm({
                                                                        title: self
                                                                            ? "Leave this organization?"
                                                                            : `Remove ${member.name}?`,
                                                                        description: self
                                                                            ? "You will lose everything its teams gave you."
                                                                            : "They come off every team here as well, and lose what those teams reached.",
                                                                        confirmLabel: self
                                                                            ? "Leave"
                                                                            : "Remove",
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
                                <MailQuestion className="size-4 shrink-0" /> Waiting to accept
                                <span className="text-muted-foreground text-xs font-normal">
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
                                        <p className="truncate text-sm" title={invite.email}>
                                            {invite.email}
                                        </p>
                                        <p className="text-muted-foreground truncate text-xs">
                                            {invite.sentAt
                                                ? `Emailed by ${invite.invitedBy}`
                                                : `Not emailed yet - invited by ${invite.invitedBy}`}
                                        </p>
                                    </div>
                                    <span className="text-muted-foreground hidden shrink-0 text-xs lg:inline">
                                        Until {format.date(invite.expiresAt)}
                                    </span>
                                    <Badge variant="neutral">{invite.roleName}</Badge>
                                    {canManage && (
                                        <>
                                            <button
                                                type="button"
                                                title="Send again"
                                                aria-label={`Send the invitation to ${invite.email} again`}
                                                className="text-muted-foreground hover:bg-card-hover hover:text-foreground rounded p-1 transition-colors"
                                                onClick={async () => {
                                                    setError("");
                                                    const result = await resendOrgEmailInviteAction(orgId, invite.id);
                                                    if (result.error) {
                                                        setError(result.error);
                                                        return;
                                                    }
                                                    if (result.sendError) {
                                                        setError(`${result.sendError} Copy the new link from Invite somebody.`);
                                                        setLastLink(result.url ?? null);
                                                    } else {
                                                        toast.show({ title: `Sent again to ${invite.email}.` });
                                                    }
                                                    router.refresh();
                                                }}
                                            >
                                                <RotateCw className="size-4 shrink-0" />
                                            </button>
                                            <button
                                                type="button"
                                                title="Withdraw"
                                                aria-label={`Withdraw the invitation to ${invite.email}`}
                                                className="text-muted-foreground hover:bg-danger-soft hover:text-danger rounded p-1 transition-colors"
                                                onClick={async () => {
                                                    const ok = await confirm({
                                                        title: `Withdraw the invitation to ${invite.email}?`,
                                                        description:
                                                            "The link stops working at once. They are not told.",
                                                        confirmLabel: "Withdraw",
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
                                        <p className="truncate text-sm" title={invitation.name}>
                                            <PersonName
                                                id={invitation.userId}
                                                name={invitation.name}
                                            />
                                        </p>
                                        <p className="text-muted-foreground truncate text-xs">
                                            Invited by {invitation.invitedBy}
                                            {invitation.contact ? ` - ${invitation.contact}` : ""}
                                        </p>
                                    </div>
                                    <span className="text-muted-foreground hidden shrink-0 text-xs lg:inline">
                                        Until {format.date(invitation.expiresAt)}
                                    </span>
                                    <Badge variant="neutral">{invitation.roleName}</Badge>
                                    {canManage && (
                                        <button
                                            type="button"
                                            title="Withdraw"
                                            aria-label={`Withdraw the invitation to ${invitation.name}`}
                                            className="text-muted-foreground hover:bg-danger-soft hover:text-danger rounded p-1 transition-colors"
                                            onClick={async () => {
                                                const ok = await confirm({
                                                    title: `Withdraw the invitation to ${invitation.name}?`,
                                                    description:
                                                        "They are not told. You can invite them again at any time.",
                                                    confirmLabel: "Withdraw",
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
    const router = useRouter();
    const toast = useToast();
    const [identifier, setIdentifier] = useState("");
    // The organization's own default, when it still has that role; the seeded
    // member otherwise, which every organization has.
    const initial = roles.some((entry) => entry.slug === defaultRole)
        ? defaultRole
        : (roles.find((entry) => entry.slug === "member")?.slug ?? roles[0]?.slug ?? "member");
    const [role, setRole] = useState(initial);
    const [savingDefault, setSavingDefault] = useState(false);

    const hint = roles.find((entry) => entry.slug === role)?.description ?? "";

    return (
        <Card>
            <CardHeader>
                <CardTitle>Invite somebody</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <form
                    className="flex flex-wrap items-end gap-2"
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
                        if (emailed.sendError) {
                            onLink(emailed.url ?? null);
                            toast.show({ title: "The invitation was made but could not be emailed. Copy the link below." });
                        } else if (emailed.emailed) {
                            toast.show({ title: `Invitation emailed to ${typed}.` });
                        } else {
                            toast.show({ title: "Invitation sent. They will see it when they next sign in." });
                        }
                    }}
                >
                    <label className="text-muted-foreground flex min-w-48 flex-1 flex-col gap-1 text-xs">
                        Email or username
                        <Input
                            value={identifier}
                            placeholder="someone@example.com"
                            className="h-9"
                            disabled={full}
                            maxLength={254}
                            onChange={(event) => setIdentifier(event.target.value)}
                        />
                    </label>
                    <Select
                        value={role}
                        options={options}
                        aria-label="Role"
                        className="h-9 w-36"
                        onValueChange={setRole}
                    />
                    <Button type="submit" size="sm" disabled={!identifier.trim() || full}>
                        <UserPlus className="size-4 shrink-0" /> Invite
                    </Button>
                    <p className="text-muted-foreground w-full text-xs">
                        {full
                            ? `This Polaris allows ${memberLimit} members per organization, counting invitations nobody has answered.`
                            : hint || (
                                  <>
                                      What this role may do is set under{" "}
                                      <a
                                          href={`/account/organizations/${orgSlug}/roles`}
                                          className="hover:text-foreground underline"
                                      >
                                          Roles
                                      </a>
                                      .
                                  </>
                              )}
                    </p>
                    <p className="text-muted-foreground w-full text-xs">
                        {canInviteNewPeople
                            ? "An email with no account behind it gets a link that creates the account and joins them here."
                            : "Only people who already have an account can be invited from here."}
                    </p>
                </form>

                {lastLink ? (
                    <div className="border-border flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
                        <span className="text-muted-foreground w-full text-xs">
                            Hand this link over yourself. It works once and expires in 7 days.
                        </span>
                        <code className="min-w-0 flex-1 truncate text-xs" title={lastLink}>
                            {lastLink}
                        </code>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Copy the invitation link"
                            title="Copy the invitation link"
                            onClick={() =>
                                void navigator.clipboard
                                    .writeText(lastLink)
                                    .then(() => toast.show({ title: "Link copied." }))
                            }
                        >
                            <Copy className="size-4 shrink-0" />
                        </Button>
                    </div>
                ) : null}

                <label className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                    New invitations offer
                    <Select
                        value={roles.some((entry) => entry.slug === defaultRole) ? defaultRole : initial}
                        options={options}
                        aria-label="The role new invitations offer by default"
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
                    by default.
                </label>
            </CardBody>
        </Card>
    );
}
