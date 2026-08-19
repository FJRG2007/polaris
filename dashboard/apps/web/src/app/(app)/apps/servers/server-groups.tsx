"use client";

/**
 * Server groups: a name and the machines in it, nothing else.
 *
 * They live here rather than on the firewall page because a group is a fact about
 * your servers, not about your rules - the firewall is one consumer of it, and
 * putting the editor there would mean managing servers from two places.
 *
 * Membership saves as it is toggled, optimistically. There is nothing to get half
 * right: a checkbox is the whole edit, and a failure puts the tick back.
 */

import { useEffect, useState, useTransition } from "react";
import { Layers, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle, Checkbox, ConfirmDeleteDialog, Input } from "@polaris/ui";
import {
    createHostGroupAction,
    deleteHostGroupAction,
    listHostGroupsAction,
    renameHostGroupAction,
    setHostGroupMembersAction
} from "./actions";

interface Group {
    id: string;
    name: string;
    hostIds: string[];
}

export function ServerGroups({ servers }: { servers: readonly { id: string; name: string; kind: string }[] }) {
    const [groups, setGroups] = useState<Group[] | null>(null);
    const [creating, setCreating] = useState(false);
    const [draftName, setDraftName] = useState("");
    const [renaming, setRenaming] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<Group | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [, start] = useTransition();

    // Only enrolled machines can be grouped: the local row before anybody enrolls it
    // is built from detection and has no id a rule could be attached to.
    const eligible = servers.filter((server) => server.kind === "host");

    useEffect(() => {
        void listHostGroupsAction().then(setGroups);
    }, []);

    function reload() {
        void listHostGroupsAction().then(setGroups);
    }

    function create() {
        const name = draftName.trim();
        if (!name) return;
        setError(null);
        start(async () => {
            const result = await createHostGroupAction(name);
            if (result.error) {
                setError(result.error);
                return;
            }
            setDraftName("");
            setCreating(false);
            reload();
        });
    }

    function toggleMember(group: Group, hostId: string, member: boolean) {
        const nextIds = member ? [...group.hostIds, hostId] : group.hostIds.filter((id) => id !== hostId);
        const previous = groups;
        setGroups((current) =>
            (current ?? []).map((entry) => (entry.id === group.id ? { ...entry, hostIds: nextIds } : entry))
        );
        setError(null);
        start(async () => {
            const result = await setHostGroupMembersAction(group.id, nextIds);
            if (result.error) {
                setGroups(previous);
                setError(result.error);
            }
        });
    }

    return (
        <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                    <Layers className="size-4 text-muted-foreground" />
                    Server groups
                </CardTitle>
                {!creating ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(true)}>
                        <Plus className="size-4" /> New group
                    </Button>
                ) : null}
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                    Write a firewall rule once for a set of machines. Adding a server to a group brings it under the
                    group&apos;s rules straight away.
                </p>

                {creating ? (
                    <div className="flex gap-2">
                        <Input
                            autoFocus
                            value={draftName}
                            placeholder="e.g. Data center"
                            onChange={(event) => setDraftName(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    create();
                                }
                                if (event.key === "Escape") setCreating(false);
                            }}
                        />
                        <Button type="button" onClick={create} disabled={draftName.trim() === ""}>
                            Create
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            aria-label="Cancel"
                            title="Cancel"
                            onClick={() => setCreating(false)}
                        >
                            <X className="size-4" />
                        </Button>
                    </div>
                ) : null}

                {groups === null ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">Loading groups...</p>
                ) : groups.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                        No groups yet.
                    </p>
                ) : (
                    groups.map((group) => (
                        <div key={group.id} className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                                {renaming === group.id ? (
                                    <Input
                                        autoFocus
                                        defaultValue={group.name}
                                        className="h-8"
                                        onBlur={() => setRenaming(null)}
                                        onKeyDown={(event) => {
                                            if (event.key === "Escape") setRenaming(null);
                                            if (event.key !== "Enter") return;
                                            event.preventDefault();
                                            const name = event.currentTarget.value.trim();
                                            setRenaming(null);
                                            if (!name || name === group.name) return;
                                            start(async () => {
                                                await renameHostGroupAction(group.id, name);
                                                reload();
                                            });
                                        }}
                                    />
                                ) : (
                                    <div className="text-sm font-medium">{group.name}</div>
                                )}
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        aria-label={`Rename ${group.name}`}
                                        title="Rename"
                                        onClick={() => setRenaming(group.id)}
                                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <Pencil className="size-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={`Delete ${group.name}`}
                                        title="Delete"
                                        onClick={() => setConfirmDelete(group)}
                                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </div>
                            </div>
                            {eligible.length === 0 ? (
                                <p className="text-xs text-muted-foreground">Enroll a server to put one in here.</p>
                            ) : (
                                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                                    {eligible.map((server) => (
                                        <label key={server.id} className="flex items-center gap-2 text-xs">
                                            <Checkbox
                                                checked={group.hostIds.includes(server.id)}
                                                onChange={(event) =>
                                                    toggleMember(group, server.id, event.target.checked)
                                                }
                                            />
                                            {server.name}
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))
                )}

                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </CardBody>

            <ConfirmDeleteDialog
                open={confirmDelete !== null}
                onOpenChange={(open) => !open && setConfirmDelete(null)}
                name={confirmDelete?.name ?? ""}
                kind="server group"
                description="The servers themselves stay. Any firewall rules written for this group are deleted with it."
                onConfirm={() => {
                    const group = confirmDelete;
                    setConfirmDelete(null);
                    if (!group) return;
                    start(async () => {
                        const result = await deleteHostGroupAction(group.id);
                        if (result.error) setError(result.error);
                        reload();
                    });
                }}
            />
        </Card>
    );
}
