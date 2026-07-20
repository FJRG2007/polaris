"use client";

/**
 * Client view for group management: a create form plus a card per group with its
 * members and controls to add or remove people. Mutations route through the
 * server actions and refresh the server data, so the list stays authoritative.
 */

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Trash2, UserPlus, X } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import {
    addGroupMemberAction,
    createGroupAction,
    deleteGroupAction,
    removeGroupMemberAction
} from "./actions";

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
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [error, setError] = useState<string | null>(null);

    function onCreate(event: FormEvent) {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
            const result = await createGroupAction(name.trim(), description.trim() || undefined);
            if (result.error) {
                setError(result.error);
                return;
            }
            setName("");
            setDescription("");
            router.refresh();
        });
    }

    function mutate(run: () => Promise<unknown>) {
        startTransition(async () => {
            await run();
            router.refresh();
        });
    }

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
                <CardHeader>
                    <CardTitle>New group</CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onCreate} className="flex flex-col gap-3">
                        <Input placeholder="Group name" value={name} onChange={(event) => setName(event.target.value)} />
                        <Input
                            placeholder="Description (optional)"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                        />
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending || !name.trim()}>
                            Create group
                        </Button>
                    </form>
                </CardBody>
            </Card>

            <div className="flex flex-col gap-3 lg:col-span-2">
                {groups.length === 0 ? (
                    <Card>
                        <CardBody className="p-8 text-center text-sm text-muted-foreground">No groups yet.</CardBody>
                    </Card>
                ) : (
                    groups.map((group) => (
                        <GroupCard key={group.id} group={group} users={users} onMutate={mutate} disabled={pending} />
                    ))
                )}
            </div>
        </div>
    );
}

function GroupCard({
    group,
    users,
    onMutate,
    disabled
}: {
    group: GroupRow;
    users: UserOption[];
    onMutate: (run: () => Promise<unknown>) => void;
    disabled: boolean;
}) {
    const [add, setAdd] = useState("");
    const memberIds = new Set(group.members.map((member) => member.id));
    const candidates = users.filter((user) => !memberIds.has(user.id));

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <CardTitle className="flex items-center gap-2">
                            {group.name}
                            {group.isSystem ? <Badge>system</Badge> : null}
                        </CardTitle>
                        {group.description ? (
                            <p className="mt-1 text-xs text-muted-foreground">{group.description}</p>
                        ) : null}
                    </div>
                    {!group.isSystem ? (
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Delete group ${group.name}`}
                            disabled={disabled}
                            onClick={() => onMutate(() => deleteGroupAction(group.id))}
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    ) : null}
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                {group.members.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No members.</p>
                ) : (
                    <ul className="flex flex-wrap gap-1.5">
                        {group.members.map((member) => (
                            <li key={member.id}>
                                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                                    {member.name}
                                    <button
                                        type="button"
                                        aria-label={`Remove ${member.name}`}
                                        disabled={disabled}
                                        onClick={() => onMutate(() => removeGroupMemberAction(group.id, member.id))}
                                        className="text-muted-foreground hover:text-foreground"
                                    >
                                        <X className="size-3" />
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                {candidates.length > 0 ? (
                    <div className="flex items-center gap-2">
                        <Select
                            className="flex-1"
                            value={add}
                            onValueChange={setAdd}
                            placeholder="Add a member..."
                            options={candidates.map((user) => ({
                                value: user.id,
                                label: `${user.name} (${user.email})`
                            }))}
                        />
                        <Button
                            size="sm"
                            variant="ghost"
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
                ) : null}
            </CardBody>
        </Card>
    );
}
