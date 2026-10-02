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

import { searchItems, type SearchField } from "@polaris/core/search-text";
import { useRouter } from "next/navigation";
import { Avatar, AvatarStack } from "@/components/avatar";
import { Plus, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import { PersonName, PersonRow } from "@/components/person-name";
import { useTranslations } from "@/components/i18n/i18n-provider";
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

const GROUP_FIELDS: readonly SearchField<GroupRow>[] = [
    { text: (group) => group.name },
    { text: (group) => group.description },
    { text: (group) => group.members.map((member) => member.name) },
    { text: (group) => group.members.map((member) => member.email) }
];

export function GroupsAdmin({ groups, users }: { groups: GroupRow[]; users: UserOption[] }) {
    const t = useTranslations("admin");
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

    // By the group's name, what it is for, or who is in it: somebody looking for
    // the group a person is in types that person's name. Over the rows already on
    // the page - a deployment's groups are a short list, and asking the server
    // would be slower than reading it.
    const shown = useMemo(() => searchItems(groups, query, GROUP_FIELDS), [groups, query]);

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
                        placeholder={t("groups.search.placeholder")}
                        aria-label={t("groups.search.label")}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                <Button onClick={() => setCreating(true)}>
                    <Plus className="size-4" />
                    {t("groups.newGroup")}
                </Button>
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">{t("groups.table.group")}</th>
                            <th className="hidden px-3 py-2 font-medium sm:table-cell">
                                {t("groups.table.members")}
                            </th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">
                                {t("groups.table.people")}
                            </th>
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
                                        ? t("groups.empty.none")
                                        : t("groups.empty.noMatch")}
                                </td>
                            </tr>
                        ) : (
                            shown.map((group) => (
                                <tr
                                    key={group.id}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={t("groups.open", { name: group.name })}
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
                                                    {group.isSystem ? (
                                                        <Badge>{t("groups.system")}</Badge>
                                                    ) : null}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    {group.description || t("groups.noDescription")}
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="hidden px-3 py-2 sm:table-cell">
                                        {group.members.length === 0 ? (
                                            <span className="text-xs text-muted-foreground">
                                                {t("groups.nobodyYet")}
                                            </span>
                                        ) : (
                                            <AvatarStack people={group.members} />
                                        )}
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                        {t("groups.peopleCount", { count: group.members.length })}
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
                title={t("groups.deleteDialog.title")}
                question={t.rich("groups.deleteDialog.question", {
                    name: deleting?.name ?? "",
                    strong: (chunks) => (
                        <span key="name" className="font-medium text-foreground">
                            {chunks}
                        </span>
                    )
                })}
                confirmLabel={t("groups.deleteDialog.confirm")}
                description={t("groups.deleteDialog.description")}
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
    const t = useTranslations("admin");
    const tc = useTranslations("common");
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
                    <DialogTitle>{t("groups.create.title")}</DialogTitle>
                    <DialogDescription>{t("groups.create.description")}</DialogDescription>
                </DialogHeader>

                <form onSubmit={onCreate} className="flex flex-col gap-3">
                    <Input
                        autoFocus
                        placeholder={t("groups.create.name")}
                        aria-label={t("groups.create.name")}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                    <Input
                        placeholder={t("groups.create.descriptionPlaceholder")}
                        aria-label={t("groups.create.descriptionLabel")}
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
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={pending || !name.trim()}>
                            {t("groups.create.submit")}
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
    const t = useTranslations("admin");
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
                        <span className="truncate" title={group.name}>
                            {group.name}
                        </span>
                        {group.isSystem ? <Badge>{t("groups.system")}</Badge> : null}
                    </DialogTitle>
                    <DialogDescription>
                        {group.description || t("groups.dialog.defaultDescription")}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-1">
                    {group.members.length === 0 ? (
                        <p className="py-2 text-sm text-muted-foreground">
                            {t("groups.dialog.noMembers")}
                        </p>
                    ) : (
                        group.members.map((member) => (
                            <PersonRow
                                key={member.id}
                                personId={member.id}
                                className="flex items-center gap-3 rounded-md px-1.5 py-1"
                            >
                                <Avatar person={member} size={28} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm" title={member.name}>
                                        <PersonName id={member.id} name={member.name} />
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {member.email}
                                    </p>
                                </div>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    disabled={disabled}
                                    title={t("groups.dialog.removeTitle")}
                                    aria-label={t("groups.dialog.removeLabel", {
                                        member: member.name,
                                        group: group.name
                                    })}
                                    onClick={() =>
                                        onMutate(() => removeGroupMemberAction(group.id, member.id))
                                    }
                                >
                                    <X className="size-4" />
                                </Button>
                            </PersonRow>
                        ))
                    )}
                </div>

                {candidates.length > 0 ? (
                    <div className="mt-3 flex items-center gap-2">
                        <Select
                            className="flex-1"
                            value={add}
                            onValueChange={setAdd}
                            aria-label={t("groups.dialog.addLabel")}
                            placeholder={t("groups.dialog.addPlaceholder")}
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
                            {t("groups.dialog.add")}
                        </Button>
                    </div>
                ) : (
                    <p className="mt-3 text-xs text-muted-foreground">
                        {t("groups.dialog.everybodyIn")}
                    </p>
                )}

                <DialogFooter className={cn(!group.isSystem && "justify-between")}>
                    {!group.isSystem ? (
                        <Button variant="danger" disabled={disabled} onClick={onDelete}>
                            <Trash2 className="size-4" />
                            {t("groups.dialog.delete")}
                        </Button>
                    ) : null}
                    <Button variant="ghost" onClick={onClose}>
                        {t("groups.dialog.done")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
