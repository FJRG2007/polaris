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
import { mergeUnchanged } from "@/lib/structural-merge";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { Loader2, Trash2, UserPlus } from "lucide-react";
import { PersonName, PersonRow } from "@/components/person-name";
import { useTranslations } from "@/components/i18n/i18n-provider";
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


/** What is kept of a team between openings: who is on it and what it reaches. */
interface KeptTeam {
    members: TeamMemberView[];
    grants: TeamGrantView[];
}

const KEPT_MAX_AGE_MS = 24 * 3_600_000;

function teamKey(teamId: string): string {
    return `org-team:${teamId}`;
}

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
    const t = useTranslations("accountOrgs");
    const roleOptions = core.TEAM_ROLES.map((role) => ({ value: role, label: t(`teams.roles.${role}`) }));
    const [members, setMembers] = useState<TeamMemberView[]>([]);
    const [grants, setGrants] = useState<TeamGrantView[]>([]);
    const [canManage, setCanManage] = useState(canAdmin);
    const [loading, setLoading] = useState(false);
    /** Whether the server has answered for the team on screen. A kept roster is
     *  shown before that, but nothing on it can be changed: `canManage` still
     *  belongs to whichever team answered last. */
    const [heard, setHeard] = useState(false);
    const [identifier, setIdentifier] = useState("");
    const [role, setRole] = useState<core.TeamRole>("member");
    const [error, setError] = useState("");

    const teamId = team?.id ?? null;

    /** Take a fresh answer, touching only what moved, and keep it for the next
     *  opening. Whether the viewer may manage is not kept: that is the server's
     *  to say each time, never a remembered yes. */
    const settle = (id: string, members: TeamMemberView[], grants: TeamGrantView[]) => {
        setMembers((current) => mergeUnchanged(current, members));
        setGrants((current) => mergeUnchanged(current, grants));
        writeSnapshot<KeptTeam>(teamKey(id), { members, grants });
    };

    useEffect(() => {
        if (!teamId) {
            setMembers([]);
            setGrants([]);
            return;
        }
        let live = true;
        // The roster this browser last saw is shown at once; the spinner is only
        // for a team with nothing kept.
        const kept = readSnapshot<KeptTeam>(teamKey(teamId), KEPT_MAX_AGE_MS)?.value ?? null;
        setMembers(kept?.members ?? []);
        setGrants(kept?.grants ?? []);
        setLoading(kept === null);
        setHeard(false);
        setError("");
        void (async () => {
            const result = await runAction(() => teamDetailAction(teamId), setError);
            if (!live) return;
            setLoading(false);
            if (result?.error) setError(result.error);
            // A failed read shows an empty roster beside its error, as it did
            // before anything was kept, rather than the kept one as if current.
            if (result?.members && result.grants) settle(teamId, result.members, result.grants);
            else {
                setMembers([]);
                setGrants([]);
            }
            setCanManage(result?.canManage ?? false);
            setHeard(true);
        })();
        return () => {
            live = false;
        };
        // `settle` only sets state and writes the kept copy.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [teamId]);

    /** What the viewer may do here, once the server has said so for this team. */
    const manage = heard && canManage;

    const reload = async () => {
        if (!teamId) return;
        const result = await runAction(() => teamDetailAction(teamId), setError);
        if (result?.members && result.grants) settle(teamId, result.members, result.grants);
    };

    return (
        <Dialog open={team !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{team?.name ?? t("teams.panel.fallbackTitle")}</DialogTitle>
                    <DialogDescription>
                        {team?.description
                            ? t("teams.panel.description", { description: team.description })
                            : t("teams.panel.defaultDescription", { org: orgName })}
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
                        className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm"
                    >
                        {error}
                    </p>
                )}

                {!loading && (
                    <>
                        <div className="flex flex-col gap-1">
                            {members.length === 0 ? (
                                <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-5 text-center text-sm">
                                    {t("teams.panel.nobody")}
                                </p>
                            ) : (
                                members.map((member) => (
                                    <PersonRow
                                        key={member.userId}
                                        personId={member.userId}
                                        className="hover:bg-muted flex items-center gap-3 rounded-md px-2 py-1.5"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm">
                                                <PersonName id={member.userId} name={member.name}>
                                                    {member.userId === currentUserId ? (
                                                        <span className="text-muted-foreground">
                                                            {" "}
                                                            {t("form.you")}
                                                        </span>
                                                    ) : null}
                                                </PersonName>
                                            </p>
                                            <p
                                                className="text-muted-foreground truncate text-xs"
                                                title={member.contact}
                                            >
                                                {member.contact}
                                            </p>
                                        </div>
                                        {manage ? (
                                            <Select
                                                value={member.role}
                                                options={roleOptions}
                                                aria-label={t("form.roleFor", { name: member.name })}
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
                                                {t(`teams.roles.${member.role}`)}
                                            </span>
                                        )}
                                        {heard &&
                                            (canManage || member.userId === currentUserId) && (
                                                <button
                                                    type="button"
                                                    aria-label={
                                                        member.userId === currentUserId
                                                            ? t("teams.panel.leave")
                                                            : t("form.removeName", { name: member.name })
                                                    }
                                                    title={
                                                        member.userId === currentUserId
                                                            ? t("form.leave")
                                                            : t("form.remove")
                                                    }
                                                    className="text-muted-foreground hover:bg-danger-soft hover:text-danger rounded p-1 transition-colors"
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
                                    </PersonRow>
                                ))
                            )}
                        </div>

                        {manage && (
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
                                    {t("form.identifier")}
                                    <Input
                                        value={identifier}
                                        placeholder={t("form.identifierPlaceholder")}
                                        className="h-9"
                                        onChange={(event) => setIdentifier(event.target.value)}
                                    />
                                </label>
                                <Select
                                    value={role}
                                    options={roleOptions}
                                    aria-label={t("form.role")}
                                    className="h-9 w-36"
                                    onValueChange={(next) => setRole(next as core.TeamRole)}
                                />
                                <Button type="submit" size="sm" disabled={!identifier.trim()}>
                                    <UserPlus className="size-4 shrink-0" /> {t("teams.panel.add")}
                                </Button>
                                <p className="text-muted-foreground w-full text-xs">
                                    {t("teams.panel.addHint", { hint: t(`teams.roleHints.${role}`) })}
                                </p>
                            </form>
                        )}

                        <div className="border-border border-t pt-3">
                            <p className="mb-1 text-xs font-medium">{t("teams.panel.reaches")}</p>
                            {grants.length === 0 ? (
                                <p className="text-muted-foreground text-xs">
                                    {t("teams.panel.nothing")}
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
                                                {t(`teams.spaceRoles.${grant.role}`)}
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
