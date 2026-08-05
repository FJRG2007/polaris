"use client";

/**
 * One organization, in the order somebody actually works through it: who is on
 * it, how they are grouped, and - last, and only for its owner - the settings
 * that change or end it.
 *
 * The roster and the teams answer each other. A person's row names the teams
 * they are on, and a team's panel names what it reaches, so "why can this person
 * see that space" is always one click from wherever the question came up.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { TeamPanel } from "./team-panel";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useConfirm } from "@/components/confirm-dialog";
import { Building2, LogOut, Plus, Trash2, UserPlus, Users } from "lucide-react";
import type { OrgDetail, OrgMemberView, TeamView } from "@/lib/orgs/org-service";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Textarea
} from "@polaris/ui";
import {
    addOrgMemberAction,
    changeOrgSlugAction,
    createTeamAction,
    deleteOrgAction,
    deleteTeamAction,
    removeOrgMemberAction,
    setOrgMemberRoleAction,
    transferOrgAction,
    updateOrgAction
} from "../actions";

const ROLE_OPTIONS = core.ORG_ROLES.map((role) => ({ value: role, label: core.ORG_ROLE_LABELS[role] }));

export function OrganizationView({
    org,
    role,
    currentUserId,
    members,
    teams,
    impact,
    memberLimit,
    teamLimit
}: {
    org: OrgDetail;
    role: core.OrgAccess;
    currentUserId: string;
    members: OrgMemberView[];
    teams: TeamView[];
    impact: { spaces: number; tasks: number };
    memberLimit: number;
    teamLimit: number;
}) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [error, setError] = useState("");
    const [openTeam, setOpenTeam] = useState<TeamView | null>(null);

    const canAdmin = core.orgRoleAtLeast(role, "admin");
    const isOwner = role === "owner";

    // Roster and settings both write; a refresh is what puts the server's answer
    // back on screen, since every list here is rendered from it.
    const after = async (run: () => Promise<{ error?: string } | null>) => {
        setError("");
        const result = await run();
        if (result?.error) {
            setError(result.error);
            return false;
        }
        router.refresh();
        return true;
    };

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div className="flex items-start gap-3">
                <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md">
                    <Building2 className="text-muted-foreground size-5 shrink-0" />
                </span>
                <div className="min-w-0 flex-1">
                    <h1 className="flex items-center gap-2 text-lg font-semibold">
                        <span className="truncate" title={org.name}>{org.name}</span>
                        <Badge variant={isOwner ? "primary" : "neutral"}>
                            {isOwner ? "Owner" : core.ORG_ROLE_LABELS[role]}
                        </Badge>
                    </h1>
                    <p className="text-muted-foreground truncate text-sm">
                        @{org.slug}
                        {org.description ? ` - ${org.description}` : ""}
                    </p>
                </div>
            </div>

            {error && (
                <p role="alert" className="bg-danger/10 text-danger rounded-md px-3 py-2 text-sm">
                    {error}
                </p>
            )}

            <Roster
                members={members}
                canAdmin={canAdmin}
                currentUserId={currentUserId}
                orgId={org.id}
                memberLimit={memberLimit}
                onRun={after}
                confirm={confirm}
                router={router}
            />

            <Teams
                orgId={org.id}
                teams={teams}
                canAdmin={canAdmin}
                teamLimit={teamLimit}
                onOpen={setOpenTeam}
                onRun={after}
                confirm={confirm}
            />

            {isOwner && (
                <OwnerSettings
                    org={org}
                    members={members}
                    impact={impact}
                    onRun={after}
                    confirm={confirm}
                    router={router}
                />
            )}

            <TeamPanel
                team={openTeam}
                orgName={org.name}
                canAdmin={canAdmin}
                currentUserId={currentUserId}
                onClose={() => setOpenTeam(null)}
            />
            {confirmElement}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

type Runner = (run: () => Promise<{ error?: string } | null>) => Promise<boolean>;
type Confirm = ReturnType<typeof useConfirm>[0];

function Roster({
    orgId,
    members,
    canAdmin,
    currentUserId,
    memberLimit,
    onRun,
    confirm,
    router
}: {
    orgId: string;
    members: OrgMemberView[];
    canAdmin: boolean;
    currentUserId: string;
    memberLimit: number;
    onRun: Runner;
    confirm: Confirm;
    router: ReturnType<typeof useRouter>;
}) {
    const [identifier, setIdentifier] = useState("");
    const [role, setRole] = useState<core.OrgRole>("member");
    const [error, setError] = useState("");

    const full = memberLimit > 0 && members.length >= memberLimit;

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                    <Users className="size-4 shrink-0" /> People
                    <span className="text-muted-foreground text-xs font-normal">
                        {members.length}
                        {memberLimit > 0 ? ` of ${memberLimit}` : ""}
                    </span>
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-1">
                {members.map((member) => {
                    const self = member.userId === currentUserId;
                    return (
                        <div
                            key={member.userId}
                            className="hover:bg-muted flex items-center gap-3 rounded-md px-2 py-1.5"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm">
                                    {member.name}
                                    {self ? <span className="text-muted-foreground"> (you)</span> : null}
                                </p>
                                <p className="text-muted-foreground truncate text-xs">
                                    {member.teams.length > 0 ? member.teams.join(", ") : member.email}
                                </p>
                            </div>
                            {member.role === "owner" || !canAdmin ? (
                                <span className="text-muted-foreground text-xs">
                                    {member.role === "owner" ? "Owner" : core.ORG_ROLE_LABELS[member.role]}
                                </span>
                            ) : (
                                <Select
                                    value={member.role}
                                    options={ROLE_OPTIONS}
                                    aria-label={`Role for ${member.name}`}
                                    className="h-8 w-28 text-xs"
                                    onValueChange={(next) =>
                                        void onRun(() =>
                                            setOrgMemberRoleAction(orgId, member.userId, next as core.OrgRole)
                                        )
                                    }
                                />
                            )}
                            {member.role !== "owner" && (canAdmin || self) && (
                                <button
                                    type="button"
                                    aria-label={self ? "Leave this organization" : `Remove ${member.name}`}
                                    title={self ? "Leave" : "Remove"}
                                    className="text-muted-foreground hover:bg-danger/10 hover:text-danger rounded p-1 transition-colors"
                                    onClick={async () => {
                                        const ok = await confirm({
                                            title: self ? "Leave this organization?" : `Remove ${member.name}?`,
                                            description: self
                                                ? "You will lose everything its teams gave you."
                                                : "They come off every team here as well, and lose what those teams reached.",
                                            confirmLabel: self ? "Leave" : "Remove",
                                            danger: true
                                        });
                                        if (!ok) return;
                                        const done = await onRun(() => removeOrgMemberAction(orgId, member.userId));
                                        // Leaving means this page is no longer
                                        // theirs to look at.
                                        if (done && self) router.push("/account/organizations");
                                    }}
                                >
                                    {self ? <LogOut className="size-4 shrink-0" /> : <Trash2 className="size-4 shrink-0" />}
                                </button>
                            )}
                        </div>
                    );
                })}

                {canAdmin && (
                    <form
                        className="border-border mt-2 flex flex-wrap items-end gap-2 border-t pt-3"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            if (!identifier.trim()) return;
                            setError("");
                            const done = await onRun(() => addOrgMemberAction(orgId, identifier.trim(), role));
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
                            options={ROLE_OPTIONS}
                            aria-label="Role"
                            className="h-9 w-32"
                            onValueChange={(next) => setRole(next as core.OrgRole)}
                        />
                        <Button type="submit" size="sm" disabled={!identifier.trim() || full}>
                            <UserPlus className="size-4 shrink-0" /> Add
                        </Button>
                        <p className="text-muted-foreground w-full text-xs">
                            {full
                                ? `This Polaris allows ${memberLimit} members per organization.`
                                : core.ORG_ROLE_HINTS[role]}
                        </p>
                        {error && (
                            <p role="alert" className="text-danger w-full text-xs">
                                {error}
                            </p>
                        )}
                    </form>
                )}
            </CardBody>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

function Teams({
    orgId,
    teams,
    canAdmin,
    teamLimit,
    onOpen,
    onRun,
    confirm
}: {
    orgId: string;
    teams: TeamView[];
    canAdmin: boolean;
    teamLimit: number;
    onOpen: (team: TeamView) => void;
    onRun: Runner;
    confirm: Confirm;
}) {
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [slugTouched, setSlugTouched] = useState(false);
    const [description, setDescription] = useState("");
    const [error, setError] = useState("");

    const parsed = core.teamSchema.safeParse({ name, slug, description });
    const full = teamLimit > 0 && teams.length >= teamLimit;

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between">
                <CardTitle>
                    Teams
                    <span className="text-muted-foreground ml-2 text-xs font-normal">
                        {teams.length}
                        {teamLimit > 0 ? ` of ${teamLimit}` : ""}
                    </span>
                </CardTitle>
                {canAdmin && (
                    <Button size="sm" variant="secondary" disabled={full} onClick={() => setCreating(true)}>
                        <Plus className="size-4 shrink-0" /> New team
                    </Button>
                )}
            </CardHeader>
            <CardBody className="flex flex-col gap-1">
                {teams.length === 0 ? (
                    <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
                        A team is what a space is given to. Nothing here reaches any work yet.
                    </p>
                ) : (
                    teams.map((team) => (
                        <div key={team.id} className="hover:bg-muted flex items-center gap-3 rounded-md px-2 py-1.5">
                            <button
                                type="button"
                                className="min-w-0 flex-1 text-left"
                                onClick={() => onOpen(team)}
                            >
                                <p className="truncate text-sm" title={team.name}>{team.name}</p>
                                <p className="text-muted-foreground truncate text-xs">
                                    @{team.slug} - {team.memberCount} member{team.memberCount === 1 ? "" : "s"},{" "}
                                    {team.spaceCount + team.folderCount === 0
                                        ? "no access yet"
                                        : `${team.spaceCount + team.folderCount} grant${
                                              team.spaceCount + team.folderCount === 1 ? "" : "s"
                                          }`}
                                </p>
                            </button>
                            {canAdmin && (
                                <button
                                    type="button"
                                    aria-label={`Delete ${team.name}`}
                                    title="Delete"
                                    className="text-muted-foreground hover:bg-danger/10 hover:text-danger rounded p-1 transition-colors"
                                    onClick={async () => {
                                        const ok = await confirm({
                                            title: `Delete ${team.name}?`,
                                            description:
                                                "Everybody on it loses whatever this team reached. The work itself is untouched.",
                                            confirmLabel: "Delete",
                                            danger: true
                                        });
                                        if (ok) await onRun(() => deleteTeamAction(team.id));
                                    }}
                                >
                                    <Trash2 className="size-4 shrink-0" />
                                </button>
                            )}
                        </div>
                    ))
                )}
                {full && (
                    <p className="text-muted-foreground text-xs">
                        This Polaris allows {teamLimit} teams per organization.
                    </p>
                )}
            </CardBody>

            <Dialog
                open={creating}
                onOpenChange={(open) => {
                    setCreating(open);
                    if (!open) {
                        setName("");
                        setSlug("");
                        setSlugTouched(false);
                        setDescription("");
                        setError("");
                    }
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>New team</DialogTitle>
                        <DialogDescription>
                            Give it people, then give it a space in Tasks. Everybody on it reaches that space.
                        </DialogDescription>
                    </DialogHeader>
                    <form
                        className="flex flex-col gap-3"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            if (!parsed.success) return;
                            setError("");
                            const result = await runAction(() => createTeamAction(orgId, parsed.data), setError);
                            if (!result || result.error) {
                                if (result?.error) setError(result.error);
                                return;
                            }
                            setCreating(false);
                            setName("");
                            setSlug("");
                            setSlugTouched(false);
                            setDescription("");
                            await onRun(async () => null);
                        }}
                    >
                        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                            Name
                            <Input
                                value={name}
                                autoFocus
                                placeholder="Design"
                                onChange={(event) => {
                                    setName(event.target.value);
                                    if (!slugTouched) setSlug(core.suggestSlug(event.target.value));
                                }}
                            />
                        </label>
                        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                            Handle
                            <Input
                                value={slug}
                                placeholder="design"
                                onChange={(event) => {
                                    setSlugTouched(true);
                                    setSlug(event.target.value);
                                }}
                            />
                        </label>
                        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                            Description
                            <Textarea
                                value={description}
                                rows={2}
                                placeholder="What this team works on"
                                onChange={(event) => setDescription(event.target.value)}
                            />
                        </label>
                        {error && (
                            <p role="alert" className="bg-danger/10 text-danger rounded-md px-3 py-2 text-sm">
                                {error}
                            </p>
                        )}
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={!parsed.success}>
                                Create
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Owner settings
// ---------------------------------------------------------------------------

function OwnerSettings({
    org,
    members,
    impact,
    onRun,
    confirm,
    router
}: {
    org: OrgDetail;
    members: OrgMemberView[];
    impact: { spaces: number; tasks: number };
    onRun: Runner;
    confirm: Confirm;
    router: ReturnType<typeof useRouter>;
}) {
    const [name, setName] = useState(org.name);
    const [description, setDescription] = useState(org.description);
    const [slug, setSlug] = useState(org.slug);
    const [error, setError] = useState("");

    const profileParsed = core.organizationProfileSchema.safeParse({ name, description });
    const profileChanged = name !== org.name || description !== org.description;
    const slugParsed = core.orgSlugField.safeParse(slug);
    const slugChanged = slug !== org.slug;

    // Only somebody already on the roster can be handed the organization, which
    // is also what makes this list what it is.
    const candidates = members.filter((member) => member.role !== "owner");

    return (
        <Card>
            <CardHeader>
                <CardTitle>Settings</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <form
                    className="flex flex-col gap-3"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!profileParsed.success) return;
                        await onRun(() => updateOrgAction(org.id, profileParsed.data));
                    }}
                >
                    <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                        Name
                        <Input value={name} onChange={(event) => setName(event.target.value)} />
                    </label>
                    <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                        Description
                        <Textarea
                            value={description}
                            rows={2}
                            onChange={(event) => setDescription(event.target.value)}
                        />
                    </label>
                    <div className="flex justify-end">
                        <Button type="submit" size="sm" disabled={!profileChanged || !profileParsed.success}>
                            Save
                        </Button>
                    </div>
                </form>

                <form
                    className="border-border flex flex-wrap items-end gap-2 border-t pt-4"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!slugParsed.success || !slugChanged) return;
                        const ok = await confirm({
                            title: "Change the handle?",
                            description: `Every link to /account/organizations/${org.slug} stops working. Anything anybody wrote down has to be updated.`,
                            confirmLabel: "Change it"
                        });
                        if (!ok) return;
                        setError("");
                        const result = await runAction(() => changeOrgSlugAction(org.id, slug), setError);
                        if (!result || result.error) {
                            if (result?.error) setError(result.error);
                            return;
                        }
                        router.replace(`/account/organizations/${result.slug}`);
                    }}
                >
                    <label className="text-muted-foreground flex min-w-48 flex-1 flex-col gap-1 text-xs">
                        Handle
                        <Input value={slug} className="h-9" onChange={(event) => setSlug(event.target.value)} />
                    </label>
                    <Button type="submit" size="sm" variant="secondary" disabled={!slugChanged || !slugParsed.success}>
                        Change
                    </Button>
                    <p className="text-muted-foreground w-full text-xs">
                        {slugChanged && !slugParsed.success
                            ? slugParsed.error.issues[0]?.message
                            : "Links already handed out will stop working."}
                    </p>
                </form>

                {candidates.length > 0 && (
                    <div className="border-border flex flex-wrap items-end gap-2 border-t pt-4">
                        <label className="text-muted-foreground flex min-w-48 flex-1 flex-col gap-1 text-xs">
                            Hand over to
                            <Select
                                value=""
                                className="h-9"
                                aria-label="New owner"
                                placeholder="Choose somebody"
                                options={candidates.map((member) => ({
                                    value: member.userId,
                                    label: member.name
                                }))}
                                onValueChange={async (userId) => {
                                    const person = candidates.find((member) => member.userId === userId);
                                    const ok = await confirm({
                                        title: `Hand ${org.name} to ${person?.name}?`,
                                        description:
                                            "They become the owner and you stay on as an admin. Only they can undo it.",
                                        confirmLabel: "Hand over"
                                    });
                                    if (ok) await onRun(() => transferOrgAction(org.id, userId));
                                }}
                            />
                        </label>
                    </div>
                )}

                <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-4">
                    <p className="text-muted-foreground text-xs">
                        Deleting takes {impact.spaces} space{impact.spaces === 1 ? "" : "s"} and{" "}
                        {impact.tasks} task{impact.tasks === 1 ? "" : "s"} with it.
                    </p>
                    <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                            const ok = await confirm({
                                title: `Delete ${org.name}?`,
                                description: `${impact.spaces} space${impact.spaces === 1 ? "" : "s"} and ${
                                    impact.tasks
                                } task${impact.tasks === 1 ? "" : "s"} are deleted with it. This cannot be undone.`,
                                confirmLabel: "Delete",
                                danger: true
                            });
                            if (!ok) return;
                            const done = await onRun(() => deleteOrgAction(org.id));
                            if (done) router.push("/account/organizations");
                        }}
                    >
                        <Trash2 className="size-4 shrink-0" /> Delete organization
                    </Button>
                </div>

                {error && (
                    <p role="alert" className="bg-danger/10 text-danger rounded-md px-3 py-2 text-sm">
                        {error}
                    </p>
                )}
            </CardBody>
        </Card>
    );
}
