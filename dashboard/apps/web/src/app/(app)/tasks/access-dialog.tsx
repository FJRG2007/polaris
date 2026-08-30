"use client";

/**
 * Who can reach one thing.
 *
 * Grants live at two levels, and this is the one screen for both. A space is the
 * whole of somebody's work; a folder is the branch that makes nesting worth
 * having - a client gets their own folder and sees that folder, not the space it
 * happens to live in.
 *
 * The rest of the tree has no grants of its own, and the honest thing is to say
 * so rather than to draw a sharing screen per row that quietly writes somewhere
 * else. A list is reached through the folder it sits in, or through the space
 * when it sits in none; a sprint plans a folder's work and is reached the same
 * way. So a right-click on one of those opens this on the level that governs it,
 * with a line naming what was asked about and what is actually being changed.
 * Sharing a list and being surprised later about what else came with it is the
 * failure this is written to prevent.
 *
 * Grants made further up are listed too, greyed and read-only, because the
 * alternative is somebody reading an empty list and re-inviting a person who is
 * already here through the folder above.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Loader2, Trash2, UserPlus } from "lucide-react";
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

const ROLE_OPTIONS = core.SPACE_ROLES.map((role) => ({
    value: role,
    label: core.SPACE_ROLE_LABELS[role]
}));

/** Where the grants being edited actually live. */
export type AccessScope = { kind: "space"; id: string } | { kind: "folder"; id: string };

/** What the reader right-clicked, when that is not the scope itself. */
export interface AccessAsked {
    kind: "list" | "sprint";
    name: string;
}

export interface AccessTarget {
    readonly scope: AccessScope;
    readonly asked?: AccessAsked;
}

/** One person on the list, whichever level put them there. */
interface AccessMember {
    userId: string;
    name: string;
    contact: string;
    role: core.SpaceRole | "owner";
    /** Granted further up, so shown but not editable here. */
    inherited: boolean;
    /** The folder it came from, when it came from one. */
    through: string | null;
}

