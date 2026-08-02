"use client";

/**
 * Who can reach one folder.
 *
 * This is the screen that makes nested folders worth having: a client gets their
 * own folder and sees that folder, not the space it happens to live in. Grants
 * made further up are listed too, greyed and read-only, because the alternative
 * is somebody reading an empty list and re-inviting a person who is already
 * here through the client above.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Loader2, Trash2, UserPlus } from "lucide-react";
import type { FolderDetail, FolderMemberView } from "@/lib/tasks/space-service";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Select } from "@polaris/ui";

const ROLE_OPTIONS = core.SPACE_ROLES.map((role) => ({ value: role, label: core.SPACE_ROLE_LABELS[role] }));

export function FolderAccessDialog({
    folderId,
    canManage,
    onClose
}: {
    folderId: string | null;
    canManage: boolean;
    onClose: () => void;
}) {
    const [folder, setFolder] = useState<FolderDetail | null>(null);
    const [members, setMembers] = useState<FolderMemberView[]>([]);
    const [identifier, setIdentifier] = useState("");
    const [role, setRole] = useState<core.SpaceRole>("member");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!folderId) {
            setFolder(null);
            setMembers([]);
            return;
        }
        let live = true;
        setLoading(true);
        setError("");
        void (async () => {
            const result = await runAction(() => actions.listFolderMembersAction(folderId), setError);
            if (!live) return;
            setLoading(false);
            if (result?.error) setError(result.error);
            setFolder(result?.folder ?? null);
            setMembers(result?.members ?? []);
        })();
        return () => {
            live = false;
        };
    }, [folderId]);

    const reload = async () => {
        if (!folderId) return;
        const result = await runAction(() => actions.listFolderMembersAction(folderId), setError);
        if (result?.members) setMembers(result.members);
    };

    const path = folder?.path.map((entry) => entry.name).join(" / ") ?? "";

    return (
        <Dialog open={folderId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Access to {folder?.name ?? "this folder"}</DialogTitle>
                    <DialogDescription>
                        {path && <span className="font-mono text-xs">{path}</span>}
                        {path && <br />}
                        People added here reach this folder and everything inside it, and nothing else in the space.
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
                                Nobody has been given this folder on its own yet.
                            </li>
                        )}
                        {members.map((member) => (
                            <li
                                key={`${member.folderId}:${member.userId}`}
                                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm">{member.name}</p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {member.inherited ? `Through ${member.folderName}` : member.email}
                                    </p>
                                </div>
                                {member.inherited || !canManage ? (
                                    <span className="text-xs text-muted-foreground">
                                        {core.SPACE_ROLE_LABELS[member.role]}
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
                                                        actions.setFolderMemberRoleAction(
                                                            member.folderId,
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
                                                        actions.removeFolderMemberAction(
                                                            member.folderId,
                                                            member.userId
                                                        ),
                                                    setError
                                                );
                                                await reload();
                                            }}
                                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                                        >
                                            <Trash2 className="size-4" />
                                        </button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                )}

                {canManage && !loading && (
                    <form
                        className="mt-2 flex flex-wrap items-end gap-2 border-t border-border pt-3"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            if (!folderId || !identifier.trim()) return;
                            setError("");
                            const result = await runAction(
                                () => actions.addFolderMemberAction(folderId, identifier.trim(), role),
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
                            <UserPlus className="size-4" /> Invite
                        </Button>
                        <p className="w-full text-xs text-muted-foreground">
                            {core.SPACE_ROLE_HINTS[role]}
                        </p>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
