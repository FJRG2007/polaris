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
import { LogOut, MailQuestion, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import type { OrgInvitationView } from "@/lib/orgs/invitation-service";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import {
    inviteOrgMemberAction,
    removeOrgMemberAction,
    revokeOrgInvitationAction,
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
    roles,
    currentUserId,
    canManage,
    memberLimit
}: {
    orgId: string;
    orgSlug: string;
    members: OrgMemberView[];
    /** People asked and not yet answered. They are not on the roster and reach
     *  nothing here until they accept. */
    invitations: OrgInvitationView[];
    roles: RoleOption[];
    currentUserId: string;
    canManage: boolean;
    memberLimit: number;
}) {
    const router = useRouter();
    const format = useDisplayFormat();
    const [confirm, confirmElement] = useConfirm();
    const [error, setError] = useState("");
    const [query, setQuery] = useState("");

    // Invitations count against the cap: they are people who have been promised
    // a place, and the moment to say the room is full is before asking.
    const full = memberLimit > 0 && members.length + invitations.length >= memberLimit;
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
        <div className="flex flex-col gap-4">
            {error && (
                <p role="alert" className="bg-danger/10 text-danger rounded-md px-3 py-2 text-sm">
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
                <CardBody className="flex flex-col gap-1">
                    {shown.length === 0 ? (
                        <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
                            Nobody here matches &ldquo;{query.trim()}&rdquo;.
                        </p>
                    ) : (
                        shown.map((member) => {
                            const self = member.userId === currentUserId;
                            const owner = member.role === "owner";
                            return (
                                <div
                                    key={member.userId}
                                    className="hover:bg-muted flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5"
                                >
                                    <Avatar
                                        person={{ id: member.userId, name: member.name }}
                                        size={32}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm">
                                            {member.name}
                                            {self ? (
                                                <span className="text-muted-foreground">
                                                    {" "}
                                                    (you)
                                                </span>
                                            ) : null}
                                        </p>
                                        <p
                                            className="text-muted-foreground truncate text-xs"
                                            title={member.contact}
                                        >
                                            {member.teams.length > 0
                                                ? member.teams.join(", ")
                                                : member.contact}
                                        </p>
                                    </div>
                                    {member.joinedAt && (
                                        <span className="text-muted-foreground hidden shrink-0 text-xs lg:inline">
                                            Joined {format.date(member.joinedAt)}
                                        </span>
                                    )}
                                    {owner || !canManage ? (
                                        <Badge variant={owner ? "primary" : "neutral"}>
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
                                    {!owner && (canManage || self) && (
                                        <button
                                            type="button"
                                            aria-label={
                                                self
                                                    ? "Leave this organization"
                                                    : `Remove ${member.name}`
                                            }
                                            title={self ? "Leave" : "Remove"}
                                            className="text-muted-foreground hover:bg-danger/10 hover:text-danger rounded p-1 transition-colors"
                                            onClick={async () => {
                                                const ok = await confirm({
                                                    title: self
                                                        ? "Leave this organization?"
                                                        : `Remove ${member.name}?`,
                                                    description: self
                                                        ? "You will lose everything its teams gave you."
                                                        : "They come off every team here as well, and lose what those teams reached.",
                                                    confirmLabel: self ? "Leave" : "Remove",
                                                    danger: true
                                                });
                                                if (!ok) return;
                                                const done = await run(() =>
                                                    removeOrgMemberAction(orgId, member.userId)
                                                );
                                                // Leaving means this page is no
                                                // longer theirs to look at.
                                                if (done && self)
                                                    router.push("/account/organizations");
                                            }}
                                        >
                                            {self ? (
                                                <LogOut className="size-4 shrink-0" />
                                            ) : (
                                                <Trash2 className="size-4 shrink-0" />
                                            )}
                                        </button>
                                    )}
                                </div>
                            );
                        })
                    )}
                </CardBody>
            </Card>

            {invitations.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <MailQuestion className="size-4 shrink-0" /> Waiting to accept
                            <span className="text-muted-foreground text-xs font-normal">
                                {invitations.length}
                            </span>
                        </CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-1">
                        {invitations.map((invitation) => (
                            <div
                                key={invitation.id}
                                className="hover:bg-muted flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5"
                            >
                                <Avatar
                                    person={{ id: invitation.userId, name: invitation.name }}
                                    size={32}
                                />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm" title={invitation.name}>
                                        {invitation.name}
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
                                        className="text-muted-foreground hover:bg-danger/10 hover:text-danger rounded p-1 transition-colors"
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
                            </div>
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
                    full={full}
                    memberLimit={memberLimit}
                    onRun={run}
                />
            )}
            {confirmElement}
        </div>
    );
}

function InvitePerson({
    orgId,
    orgSlug,
    roles,
    options,
    full,
    memberLimit,
    onRun
}: {
    orgId: string;
    orgSlug: string;
    roles: RoleOption[];
    options: { value: string; label: string }[];
    full: boolean;
    memberLimit: number;
    onRun: (work: () => Promise<{ error?: string } | null>) => Promise<boolean>;
}) {
    const [identifier, setIdentifier] = useState("");
    // The first role is the one a picker should land on, and the list is ordered
    // with the seeded ones first - so this is Admin only if the organization has
    // deleted everything else, which it cannot.
    const [role, setRole] = useState(
        roles.find((entry) => entry.slug === "member")?.slug ?? roles[0]?.slug ?? "member"
    );

    const hint = roles.find((entry) => entry.slug === role)?.description ?? "";

    return (
        <Card>
            <CardHeader>
                <CardTitle>Invite somebody</CardTitle>
            </CardHeader>
            <CardBody>
                <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!identifier.trim()) return;
                        const done = await onRun(() =>
                            inviteOrgMemberAction(orgId, identifier.trim(), role)
                        );
                        if (done) setIdentifier("");
                    }}
                >
                    <label className="text-muted-foreground flex min-w-48 flex-1 flex-col gap-1 text-xs">
                        Email or username
                        <Input
                            value={identifier}
                            placeholder="someone@example.com"
                            className="h-9"
                            disabled={full}
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
                </form>
            </CardBody>
        </Card>
    );
}
