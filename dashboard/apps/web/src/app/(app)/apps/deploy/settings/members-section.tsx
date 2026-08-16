"use client";

/**
 * Members: who can reach this project, and as what.
 *
 * The owner is rendered in and marked, but is not a membership row and cannot be
 * removed - a list that does not show who owns the thing reads as if nobody does.
 * Everybody else is added by the email or username they already have here; there
 * is no invite flow, because an account has to exist before it can be given a
 * role on somebody's infrastructure.
 */

import { SettingsCard } from "../project-settings";
import { Crown, Loader2, UserPlus } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { useDisplayFormat } from "@/components/display-format";
import type { ProjectMemberView } from "@/lib/deploy-project-service";
import { Button, ConfirmDeleteDialog, Input, Select } from "@polaris/ui";
import {
    PROJECT_ROLES,
    PROJECT_ROLE_HINTS,
    PROJECT_ROLE_LABELS,
    type ProjectRole
} from "@polaris/core";
import {
    addProjectMemberAction,
    listProjectMembersAction,
    removeProjectMemberAction,
    setProjectMemberRoleAction
} from "../project-actions";

const ROLE_OPTIONS = PROJECT_ROLES.map((value) => ({ value, label: PROJECT_ROLE_LABELS[value] }));

export function MembersSection({ projectId }: { projectId: string }) {
    const display = useDisplayFormat();
    const [members, setMembers] = useState<ProjectMemberView[] | null>(null);
    const [canManage, setCanManage] = useState(false);
    const [identifier, setIdentifier] = useState("");
    const [role, setRole] = useState<ProjectRole>("developer");
    const [removing, setRemoving] = useState<ProjectMemberView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function load() {
        void listProjectMembersAction(projectId).then((result) => {
            if (result.error) {
                setError(result.error);
                setMembers([]);
                return;
            }
            setMembers(result.members ?? []);
            setCanManage(result.canManage ?? false);
        });
    }

    useEffect(load, [projectId]);

    function add() {
        if (!identifier.trim()) return;
        setError(null);
        startTransition(async () => {
            const result = await addProjectMemberAction({
                projectId,
                identifier: identifier.trim(),
                role
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            setIdentifier("");
            load();
        });
    }

    function changeRole(member: ProjectMemberView, next: ProjectRole) {
        setError(null);
        startTransition(async () => {
            const result = await setProjectMemberRoleAction({
                projectId,
                memberId: member.id,
                role: next
            });
            if (result.error) setError(result.error);
            load();
        });
    }

    function remove() {
        if (!removing) return;
        startTransition(async () => {
            const result = await removeProjectMemberAction({ projectId, memberId: removing.id });
            if (result.error) {
                setError(result.error);
                return;
            }
            setRemoving(null);
            load();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title="Members"
                description="A member reaches this project through the same paths its owner does, limited by their role."
            >
                {error && <p className="text-sm text-danger">{error}</p>}

                <div className="overflow-hidden rounded-md border border-border/60">
                    {members === null ? (
                        <div className="flex justify-center py-6 text-muted-foreground">
                            <Loader2 className="size-5 animate-spin" />
                        </div>
                    ) : (
                        members.map((member) => (
                            <div
                                key={member.id}
                                className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5 last:border-0"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                                        {member.name}
                                        {member.isOwner && (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                                                <Crown className="size-3" /> Owner
                                            </span>
                                        )}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {member.contact}
                                        {member.isOwner
                                            ? ""
                                            : ` - added ${display.date(member.createdAt)}`}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    <Select
                                        value={member.role}
                                        disabled={member.isOwner || !canManage || pending}
                                        onValueChange={(value) =>
                                            changeRole(member, value as ProjectRole)
                                        }
                                        options={ROLE_OPTIONS}
                                        className="h-8 w-36"
                                        aria-label={`Role for ${member.name}`}
                                    />
                                    {canManage && !member.isOwner && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setRemoving(member)}
                                        >
                                            Remove
                                        </Button>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <dl className="flex flex-col gap-1">
                    {PROJECT_ROLES.map((entry) => (
                        <div key={entry} className="flex gap-2 text-xs">
                            <dt className="w-20 shrink-0 font-medium">
                                {PROJECT_ROLE_LABELS[entry]}
                            </dt>
                            <dd className="text-muted-foreground">{PROJECT_ROLE_HINTS[entry]}</dd>
                        </div>
                    ))}
                </dl>
            </SettingsCard>

            {canManage && (
                <SettingsCard
                    title="Add a member"
                    description="They need an account on this Polaris already."
                >
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex min-w-48 flex-1 flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                Email or username
                            </span>
                            <Input
                                value={identifier}
                                onChange={(event) => setIdentifier(event.target.value)}
                                placeholder="someone@example.com"
                                onKeyDown={(event) => event.key === "Enter" && add()}
                            />
                        </label>
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">Role</span>
                            <Select
                                value={role}
                                onValueChange={(value) => setRole(value as ProjectRole)}
                                options={ROLE_OPTIONS}
                                className="w-36"
                                aria-label="Role"
                            />
                        </label>
                        <Button onClick={add} disabled={pending || !identifier.trim()}>
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <UserPlus className="size-4" />
                            )}
                            Add
                        </Button>
                    </div>
                </SettingsCard>
            )}

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => !open && setRemoving(null)}
                name={removing?.name ?? ""}
                kind="member"
                confirmLabel="Remove member"
                description="They lose access to this project. Nothing they deployed is affected."
                pending={pending}
                onConfirm={remove}
            />
        </div>
    );
}
