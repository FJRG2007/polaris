"use client";

/**
 * The lists of people this account keeps, to answer more than one setting with.
 *
 * Under the settings rather than on a screen of their own: a list means nothing
 * on its own, and somebody who arrived here to hide their number from one person
 * should see what a list is without having to go looking for it.
 *
 * A list in use says so, and cannot be deleted while it is. Deleting it would
 * leave a rule naming a set that no longer exists - which shows nobody anything,
 * and would be a setting changing meaning behind somebody's back.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { searchPeopleAction } from "./actions";
import { useConfirm } from "@/components/confirm-dialog";
import type { PrivacyListView } from "@/lib/privacy-service";
import { ListPlus, Loader2, Pencil, Trash2, Users } from "lucide-react";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import {
    createPrivacyListAction,
    deletePrivacyListAction,
    updatePrivacyListAction
} from "./actions";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** The list being edited, or the empty one being made. */
interface Editing {
    readonly id: string | null;
    readonly name: string;
    readonly members: readonly PickedPerson[];
}

export function ListsCard({ lists }: { lists: readonly PrivacyListView[] }) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [editing, setEditing] = useState<Editing | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    const act = async (run: () => Promise<{ error?: string }>): Promise<boolean> => {
        setBusy(true);
        setError("");
        const result = await runAction(run, setError);
        setBusy(false);
        if (!result || result.error) return false;
        router.refresh();
        return true;
    };

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                    <Users className="size-4 shrink-0" /> Lists
                </CardTitle>
                <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => setEditing({ id: null, name: "", members: [] })}
                >
                    <ListPlus className="size-3.5 shrink-0" /> New list
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-2">
                {lists.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        A list is a set of people you can point more than one setting at - the
                        people you hide your number from, the ones who see when you were last here.
                        Settings can also name people on their own row without one.
                    </p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                        {lists.map((list) => (
                            <li key={list.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[13px]" title={list.name}>{list.name}</span>
                                    <span className="block text-[11px] text-foreground-subtle">
                                        {list.members.length === 0
                                            ? "Nobody on it"
                                            : list.members.map((member) => member.name).join(", ")}
                                    </span>
                                    {list.usedBy.length > 0 && (
                                        <span className="block text-[11px] text-muted-foreground">
                                            Used by:{" "}
                                            {list.usedBy
                                                .map((field) =>
                                                    core.PRIVACY_FIELD_LABELS[field].toLowerCase()
                                                )
                                                .join(", ")}
                                        </span>
                                    )}
                                </span>
                                <button
                                    type="button"
                                    title="Edit"
                                    aria-label={`Edit ${list.name}`}
                                    disabled={busy}
                                    onClick={() =>
                                        setEditing({
                                            id: list.id,
                                            name: list.name,
                                            members: list.members
                                        })
                                    }
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                    <Pencil className="size-4 shrink-0" />
                                </button>
                                <button
                                    type="button"
                                    title={
                                        list.usedBy.length > 0
                                            ? "In use by a setting"
                                            : "Delete this list"
                                    }
                                    aria-label={`Delete ${list.name}`}
                                    disabled={busy || list.usedBy.length > 0}
                                    onClick={async () => {
                                        const ok = await confirm({
                                            title: `Delete ${list.name}?`,
                                            description:
                                                "The people on it are not told, and nothing else changes.",
                                            confirmLabel: "Delete",
                                            danger: true
                                        });
                                        if (ok) await act(() => deletePrivacyListAction(list.id));
                                    }}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                                >
                                    <Trash2 className="size-4 shrink-0" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </CardBody>

            {editing && (
                <ListDialog
                    editing={editing}
                    busy={busy}
                    onChange={setEditing}
                    onClose={() => setEditing(null)}
                    onSave={async (next) => {
                        const list = { name: next.name, members: next.members.map((person) => person.id) };
                        const done = await act(() =>
                            next.id
                                ? updatePrivacyListAction(next.id, list)
                                : createPrivacyListAction(list)
                        );
                        if (done) setEditing(null);
                    }}
                />
            )}
            {confirmElement}
        </Card>
    );
}

function ListDialog({
    editing,
    busy,
    onChange,
    onClose,
    onSave
}: {
    editing: Editing;
    busy: boolean;
    onChange: (editing: Editing) => void;
    onClose: () => void;
    onSave: (editing: Editing) => void | Promise<void>;
}) {
    const named = core.privacyListSchema.shape.name.safeParse(editing.name).success;

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{editing.id ? "Edit list" : "New list"}</DialogTitle>
                    <DialogDescription>
                        Name it for what it is for. Nobody on it is ever told they are.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Name
                        <Input
                            autoFocus
                            value={editing.name}
                            placeholder="Work"
                            onChange={(event) => onChange({ ...editing, name: event.target.value })}
                        />
                    </label>

                    <PeoplePicker
                        label="Add somebody"
                        picked={editing.members}
                        search={searchPeopleAction}
                        onChange={(members) => onChange({ ...editing, members })}
                    />
                </div>

                <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size="sm" disabled={!named || busy} onClick={() => void onSave(editing)}>
                        {busy && <Loader2 className="size-4 shrink-0 animate-spin" />}
                        Save
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
