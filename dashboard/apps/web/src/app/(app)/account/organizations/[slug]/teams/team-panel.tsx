"use client";

/**
 * One team: who is on it and what it reaches.
 *
 * The second half is the answer to the question a roster cannot answer -
 * "what does joining this team actually give me" - so it is listed here rather
 * than left to be pieced together from each space's own access screen. It is
 * read-only on this side: a grant is made where the work is, by somebody who
 * administers that space, which is what stops an organization admin helping
 * themselves to a space they were never given.
 */

import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Loader2, Trash2, UserPlus } from "lucide-react";
import type { TeamGrantView, TeamMemberView, TeamView } from "@/lib/orgs/org-service";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import {
    addTeamMemberAction,
    removeTeamMemberAction,
    setTeamMemberRoleAction,
    teamDetailAction
} from "@/app/(app)/account/organizations/actions";

const ROLE_OPTIONS = core.TEAM_ROLES.map((role) => ({
    value: role,
    label: core.TEAM_ROLE_LABELS[role]
}));

export function TeamPanel({
    team,
    orgName,
    canAdmin,
    currentUserId,
    onClose
}: {
    team: TeamView | null;
    orgName: string;
    /** Whether the viewer administers the organization. A maintainer of this one
     *  team may also manage it, which only the server can say, so this is the
     *  first guess and the server's answer replaces it. */
    canAdmin: boolean;
    currentUserId: string;
    onClose: () => void;
}) {
    const [members, setMembers] = useState<TeamMemberView[]>([]);
    const [grants, setGrants] = useState<TeamGrantView[]>([]);
    const [canManage, setCanManage] = useState(canAdmin);
    const [loading, setLoading] = useState(false);
    const [identifier, setIdentifier] = useState("");
    const [role, setRole] = useState<core.TeamRole>("member");
    const [error, setError] = useState("");

    const teamId = team?.id ?? null;

    useEffect(() => {
        if (!teamId) {
            setMembers([]);
            setGrants([]);
            return;
        }
        let live = true;
        setLoading(true);
        setError("");
        void (async () => {
            const result = await runAction(() => teamDetailAction(teamId), setError);
            if (!live) return;
            setLoading(false);
            if (result?.error) setError(result.error);
            setMembers(result?.members ?? []);
            setGrants(result?.grants ?? []);
            setCanManage(result?.canManage ?? false);
        })();
        return () => {
            live = false;
        };
    }, [teamId]);

    const reload = async () => {
        if (!teamId) return;
        const result = await runAction(() => teamDetailAction(teamId), setError);
        if (result?.members) setMembers(result.members);
        if (result?.grants) setGrants(result.grants);
    };

    return (
        <Dialog open={team !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{team?.name ?? "Team"}</DialogTitle>
                    <DialogDescription>
                        {team?.description || `A team in ${orgName}.`} Everybody on it reaches
                        whatever it has been given.
                    </DialogDescription>
                </DialogHeader>

                {loading && (
                    <div className="text-muted-foreground flex h-20 items-center justify-center">
                        <Loader2 className="size-5 shrink-0 animate-spin" />
                    </div>
                )}

                {error && (
                    <p
                        role="alert"
                        className="bg-danger/10 text-danger rounded-md px-3 py-2 text-sm"
                    >
                        {error}
                    </p>
                )}

                {!loading && (
                    <>
                        <div className="flex flex-col gap-1">
                            {members.length === 0 ? (
                                <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-5 text-center text-sm">
                                    Nobody is on this team yet.
                                </p>
                            ) : (
                                members.map((member) => (
                                    <div
                                        key={member.userId}
                                        className="hover:bg-muted flex items-center gap-3 rounded-md px-2 py-1.5"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm">
                                                {member.name}
                                                {member.userId === currentUserId ? (
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
                                                {member.contact}
                                            </p>
                                        </div>
                                        {canManage ? (
                                            <Select
                                                value={member.role}
                                                options={ROLE_OPTIONS}
                                                aria-label={`Role for ${member.name}`}
                                                className="h-8 w-32 text-xs"
                                                onValueChange={async (next) => {
                                                    if (!teamId) return;
                                                    await runAction(
                                                        () =>
                                                            setTeamMemberRoleAction(
                                                                teamId,
                                                                member.userId,
                                                                next as core.TeamRole
                                                            ),
                                                        setError
                                                    );
                                                    await reload();
                                                }}
                                            />
                                        ) : (
                                            <span className="text-muted-foreground text-xs">
                                                {core.TEAM_ROLE_LABELS[member.role]}
                                            </span>
                                        )}
                                        {(canManage || member.userId === currentUserId) && (
                                            <button
                                                type="button"
                                                aria-label={
                                                    member.userId === currentUserId
                                                        ? "Leave this team"
                                                        : `Remove ${member.name}`
                                                }
                                                title={
                                                    member.userId === currentUserId
                                                        ? "Leave"
                                                        : "Remove"
                                                }
                                                className="text-muted-foreground hover:bg-danger/10 hover:text-danger rounded p-1 transition-colors"
                                                onClick={async () => {
                                                    if (!teamId) return;
                                                    await runAction(
                                                        () =>
                                                            removeTeamMemberAction(
                                                                teamId,
                                                                member.userId
                                                            ),
                                                        setError
                                                    );
                                                    await reload();
                                                }}
                                            >
                                                <Trash2 className="size-4 shrink-0" />
                                            </button>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>

                        {canManage && (
                            <form
                                className="border-border flex flex-wrap items-end gap-2 border-t pt-3"
                                onSubmit={async (event) => {
                                    event.preventDefault();
                                    if (!teamId || !identifier.trim()) return;
                                    setError("");
                                    const result = await runAction(
                                        () => addTeamMemberAction(teamId, identifier.trim(), role),
                                        setError
                                    );
                                    if (result?.error) {
                                        setError(result.error);
                                        return;
                                    }
                                    setIdentifier("");
                                    await reload();
                                }}
                            >
                                <label className="text-muted-foreground flex min-w-48 flex-1 flex-col gap-1 text-xs">
                                    Email or username
                                    <Input
                                        value={identifier}
                                        placeholder="someone@example.com"
                                        className="h-9"
                                        onChange={(event) => setIdentifier(event.target.value)}
                                    />
                                </label>
                                <Select
                                    value={role}
                                    options={ROLE_OPTIONS}
                                    aria-label="Role"
                                    className="h-9 w-36"
                                    onValueChange={(next) => setRole(next as core.TeamRole)}
                                />
                                <Button type="submit" size="sm" disabled={!identifier.trim()}>
                                    <UserPlus className="size-4 shrink-0" /> Add
                                </Button>
                                <p className="text-muted-foreground w-full text-xs">
                                    They have to be on the organization already.{" "}
                                    {core.TEAM_ROLE_HINTS[role]}
                                </p>
                            </form>
                        )}

                        <div className="border-border border-t pt-3">
                            <p className="mb-1 text-xs font-medium">What this team reaches</p>
                            {grants.length === 0 ? (
                                <p className="text-muted-foreground text-xs">
                                    Nothing yet. A space is given to a team from that space&apos;s
                                    own access settings in Tasks.
                                </p>
                            ) : (
                                <ul className="flex flex-col gap-1">
                                    {grants.map((grant) => (
                                        <li
                                            key={`${grant.spaceId}:${grant.folderId ?? "space"}`}
                                            className="flex items-center justify-between gap-2 text-sm"
                                        >
                                            <span className="min-w-0 truncate">
                                                {grant.spaceName}
                                                {grant.folderName ? (
                                                    <span className="text-muted-foreground">
                                                        {" "}
                                                        / {grant.folderName}
                                                    </span>
                                                ) : null}
                                            </span>
                                            <span className="text-muted-foreground shrink-0 text-xs">
                                                {core.SPACE_ROLE_LABELS[grant.role]}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
