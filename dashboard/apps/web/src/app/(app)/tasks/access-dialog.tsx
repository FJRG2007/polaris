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
import { useCallback, useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { optionLabel } from "./option-label";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { GrantView } from "@/lib/access/grants";
import { Loader2, Trash2, UserPlus } from "lucide-react";
import { PersonName, PersonRow } from "@/components/person-name";
import type { GrantCandidate } from "@/lib/access/sharing-service";
import { listGrantsAction, revokeShareAction, shareAction } from "@/app/(app)/access-actions";
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

function roleOptions(t: NamespaceTranslator<"tasks">) {
    return core.SPACE_ROLES.map((role) => ({ value: role, label: optionLabel(t, "spaceRole", role) }));
}

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

export function AccessDialog({
    target,
    onClose
}: {
    target: AccessTarget | null;
    onClose: () => void;
}) {
    const t = useTranslations("tasks");
    const ROLE_OPTIONS = roleOptions(t);
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
    const reach = whole ? t("access.reachSpace") : t("access.reachFolder");

    return (
        <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {name
                            ? t("access.title", { name })
                            : whole
                              ? t("access.titleSpace")
                              : t("access.titleFolder")}
                    </DialogTitle>
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
                                    {t.rich("access.inherited", {
                                        kind: target.asked.kind,
                                        scope: whole ? "space" : "folder",
                                        name: target.asked.name,
                                        strong: (chunks) => (
                                            <strong key="name" className="font-medium">
                                                {chunks}
                                            </strong>
                                        )
                                    })}
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
                    <p
                        role="alert"
                        className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                    >
                        {error}
                    </p>
                )}

                {!loading && (
                    <ul className="flex flex-col gap-1">
                        {members.length === 0 && (
                            <li className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                                {whole ? t("access.nobodySpace") : t("access.nobodyFolder")}
                            </li>
                        )}
                        {members.map((member) => {
                            // The owner is not a grant and cannot be one: taking
                            // the role off them would leave the space with none.
                            const fixed = member.inherited || member.role === "owner" || !canManage;
                            return (
                                <PersonRow
                                    as="li"
                                    key={member.userId}
                                    personId={member.userId}
                                    className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm" title={member.name}>
                                            <PersonName id={member.userId} name={member.name} />
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {member.through
                                                ? t("access.through", { name: member.through })
                                                : member.contact}
                                        </p>
                                    </div>
                                    {fixed ? (
                                        <span className="text-xs text-muted-foreground">
                                            {member.role === "owner"
                                                ? t("access.owner")
                                                : optionLabel(t, "spaceRole", member.role)}
                                        </span>
                                    ) : (
                                        <>
                                            <Select
                                                value={member.role}
                                                options={ROLE_OPTIONS}
                                                aria-label={t("access.roleFor", { name: member.name })}
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
                                                aria-label={t("pickers.remove", { name: member.name })}
                                                title={t("access.remove")}
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
                                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                                            >
                                                <Trash2 className="size-4 shrink-0" />
                                            </button>
                                        </>
                                    )}
                                </PersonRow>
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
                                        ? actions.addSpaceMemberAction(
                                              scopeId,
                                              identifier.trim(),
                                              role
                                          )
                                        : actions.addFolderMemberAction(
                                              scopeId,
                                              identifier.trim(),
                                              role
                                          ),
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
                            {t("access.identifier")}
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
                            aria-label={t("access.role")}
                            className="h-9 w-32"
                            onValueChange={(next) => setRole(next as core.SpaceRole)}
                        />
                        <Button type="submit" size="sm" disabled={!identifier.trim()}>
                            <UserPlus className="size-4 shrink-0" /> {t("access.invite")}
                        </Button>
                        <p className="w-full text-xs text-muted-foreground">
                            {optionLabel(t, "spaceRoleHint", role)}
                        </p>
                    </form>
                )}

                {!loading && (granted.length > 0 || available.length > 0) && (
                    <div className="flex flex-col gap-2 border-t border-border pt-3">
                        <p className="text-xs font-medium">{t("access.teams")}</p>
                        {granted.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                {whole
                                    ? t("access.noTeamSpace")
                                    : t("access.noTeamFolder")}
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-1">
                                {granted.map((grant) => (
                                    <li
                                        key={grant.teamId}
                                        className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                                    >
                                        <p
                                            className="min-w-0 flex-1 truncate text-sm"
                                            title={grant.teamName}
                                        >
                                            {grant.teamName}
                                        </p>
                                        {canManage ? (
                                            <>
                                                <Select
                                                    value={grant.role}
                                                    options={ROLE_OPTIONS}
                                                    aria-label={t("access.roleFor", { name: grant.teamName })}
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
                                                    aria-label={t("pickers.remove", { name: grant.teamName })}
                                                    title={t("access.remove")}
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
                                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                                                >
                                                    <Trash2 className="size-4 shrink-0" />
                                                </button>
                                            </>
                                        ) : (
                                            <span className="text-xs text-muted-foreground">
                                                {optionLabel(t, "spaceRole", grant.role)}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}

                        {canManage &&
                            available.some(
                                (team) => !granted.some((grant) => grant.teamId === team.id)
                            ) && (
                                <div className="flex flex-wrap items-end gap-2">
                                    <Select
                                        value={teamPick}
                                        placeholder={t("access.chooseTeam")}
                                        aria-label={t("access.teamToAdd")}
                                        className="h-9 min-w-48 flex-1"
                                        options={available
                                            .filter(
                                                (team) =>
                                                    !granted.some(
                                                        (grant) => grant.teamId === team.id
                                                    )
                                            )
                                            .map((team) => ({ value: team.id, label: team.name }))}
                                        onValueChange={setTeamPick}
                                    />
                                    <Select
                                        value={teamRole}
                                        options={ROLE_OPTIONS}
                                        aria-label={t("access.teamRole")}
                                        className="h-9 w-32"
                                        onValueChange={(next) =>
                                            setTeamRole(next as core.SpaceRole)
                                        }
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
                                        <UserPlus className="size-4 shrink-0" /> {t("access.give")}
                                    </Button>
                                </div>
                            )}
                    </div>
                )}

                {!loading && scopeId ? (
                    <RoleGrants
                        subject={whole ? "task.space" : "task.folder"}
                        subjectId={scopeId}
                        canManage={canManage}
                        whole={whole}
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

/**
 * The same access, given to a role rather than to a team.
 *
 * A team is who somebody works with and a role is what they are trusted with,
 * and organizations use both - "everybody who is support" is a sentence a team
 * cannot say. It sits under the teams rather than beside them because it is the
 * rarer of the two and answers the same question, and it draws nothing at all
 * where there is nothing to give: a personal space has no organization behind
 * it, and an empty section reads as something broken.
 *
 * The rows come from the general sharing endpoint rather than from Tasks' own
 * actions, which is also where they are stored - see `lib/access/grants.ts`.
 */
function RoleGrants({
    subject,
    subjectId,
    canManage,
    whole
}: {
    subject: core.GrantSubject;
    subjectId: string;
    canManage: boolean;
    whole: boolean;
}) {
    const t = useTranslations("tasks");
    const [grants, setGrants] = useState<GrantView[]>([]);
    const [roles, setRoles] = useState<GrantCandidate[]>([]);
    const [pick, setPick] = useState("");
    const [role, setRole] = useState<core.SpaceRole>("member");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async (): Promise<void> => {
        const answer = await listGrantsAction(subject, subjectId);
        setGrants((answer.grants ?? []).filter((one) => one.principalType === "role"));
        setRoles((answer.candidates ?? []).filter((one) => one.type === "role"));
    }, [subject, subjectId]);

    useEffect(() => {
        void load();
    }, [load]);

    const held = new Set(grants.map((grant) => grant.principalId));
    const offered = roles.filter((one) => !held.has(one.id));
    if (grants.length === 0 && offered.length === 0) return null;

    return (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
            <p className="text-xs font-medium">{t("access.roles")}</p>
            {grants.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    {whole
                        ? t("access.noRoleSpace")
                        : t("access.noRoleFolder")}
                </p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {grants.map((grant) => (
                        <li
                            key={grant.id}
                            className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                        >
                            <p
                                className="min-w-0 flex-1 truncate text-sm"
                                title={grant.principalName}
                            >
                                {grant.principalName}
                                {grant.orgName ? (
                                    <span className="text-muted-foreground">
                                        {" "}
                                        - {grant.orgName}
                                    </span>
                                ) : null}
                            </p>
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {(core.SPACE_ROLES as readonly string[]).includes(grant.capability)
                                    ? optionLabel(t, "spaceRole", grant.capability)
                                    : grant.capability}
                            </span>
                            {canManage ? (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={busy}
                                    aria-label={t("access.takeOff", { name: grant.principalName })}
                                    title={t("access.takeRoleOff")}
                                    onClick={async () => {
                                        setBusy(true);
                                        const answer = await revokeShareAction(
                                            subject,
                                            subjectId,
                                            grant.id
                                        );
                                        setBusy(false);
                                        if (answer.error) {
                                            setError(answer.error);
                                            return;
                                        }
                                        await load();
                                    }}
                                >
                                    <Trash2 className="size-4 shrink-0" />
                                </Button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}

            {canManage && offered.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        aria-label={t("access.whichRole")}
                        className="min-w-40 flex-1"
                        value={pick}
                        onValueChange={setPick}
                        placeholder={t("access.pickRole")}
                        options={offered.map((one) => ({
                            value: one.id,
                            label: one.orgName ? `${one.orgName} - ${one.name}` : one.name
                        }))}
                    />
                    <Select
                        aria-label={t("access.roleCapability")}
                        value={role}
                        onValueChange={(next) => setRole(next as core.SpaceRole)}
                        options={core.SPACE_ROLES.map((one) => ({
                            value: one,
                            label: optionLabel(t, "spaceRole", one)
                        }))}
                    />
                    <Button
                        size="sm"
                        disabled={busy || !pick}
                        aria-disabled={busy || !pick}
                        onClick={async () => {
                            setBusy(true);
                            const answer = await shareAction(subject, subjectId, {
                                principalType: "role",
                                principalId: pick,
                                capability: role
                            });
                            setBusy(false);
                            if (answer.error) {
                                setError(answer.error);
                                return;
                            }
                            setPick("");
                            await load();
                        }}
                    >
                        <UserPlus className="size-4 shrink-0" /> {t("access.give")}
                    </Button>
                </div>
            ) : null}

            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
