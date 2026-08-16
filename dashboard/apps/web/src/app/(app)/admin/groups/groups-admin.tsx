"use client";

/**
 * The groups directory.
 *
 * The same shape as the people directory next to it: a search over what is
 * already on the page, one row per group, and everything that changes a group
 * behind the row rather than on it. It used to be a create form pinned to a
 * third of the screen and a stack of cards, which meant a deployment with a
 * dozen groups was a page nobody could scan - every card carried its whole
 * membership, its add-a-member picker and its delete button whether or not
 * anybody was looking at it.
 *
 * Membership is the thing an operator actually comes here to change, so the row
 * shows who is in the group and opens on the dialog that changes it.
 */

import Fuse from "fuse.js";
import { useRouter } from "next/navigation";
import { Avatar, AvatarStack } from "@/components/avatar";
import { Plus, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import { useMemo, useState, useTransition, type FormEvent } from "react";
import {
    addGroupMemberAction,
    createGroupAction,
    deleteGroupAction,
    removeGroupMemberAction
} from "./actions";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    cn
} from "@polaris/ui";

export interface UserOption {
    id: string;
    name: string;
    email: string;
}
export interface GroupRow {
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    members: UserOption[];
}

export function GroupsAdmin({ groups, users }: { groups: GroupRow[]; users: UserOption[] }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [openId, setOpenId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<GroupRow | null>(null);

    // The group being managed is looked up rather than held: the dialog stays
    // open across a membership change, and holding the row would leave it
    // showing the membership from before the change it just made.
    const open = groups.find((group) => group.id === openId) ?? null;

    // Fuzzy rather than a substring: somebody looking for the operations group
    // types "ops", and somebody looking for the group a person is in types their
    // name half-remembered. Over the rows already on the page - a deployment's
    // groups are a short list, and asking the server for a substring would be
    // slower than reading it.
    const fuse = useMemo(
        () =>
            new Fuse(groups, {
                keys: ["name", "description", "members.name", "members.email"],
                threshold: 0.3,
                ignoreLocation: true
            }),
        [groups]
    );
    const shown = useMemo(() => {
        const needle = query.trim();
        if (!needle) return groups;
        return fuse.search(needle).map((hit) => hit.item);
    }, [fuse, groups, query]);

    function mutate(run: () => Promise<unknown>) {
        startTransition(async () => {
            await run();
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="pl-9"
                        placeholder="Search by group, description or member"
                        aria-label="Search groups"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                <Button onClick={() => setCreating(true)}>
                    <Plus className="size-4" />
                    New group
                </Button>
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">Group</th>
                            <th className="hidden px-3 py-2 font-medium sm:table-cell">Members</th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">People</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={3}
                                    className="px-3 py-8 text-center text-muted-foreground"
                                >
                                    {groups.length === 0
                                        ? "No groups yet."
                                        : "No group matches that."}
                                </td>
                            </tr>
                        ) : (
                            shown.map((group) => (
                                <tr
                                    key={group.id}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={`Open ${group.name}`}
                                    onClick={() => setOpenId(group.id)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            setOpenId(group.id);
                                        }
                                    }}
                                    className="cursor-pointer border-t border-border hover:bg-card-hover"
                                >
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-3">
                                            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                                <Users className="size-4" />
                                            </span>
                                            <div className="min-w-0">
                                                <p className="flex items-center gap-1.5 truncate font-medium">
                                                    {group.name}
                                                    {group.isSystem ? <Badge>system</Badge> : null}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    {group.description || "No description."}
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="hidden px-3 py-2 sm:table-cell">
                                        {group.members.length === 0 ? (
                                            <span className="text-xs text-muted-foreground">
                                                Nobody yet
                                            </span>
                                        ) : (
                                            <AvatarStack people={group.members} />
                                        )}
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                        {group.members.length}
                                        {group.members.length === 1 ? " person" : " people"}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {creating ? <NewGroupDialog onClose={() => setCreating(false)} /> : null}

            {open ? (
                <GroupDialog
                    group={open}
                    users={users}
                    disabled={pending}
                    onMutate={mutate}
                    onDelete={() => {
                        setOpenId(null);
                        setDeleting(open);
                    }}
                    onClose={() => setOpenId(null)}
                />
            ) : null}

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(next) => !next && setDeleting(null)}
                name={deleting?.name ?? ""}
                kind="group"
                requireTyping={false}
                description="Anything granted to the group is granted through it, so deleting it takes that access away from everybody in it. The accounts themselves are untouched."
                pending={pending}
                onConfirm={() => {
                    const target = deleting;
                    if (!target) return;
                    setDeleting(null);
                    mutate(() => deleteGroupAction(target.id));
                }}
            />
        </div>
    );
}

/** Somebody new to belong to something. Name and description only: what a group
 *  reaches is granted to it elsewhere, on the Policies page. */
function NewGroupDialog({ onClose }: { onClose: () => void }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [error, setError] = useState("");

    function onCreate(event: FormEvent) {
        event.preventDefault();
        setError("");
        startTransition(async () => {
            const result = await createGroupAction(name.trim(), description.trim() || undefined);
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
            onClose();
        });
    }

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>New group</DialogTitle>
                    <DialogDescription>
                        Bundle people together, then grant access to the group rather than to each
                        of them.
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={onCreate} className="flex flex-col gap-3">
                    <Input
                        autoFocus
                        placeholder="Group name"
                        aria-label="Group name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                    <Input
                        placeholder="Description (optional)"
                        aria-label="Description"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={pending || !name.trim()}>
                            Create group
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** One group, opened: who is in it, who can be added, and the way out of it. */
function GroupDialog({
    group,
    users,
    disabled,
    onMutate,
    onDelete,
    onClose
}: {
    group: GroupRow;
    users: UserOption[];
    disabled: boolean;
    onMutate: (run: () => Promise<unknown>) => void;
    onDelete: () => void;
    onClose: () => void;
}) {
    const [add, setAdd] = useState("");
    const memberIds = new Set(group.members.map((member) => member.id));
    const candidates = users.filter((user) => !memberIds.has(user.id));

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    {/* Padded on the right so a long name does not run under the
                        dialog's own close button. */}
                    <DialogTitle className="flex items-center gap-2 pr-6">
                        <span className="truncate" title={group.name}>{group.name}</span>
                        {group.isSystem ? <Badge>system</Badge> : null}
                    </DialogTitle>
                    <DialogDescription>
                        {group.description ||
                            "Whoever is in this group is granted whatever the group is granted."}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-1">
                    {group.members.length === 0 ? (
                        <p className="py-2 text-sm text-muted-foreground">Nobody is in it yet.</p>
                    ) : (
                        group.members.map((member) => (
                            <div key={member.id} className="flex items-center gap-3 py-1">
                                <Avatar person={member} size={28} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm" title={member.name}>{member.name}</p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {member.email}
                                    </p>
                                </div>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    disabled={disabled}
                                    title="Remove from the group"
                                    aria-label={`Remove ${member.name} from ${group.name}`}
                                    onClick={() =>
                                        onMutate(() => removeGroupMemberAction(group.id, member.id))
                                    }
                                >
                                    <X className="size-4" />
                                </Button>
                            </div>
                        ))
                    )}
                </div>

                {candidates.length > 0 ? (
                    <div className="mt-3 flex items-center gap-2">
                        <Select
                            className="flex-1"
                            value={add}
                            onValueChange={setAdd}
                            aria-label="Add somebody to this group"
                            placeholder="Add a member..."
                            options={candidates.map((user) => ({
                                value: user.id,
                                label: `${user.name} (${user.email})`
                            }))}
                        />
                        <Button
                            variant="secondary"
                            disabled={disabled || !add}
                            onClick={() => {
                                if (!add) return;
                                onMutate(() => addGroupMemberAction(group.id, add));
                                setAdd("");
                            }}
                        >
                            <UserPlus className="size-4" />
                            Add
                        </Button>
                    </div>
                ) : (
                    <p className="mt-3 text-xs text-muted-foreground">
                        Everybody on this deployment is already in it.
                    </p>
                )}

                <DialogFooter className={cn(!group.isSystem && "justify-between")}>
                    {!group.isSystem ? (
                        <Button variant="danger" disabled={disabled} onClick={onDelete}>
                            <Trash2 className="size-4" />
                            Delete group
                        </Button>
                    ) : null}
                    <Button variant="ghost" onClick={onClose}>
                        Done
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
