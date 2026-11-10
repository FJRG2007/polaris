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
import { Avatar } from "@/components/avatar";
import { Shield, Trash2, UserPlus, Users } from "lucide-react";
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
    Select,
    Skeleton
} from "@polaris/ui";

/** The role menu's value for taking somebody off, as in the share dialog. */
const REMOVE = "__remove";

function roleOptions(t: NamespaceTranslator<"tasks">) {
    return core.SPACE_ROLES.map((role) => ({
        value: role,
        label: optionLabel(t, "spaceRole", role)
    }));
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

    const changeMemberRole = async (member: AccessMember, next: string) => {
        if (next === REMOVE) {
            await runAction(
                () =>
                    whole
                        ? actions.removeSpaceMemberAction(scopeId, member.userId)
                        : actions.removeFolderMemberAction(scopeId, member.userId),
                setError
            );
        } else {
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
        }
        await reload();
    };

    const changeTeamRole = async (teamId: string, next: string) => {
        if (!scopeId) return;
        if (next === REMOVE) {
            await runAction(
                () =>
                    whole
                        ? actions.revokeSpaceTeamAction(scopeId, teamId)
                        : actions.revokeFolderTeamAction(scopeId, teamId),
                setError
            );
        } else {
            await runAction(
                () =>
                    whole
                        ? actions.grantSpaceTeamAction(scopeId, teamId, next as core.SpaceRole)
                        : actions.grantFolderTeamAction(scopeId, teamId, next as core.SpaceRole),
                setError
            );
        }
        await reloadTeams();
    };

    const invite = async () => {
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
    };

    const giveTeam = async () => {
        if (!scopeId || !teamPick) return;
        const result = await runAction(
            () =>
                whole
                    ? actions.grantSpaceTeamAction(scopeId, teamPick, teamRole)
                    : actions.grantFolderTeamAction(scopeId, teamPick, teamRole),
            setError
        );
        if (result?.error) {
            setError(result.error);
            return;
        }
        setTeamPick("");
        await reloadTeams();
    };

    const teamsOffered = available.filter(
        (team) => !granted.some((grant) => grant.teamId === team.id)
    );

    return (
        <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle className="min-w-0 truncate" title={name || undefined}>
                        {name
                            ? t("access.title", { name })
                            : whole
                              ? t("access.titleSpace")
                              : t("access.titleFolder")}
                    </DialogTitle>
                    <DialogDescription>
                        {path && (
                            <span className="block truncate font-mono text-xs" title={path}>
                                {path}
                            </span>
                        )}
                        {/* Named before the reach, because somebody who came
                            here from a list has to read that they are about to
                            change something larger before they read what it
                            does. */}
                        {target?.asked && (
                            <span className="block">
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
                        )}
                        {reach}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex min-w-0 flex-col gap-5">
                    {error && (
                        <p
                            role="alert"
                            className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger-ink"
                        >
                            {error}
                        </p>
                    )}

                    {/* The one box: who to add, what they may do, and the button. */}
                    {canManage && !loading && (
                        <form
                            className="flex min-w-0 flex-col gap-2"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void invite();
                            }}
                        >
                            <label className="sr-only" htmlFor="task-access-add">
                                {t("access.identifier")}
                            </label>
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <Input
                                    id="task-access-add"
                                    className="min-w-48 flex-1"
                                    autoComplete="off"
                                    value={identifier}
                                    placeholder={t("access.identifier")}
                                    onChange={(event) => setIdentifier(event.target.value)}
                                />
                                <Select
                                    value={role}
                                    options={ROLE_OPTIONS}
                                    aria-label={t("access.role")}
                                    className="w-auto shrink-0"
                                    onValueChange={(next) => setRole(next as core.SpaceRole)}
                                />
                                <Button
                                    type="submit"
                                    className="shrink-0"
                                    disabled={!identifier.trim()}
                                    aria-disabled={!identifier.trim()}
                                >
                                    <UserPlus className="size-4 shrink-0" aria-hidden />
                                    {t("access.invite")}
                                </Button>
                            </div>
                            <p className="text-[12px] text-muted-foreground">
                                {optionLabel(t, "spaceRoleHint", role)}
                            </p>
                        </form>
                    )}

                    <section
                        className="flex min-w-0 flex-col gap-2"
                        aria-label={t("access.peopleWithAccess")}
                    >
                        <h3 className="truncate text-[13px] font-medium text-foreground">
                            {t("access.peopleWithAccess")}
                        </h3>
                        {loading ? (
                            <>
                                <Skeleton className="h-12 w-full" />
                                <Skeleton className="h-12 w-full" />
                            </>
                        ) : members.length === 0 ? (
                            <p className="px-1 text-[13px] text-muted-foreground">
                                {whole ? t("access.nobodySpace") : t("access.nobodyFolder")}
                            </p>
                        ) : (
                            <ul className="flex max-h-72 min-w-0 flex-col overflow-y-auto overscroll-contain">
                                {members.map((member) => {
                                    // The owner is not a grant and cannot be one:
                                    // taking the role off them would leave the
                                    // space with none.
                                    const fixed =
                                        member.inherited || member.role === "owner" || !canManage;
                                    const line = member.through
                                        ? t("access.through", { name: member.through })
                                        : member.contact;
                                    return (
                                        <PersonRow
                                            as="li"
                                            key={member.userId}
                                            personId={member.userId}
                                            className="flex min-h-14 min-w-0 items-center gap-3 px-1 py-1"
                                        >
                                            <Avatar
                                                person={{ id: member.userId, name: member.name }}
                                                size={32}
                                                status={false}
                                                lazy
                                            />
                                            <div className="min-w-0 flex-1">
                                                <p
                                                    className="truncate text-[13px] text-foreground"
                                                    title={member.name}
                                                >
                                                    <PersonName
                                                        id={member.userId}
                                                        name={member.name}
                                                    />
                                                </p>
                                                {line ? (
                                                    <p
                                                        className="truncate text-[12px] text-muted-foreground"
                                                        title={line}
                                                    >
                                                        {line}
                                                    </p>
                                                ) : null}
                                            </div>
                                            {fixed ? (
                                                <span className="shrink-0 text-[12px] text-muted-foreground">
                                                    {member.role === "owner"
                                                        ? t("access.owner")
                                                        : optionLabel(t, "spaceRole", member.role)}
                                                </span>
                                            ) : (
                                                <Select
                                                    value={member.role}
                                                    options={[
                                                        ...ROLE_OPTIONS,
                                                        {
                                                            value: REMOVE,
                                                            label: t("access.removeAccess")
                                                        }
                                                    ]}
                                                    aria-label={t("access.roleFor", {
                                                        name: member.name
                                                    })}
                                                    className="w-auto shrink-0"
                                                    onValueChange={(next) =>
                                                        void changeMemberRole(member, next)
                                                    }
                                                />
                                            )}
                                        </PersonRow>
                                    );
                                })}
                            </ul>
                        )}
                    </section>

                    {!loading && (granted.length > 0 || available.length > 0) && (
                        <section
                            className="flex min-w-0 flex-col gap-2"
                            aria-label={t("access.teams")}
                        >
                            <h3 className="text-[13px] font-medium text-foreground">
                                {t("access.teams")}
                            </h3>
                            {granted.length === 0 ? (
                                <p className="px-1 text-[13px] text-muted-foreground">
                                    {whole ? t("access.noTeamSpace") : t("access.noTeamFolder")}
                                </p>
                            ) : (
                                <ul className="flex min-w-0 flex-col">
                                    {granted.map((grant) => (
                                        <li
                                            key={grant.teamId}
                                            className="flex min-h-14 min-w-0 items-center gap-3 px-1 py-1"
                                        >
                                            <GroupFace icon={Users} />
                                            <p
                                                className="min-w-0 flex-1 truncate text-[13px] text-foreground"
                                                title={grant.teamName}
                                            >
                                                {grant.teamName}
                                            </p>
                                            {canManage ? (
                                                <Select
                                                    value={grant.role}
                                                    options={[
                                                        ...ROLE_OPTIONS,
                                                        {
                                                            value: REMOVE,
                                                            label: t("access.removeAccess")
                                                        }
                                                    ]}
                                                    aria-label={t("access.roleFor", {
                                                        name: grant.teamName
                                                    })}
                                                    className="w-auto shrink-0"
                                                    onValueChange={(next) =>
                                                        void changeTeamRole(grant.teamId, next)
                                                    }
                                                />
                                            ) : (
                                                <span className="shrink-0 text-[12px] text-muted-foreground">
                                                    {optionLabel(t, "spaceRole", grant.role)}
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}

                            {canManage && teamsOffered.length > 0 && (
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <Select
                                        value={teamPick}
                                        placeholder={t("access.chooseTeam")}
                                        aria-label={t("access.teamToAdd")}
                                        className="min-w-48 flex-1"
                                        options={teamsOffered.map((team) => ({
                                            value: team.id,
                                            label: team.name
                                        }))}
                                        onValueChange={setTeamPick}
                                    />
                                    <Select
                                        value={teamRole}
                                        options={ROLE_OPTIONS}
                                        aria-label={t("access.teamRole")}
                                        className="w-auto shrink-0"
                                        onValueChange={(next) =>
                                            setTeamRole(next as core.SpaceRole)
                                        }
                                    />
                                    <Button
                                        type="button"
                                        className="shrink-0"
                                        disabled={!teamPick}
                                        aria-disabled={!teamPick}
                                        onClick={() => void giveTeam()}
                                    >
                                        <UserPlus className="size-4 shrink-0" aria-hidden />
                                        {t("access.give")}
                                    </Button>
                                </div>
                            )}
                        </section>
                    )}

                    {!loading && scopeId ? (
                        <RoleGrants
                            subject={whole ? "task.space" : "task.folder"}
                            subjectId={scopeId}
                            canManage={canManage}
                            whole={whole}
                        />
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** A team's or a role's face: the same 32px disc a person's avatar takes, so
 *  every row of the dialog lines up. */
function GroupFace({ icon: Icon }: { icon: typeof Users }) {
    return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground-subtle">
            <Icon className="size-4 shrink-0" aria-hidden />
        </span>
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
        const answer = await listGrantsAction(subject, subjectId, "role");
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
        <section className="flex min-w-0 flex-col gap-2" aria-label={t("access.roles")}>
            <h3 className="text-[13px] font-medium text-foreground">{t("access.roles")}</h3>
            {grants.length === 0 ? (
                <p className="px-1 text-[13px] text-muted-foreground">
                    {whole ? t("access.noRoleSpace") : t("access.noRoleFolder")}
                </p>
            ) : (
                <ul className="flex min-w-0 flex-col">
                    {grants.map((grant) => (
                        <li
                            key={grant.id}
                            className="flex min-h-14 min-w-0 items-center gap-3 px-1 py-1"
                        >
                            <GroupFace icon={Shield} />
                            <div className="min-w-0 flex-1">
                                <p
                                    className="truncate text-[13px] text-foreground"
                                    title={grant.principalName}
                                >
                                    {grant.principalName}
                                </p>
                                {grant.orgName ? (
                                    <p
                                        className="truncate text-[12px] text-muted-foreground"
                                        title={grant.orgName}
                                    >
                                        {grant.orgName}
                                    </p>
                                ) : null}
                            </div>
                            <span className="shrink-0 text-[12px] text-muted-foreground">
                                {(core.SPACE_ROLES as readonly string[]).includes(grant.capability)
                                    ? optionLabel(t, "spaceRole", grant.capability)
                                    : grant.capability}
                            </span>
                            {canManage ? (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="shrink-0"
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
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </Button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}

            {canManage && offered.length > 0 ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Select
                        aria-label={t("access.whichRole")}
                        className="min-w-48 flex-1"
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
                        className="w-auto shrink-0"
                        value={role}
                        onValueChange={(next) => setRole(next as core.SpaceRole)}
                        options={core.SPACE_ROLES.map((one) => ({
                            value: one,
                            label: optionLabel(t, "spaceRole", one)
                        }))}
                    />
                    <Button
                        className="shrink-0"
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
                        <UserPlus className="size-4 shrink-0" aria-hidden />
                        {t("access.give")}
                    </Button>
                </div>
            ) : null}

            {error ? (
                <p role="alert" className="text-[12px] text-danger-ink">
                    {error}
                </p>
            ) : null}
        </section>
    );
}