export function AccessDialog({ target, onClose }: { target: AccessTarget | null; onClose: () => void }) {
    const [name, setName] = useState("");
    const [path, setPath] = useState("");
    const [members, setMembers] = useState<AccessMember[]>([]);
    const [identifier, setIdentifier] = useState("");
    const [role, setRole] = useState<core.SpaceRole>("member");
    const [loading, setLoading] = useState(false);
    const [canManage, setCanManage] = useState(false);
    const [error, setError] = useState("");
    // Teams of the organization that owns the space around this. Both lists are
    // empty on a personal space, which is what hides the section.
    const [granted, setGranted] = useState<
        { teamId: string; teamName: string; role: core.SpaceRole }[]
    >([]);
    const [available, setAvailable] = useState<{ id: string; name: string }[]>([]);
    const [teamPick, setTeamPick] = useState("");
    const [teamRole, setTeamRole] = useState<core.SpaceRole>("member");

    const scope = target?.scope ?? null;
    // The two ids the effects depend on, as values rather than as an object that
    // is a new one on every render.
    const scopeKind = scope?.kind ?? "";
    const scopeId = scope?.id ?? "";

    const read = async (): Promise<{
        members: AccessMember[];
        name: string;
        path: string;
        canManage: boolean;
    } | null> => {
        if (!scopeId) return null;
        if (scopeKind === "space") {
            const result = await runAction(() => actions.listSpaceMembersAction(scopeId), setError);
            if (!result || result.error) return null;
            return {
                name: result.space?.name ?? "this space",
                path: "",
                canManage: result.canManage === true,
                members: (result.members ?? []).map((member) => ({
                    userId: member.userId,
                    name: member.name,
                    contact: member.contact,
                    role: member.role,
                    inherited: false,
                    through: null
                }))
            };
        }
        const result = await runAction(() => actions.listFolderMembersAction(scopeId), setError);
        if (!result || result.error) return null;
        return {
            name: result.folder?.name ?? "this folder",
            path: result.folder?.path.map((entry) => entry.name).join(" / ") ?? "",
            canManage: result.canManage === true,
            members: (result.members ?? []).map((member) => ({
                userId: member.userId,
                name: member.name,
                contact: member.contact,
                role: member.role,
                inherited: member.inherited,
                through: member.inherited ? member.folderName : null
            }))
        };
    };

    const readTeams = async () => {
        if (!scopeId) return { granted: [], available: [] };
        const result = await runAction(
            () =>
                scopeKind === "space"
                    ? actions.spaceTeamsAction(scopeId)
                    : actions.folderTeamsAction(scopeId),
            setError
        );
        return { granted: result?.granted ?? [], available: result?.available ?? [] };
    };

    useEffect(() => {
        if (!scopeId) {
            setMembers([]);
            setGranted([]);
            setAvailable([]);
            return;
        }
        let live = true;
        setLoading(true);
        setError("");
        void (async () => {
            const [detail, teams] = await Promise.all([read(), readTeams()]);
            if (!live) return;
            setLoading(false);
            setName(detail?.name ?? "");
            setPath(detail?.path ?? "");
            setCanManage(detail?.canManage === true);
            setMembers(detail?.members ?? []);
            setGranted(teams.granted);
            setAvailable(teams.available);
        })();
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scopeKind, scopeId]);

    const reload = async () => {
        const detail = await read();
        if (!detail) return;
        setMembers(detail.members);
        setCanManage(detail.canManage);
    };

    const reloadTeams = async () => {
        const teams = await readTeams();
        setGranted(teams.granted);
        setAvailable(teams.available);
    };

    const whole = scopeKind === "space";
    const reach = whole
        ? "People added here reach everything in this space."
        : "People added here reach this folder and everything inside it, and nothing else in the space.";

    return (
        <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Access to {name || (whole ? "this space" : "this folder")}</DialogTitle>
                    <DialogDescription>
                        {path && <span className="font-mono text-xs">{path}</span>}
                        {path && <br />}
                        {/* Named before the reach, because somebody who came
                            here from a list has to read that they are about to
                            change something larger before they read what it
                            does. */}
                        {target?.asked && (
                            <>
                                <span>
                                    {target.asked.kind === "sprint" ? "Sprint" : "List"}{" "}
                                    <strong className="font-medium">{target.asked.name}</strong> has no
                                    access of its own: it is reached through{" "}
                                    {whole ? "the space" : "the folder"} around it.
                                </span>
                                <br />
                            </>
                        )}
                        {reach}
                    </DialogDescription>
                </DialogHeader>

                {loading && (
                    <div className="flex h-24 items-center justify-center text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                    </div>
                )}

                {error && (
                    <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                        {error}
                    </p>
                )}

                {!loading && (
                    <ul className="flex flex-col gap-1">
                        {members.length === 0 && (
                            <li className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                                {whole
                                    ? "Nobody else is on this space yet."
                                    : "Nobody has been given this folder on its own yet."}
                            </li>
                        )}
                        {members.map((member) => {
                            // The owner is not a grant and cannot be one: taking
                            // the role off them would leave the space with none.
                            const fixed = member.inherited || member.role === "owner" || !canManage;
                            return (
                                <li
                                    key={member.userId}
                                    className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm" title={member.name}>{member.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {member.through ? `Through ${member.through}` : member.contact}
                                        </p>
                                    </div>
                                    {fixed ? (
                                        <span className="text-xs text-muted-foreground">
                                            {member.role === "owner"
                                                ? "Owner"
                                                : core.SPACE_ROLE_LABELS[member.role]}
                                        </span>
                                    ) : (
                                        <>
                                            <Select
                                                value={member.role}
                                                options={ROLE_OPTIONS}
                                                aria-label={`Role for ${member.name}`}
                                                className="h-8 w-28 text-xs"
                                                onValueChange={async (next) => {
                                                    await runAction(
                                                        () =>
                                                            whole
                                                                ? actions.setSpaceMemberRoleAction(
                                                                      scopeId,
                                                                      member.userId,
                                                                      next as core.SpaceRole
                                                                  )
                                                                : actions.setFolderMemberRoleAction(
                                                                      scopeId,
                                                                      member.userId,
                                                                      next as core.SpaceRole
                                                                  ),
                                                        setError
                                                    );
                                                    await reload();
                                                }}
                                            />
                                            <button
                                                type="button"
                                                aria-label={`Remove ${member.name}`}
                                                title="Remove"
                                                onClick={async () => {
                                                    await runAction(
                                                        () =>
                                                            whole
                                                                ? actions.removeSpaceMemberAction(
                                                                      scopeId,
                                                                      member.userId
                                                                  )
                                                                : actions.removeFolderMemberAction(
                                                                      scopeId,
                                                                      member.userId
                                                                  ),
                                                        setError
                                                    );
                                                    await reload();
                                                }}
                                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                                            >
                                                <Trash2 className="size-4 shrink-0" />
                                            </button>
                                        </>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}

                {canManage && !loading && (
                    <form
                        className="mt-2 flex flex-wrap items-end gap-2 border-t border-border pt-3"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            if (!scopeId || !identifier.trim()) return;
                            setError("");
                            const result = await runAction(
                                () =>
                                    whole
                                        ? actions.addSpaceMemberAction(scopeId, identifier.trim(), role)
                                        : actions.addFolderMemberAction(scopeId, identifier.trim(), role),
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
                        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                            Email or username
                            <Input
                                value={identifier}
                                placeholder="client@example.com"
                                onChange={(event) => setIdentifier(event.target.value)}
                                className="h-9"
                            />
                        </label>
                        <Select
                            value={role}
                            options={ROLE_OPTIONS}
                            aria-label="Role"
                            className="h-9 w-32"
                            onValueChange={(next) => setRole(next as core.SpaceRole)}
                        />
                        <Button type="submit" size="sm" disabled={!identifier.trim()}>
                            <UserPlus className="size-4 shrink-0" /> Invite
                        </Button>
                        <p className="w-full text-xs text-muted-foreground">
                            {core.SPACE_ROLE_HINTS[role]}
                        </p>
                    </form>
                )}

                {!loading && (granted.length > 0 || available.length > 0) && (
                    <div className="flex flex-col gap-2 border-t border-border pt-3">
                        <p className="text-xs font-medium">Teams</p>
                        {granted.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                {whole
                                    ? "No team has this space yet."
                                    : "No team has this folder on its own yet."}
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-1">
                                {granted.map((grant) => (
                                    <li
                                        key={grant.teamId}
                                        className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                                    >
                                        <p className="min-w-0 flex-1 truncate text-sm" title={grant.teamName}>
                                            {grant.teamName}
                                        </p>
                                        {canManage ? (
                                            <>
                                                <Select
                                                    value={grant.role}
                                                    options={ROLE_OPTIONS}
                                                    aria-label={`Role for ${grant.teamName}`}
                                                    className="h-8 w-28 text-xs"
                                                    onValueChange={async (next) => {
                                                        if (!scopeId) return;
                                                        await runAction(
                                                            () =>
                                                                whole
                                                                    ? actions.grantSpaceTeamAction(
                                                                          scopeId,
                                                                          grant.teamId,
                                                                          next as core.SpaceRole
                                                                      )
                                                                    : actions.grantFolderTeamAction(
                                                                          scopeId,
                                                                          grant.teamId,
                                                                          next as core.SpaceRole
                                                                      ),
                                                            setError
                                                        );
                                                        await reloadTeams();
                                                    }}
                                                />
                                                <button
                                                    type="button"
                                                    aria-label={`Remove ${grant.teamName}`}
                                                    title="Remove"
                                                    onClick={async () => {
                                                        if (!scopeId) return;
                                                        await runAction(
                                                            () =>
                                                                whole
                                                                    ? actions.revokeSpaceTeamAction(
                                                                          scopeId,
                                                                          grant.teamId
                                                                      )
                                                                    : actions.revokeFolderTeamAction(
                                                                          scopeId,
                                                                          grant.teamId
                                                                      ),
                                                            setError
                                                        );
                                                        await reloadTeams();
                                                    }}
                                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                                                >
                                                    <Trash2 className="size-4 shrink-0" />
                                                </button>
                                            </>
                                        ) : (
                                            <span className="text-xs text-muted-foreground">
                                                {core.SPACE_ROLE_LABELS[grant.role]}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}

                        {canManage &&
                            available.some((team) => !granted.some((grant) => grant.teamId === team.id)) && (
                                <div className="flex flex-wrap items-end gap-2">
                                    <Select
                                        value={teamPick}
                                        placeholder="Choose a team"
                                        aria-label="Team to add"
                                        className="h-9 min-w-48 flex-1"
                                        options={available
                                            .filter(
                                                (team) => !granted.some((grant) => grant.teamId === team.id)
                                            )
                                            .map((team) => ({ value: team.id, label: team.name }))}
                                        onValueChange={setTeamPick}
                                    />
                                    <Select
                                        value={teamRole}
                                        options={ROLE_OPTIONS}
                                        aria-label="Role for the team"
                                        className="h-9 w-32"
                                        onValueChange={(next) => setTeamRole(next as core.SpaceRole)}
                                    />
                                    <Button
                                        type="button"
                                        size="sm"
                                        disabled={!teamPick}
                                        onClick={async () => {
                                            if (!scopeId || !teamPick) return;
                                            const result = await runAction(
                                                () =>
                                                    whole
                                                        ? actions.grantSpaceTeamAction(
                                                              scopeId,
                                                              teamPick,
                                                              teamRole
                                                          )
                                                        : actions.grantFolderTeamAction(
                                                              scopeId,
                                                              teamPick,
                                                              teamRole
                                                          ),
                                                setError
                                            );
                                            if (result?.error) {
                                                setError(result.error);
                                                return;
                                            }
                                            setTeamPick("");
                                            await reloadTeams();
                                        }}
                                    >
                                        <UserPlus className="size-4 shrink-0" /> Give access
                                    </Button>
                                </div>
                            )}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
