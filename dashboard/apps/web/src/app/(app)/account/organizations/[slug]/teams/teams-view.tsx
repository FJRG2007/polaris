"use client";

/**
 * The list of teams, and the dialog that starts one.
 *
 * A row says what the team costs to understand: how many people, and how much it
 * reaches. Opening one is the panel, which is where the roster and the grants
 * actually live - most visits open no team at all, so none of that is fetched
 * until one is.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { TeamPanel } from "./team-panel";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import type { TeamView } from "@/lib/orgs/org-service";
import { useConfirm } from "@/components/confirm-dialog";
import { createTeamAction, deleteTeamAction } from "@/app/(app)/account/organizations/actions";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Textarea
} from "@polaris/ui";

export function TeamsView({
    orgId,
    orgName,
    teams,
    currentUserId,
    canManage,
    teamLimit
}: {
    orgId: string;
    orgName: string;
    teams: TeamView[];
    currentUserId: string;
    canManage: boolean;
    teamLimit: number;
}) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [open, setOpen] = useState<TeamView | null>(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState("");

    const full = teamLimit > 0 && teams.length >= teamLimit;

    return (
        <div className="flex flex-col gap-4">
            {error && (
                <p
                    role="alert"
                    className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm"
                >
                    {error}
                </p>
            )}

            <Card>
                <CardHeader className="flex-row items-center justify-between">
                    <CardTitle>
                        Teams
                        <span className="text-muted-foreground ml-2 text-xs font-normal">
                            {teams.length}
                            {teamLimit > 0 ? ` of ${teamLimit}` : ""}
                        </span>
                    </CardTitle>
                    {canManage && (
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={full}
                            onClick={() => setCreating(true)}
                        >
                            <Plus className="size-4 shrink-0" /> New team
                        </Button>
                    )}
                </CardHeader>
                <CardBody className="p-0">
                    {/* A table, as the account list under Administration draws
                        one: how many people are on a team and what it reaches
                        are read down a column, and a stack of cards makes each
                        of those a search rather than a glance. */}
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-surface/60 text-muted-foreground text-left text-xs">
                                <tr>
                                    <th className="px-3 py-2 font-medium">Team</th>
                                    <th className="px-3 py-2 font-medium">People</th>
                                    <th className="px-3 py-2 font-medium">Reaches</th>
                                    <th className="w-10 px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {teams.length === 0 ? (
                                    <tr>
                                        <td
                                            colSpan={4}
                                            className="text-muted-foreground px-3 py-8 text-center"
                                        >
                                            A team is what a space is given to. Nothing here reaches
                                            any work yet.
                                        </td>
                                    </tr>
                                ) : (
                                    teams.map((team) => (
                                        <tr
                                            key={team.id}
                                            className="border-border hover:bg-muted border-t"
                                        >
                                            <td className="px-3 py-2">
                                                <button
                                                    type="button"
                                                    className="min-w-0 text-left"
                                                    onClick={() => setOpen(team)}
                                                >
                                                    <span className="flex min-w-0 flex-col leading-tight">
                                                        <span
                                                            className="truncate text-sm"
                                                            title={team.name}
                                                        >
                                                            {team.name}
                                                        </span>
                                                        <span className="text-muted-foreground truncate text-xs">
                                                            @{team.slug}
                                                        </span>
                                                    </span>
                                                </button>
                                            </td>
                                            <td className="text-muted-foreground whitespace-nowrap px-3 py-2 text-xs tabular-nums">
                                                {team.memberCount}
                                            </td>
                                            <td className="text-muted-foreground whitespace-nowrap px-3 py-2 text-xs">
                                                {team.spaceCount + team.folderCount === 0
                                                    ? "None yet"
                                                    : `${team.spaceCount + team.folderCount} grant${
                                                          team.spaceCount + team.folderCount === 1
                                                              ? ""
                                                              : "s"
                                                      }`}
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                                {canManage && (
                                                    <button
                                                        type="button"
                                                        aria-label={`Delete ${team.name}`}
                                                        title="Delete"
                                                        className="text-muted-foreground hover:bg-danger-soft hover:text-danger rounded p-1 transition-colors"
                                                        onClick={async () => {
                                                            const ok = await confirm({
                                                                title: `Delete ${team.name}?`,
                                                                description:
                                                                    "Everybody on it loses whatever this team reached. The work itself is untouched.",
                                                                confirmLabel: "Delete",
                                                                danger: true
                                                            });
                                                            if (!ok) return;
                                                            const result = await runAction(
                                                                () => deleteTeamAction(team.id),
                                                                setError
                                                            );
                                                            if (result && !result.error)
                                                                router.refresh();
                                                        }}
                                                    >
                                                        <Trash2 className="size-4 shrink-0" />
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                    {full && (
                        <p className="text-muted-foreground text-xs">
                            This Polaris allows {teamLimit} teams per organization.
                        </p>
                    )}
                </CardBody>
            </Card>

            <NewTeamDialog
                orgId={orgId}
                open={creating}
                onOpenChange={setCreating}
                onCreated={() => router.refresh()}
            />

            <TeamPanel
                team={open}
                orgName={orgName}
                canAdmin={canManage}
                currentUserId={currentUserId}
                onClose={() => setOpen(null)}
            />
            {confirmElement}
        </div>
    );
}

function NewTeamDialog({
    orgId,
    open,
    onOpenChange,
    onCreated
}: {
    orgId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
}) {
    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [slugTouched, setSlugTouched] = useState(false);
    const [description, setDescription] = useState("");
    const [error, setError] = useState("");

    const parsed = core.teamSchema.safeParse({ name, slug, description });

    const reset = () => {
        setName("");
        setSlug("");
        setSlugTouched(false);
        setDescription("");
        setError("");
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) reset();
            }}
        >
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>New team</DialogTitle>
                    <DialogDescription>
                        Give it people, then give it a space in Tasks. Everybody on it reaches that
                        space.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!parsed.success) return;
                        setError("");
                        const result = await runAction(
                            () => createTeamAction(orgId, parsed.data),
                            setError
                        );
                        if (!result || result.error) {
                            if (result?.error) setError(result.error);
                            return;
                        }
                        onOpenChange(false);
                        reset();
                        onCreated();
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
                        <p
                            role="alert"
                            className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm"
                        >
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!parsed.success}>
                            Create
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
