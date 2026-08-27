"use client";

/**
 * Giving a file or folder to somebody on this instance.
 *
 * The other share dialog mints a link for whoever holds it; this one names
 * people, which is the one somebody reaches for first and the only one that
 * works when what is being shared should stay inside the instance. They are kept
 * apart rather than tabbed together because the questions have nothing in common
 * - a link asks about passwords, download caps and which countries may open it,
 * a person asks who and whether they may change it.
 *
 * Who already holds the item is listed underneath, because "who can see this"
 * is the question people actually open a share dialog to answer, and a dialog
 * that only ever adds leaves them guessing.
 */

import { Avatar } from "@/components/avatar";
import type { ItemShare } from "./sharing-types";
import { DRIVE_GRANT_NOTE_MAX } from "@polaris/core";
import { Loader2, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ExpirySelect } from "@/components/expiry-select";
import { useDisplayFormat } from "@/components/display-format";
import type { DriveShareRole, SharePerson } from "@/lib/drive-sharing";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import {
    findSharePeopleAction,
    listItemSharesAction,
    myShareGroupsAction,
    shareItemAction,
    stopSharingAction
} from "./sharing-actions";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

export interface PeopleShareTarget {
    connectionId: string;
    path: string;
    name: string;
    isDir: boolean;
}

const ROLE_OPTIONS = [
    { value: "viewer", label: "Can view" },
    { value: "editor", label: "Can edit" }
];

/** What a grant made outside this dialog reads as, so nothing is rounded up. */
const ROLE_LABELS: Record<DriveShareRole | "custom", string> = {
    viewer: "Can view",
    editor: "Can edit",
    custom: "Custom access"
};

export function PeopleShareDialog({
    target,
    onOpenChange,
    onChanged
}: {
    target: PeopleShareTarget | null;
    onOpenChange: (open: boolean) => void;
    /** Something changed, so whatever drew the item should look again. */
    onChanged?: () => void;
}) {
    const format = useDisplayFormat();
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [groups, setGroups] = useState<SharePerson[]>([]);
    const [groupId, setGroupId] = useState("");
    const [role, setRole] = useState<DriveShareRole>("viewer");
    const [note, setNote] = useState("");
    const [expiresAt, setExpiresAt] = useState("");
    const [holders, setHolders] = useState<ItemShare[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const connectionId = target?.connectionId;
    const path = target?.path;

    const reload = useCallback(async () => {
        if (connectionId === undefined || path === undefined) return;
        const result = await listItemSharesAction(connectionId, path);
        setHolders(result.people);
        if (result.error) setError(result.error);
    }, [connectionId, path]);

    useEffect(() => {
        if (connectionId === undefined) {
            setHolders(null);
            return;
        }
        setPicked([]);
        setGroupId("");
        setRole("viewer");
        setNote("");
        setExpiresAt("");
        setError(null);
        void reload();
        // Somebody in no groups gets no group field at all rather than an empty
        // dropdown that looks like something failed to load.
        void myShareGroupsAction().then(setGroups);
    }, [connectionId, path, reload]);

    if (!target) return null;

    const held = (type: ItemShare["type"]) =>
        (holders ?? []).filter((holder) => holder.type === type).map((holder) => holder.id);
    const alreadyHeld = held("user");
    // A group that already holds the item is left out for the same reason a
    // person is: sharing to it again is not a second grant but a silent rewrite
    // of the one it has, down to clearing a date this dialog did not ask about.
    // Changing what a holder may do is done on their row underneath.
    const heldGroups = new Set(held("group"));
    const groupOptions = groups.filter((group) => !heldGroups.has(group.id));
    const nobodyChosen = picked.length === 0 && groupId === "";

    async function share() {
        if (!target || nobodyChosen) return;
        setBusy(true);
        setError(null);

        const recipients: Array<{ principalType: "user" | "group"; principalId: string }> = [
            ...picked.map((person) => ({ principalType: "user" as const, principalId: person.id })),
            ...(groupId ? [{ principalType: "group" as const, principalId: groupId }] : [])
        ];

        // One at a time so that one refusal - somebody who left, a group that was
        // deleted while the dialog was open - does not silently drop the rest.
        let failed: string | null = null;
        for (const recipient of recipients) {
            const result = await shareItemAction({
                connectionId: target.connectionId,
                path: target.path,
                principalType: recipient.principalType,
                principalId: recipient.principalId,
                role,
                note: note.trim() || undefined,
                expiresAt: expiresAt || undefined
            });
            if (result.error) failed = result.error;
        }

        setPicked([]);
        setGroupId("");
        setNote("");
        await reload();
        setError(failed);
        setBusy(false);
        onChanged?.();
    }

    async function stop(holder: ItemShare) {
        if (!target) return;
        setBusy(true);
        const result = await stopSharingAction(target.connectionId, holder.grantId);
        setError(result.error ?? null);
        await reload();
        setBusy(false);
        onChanged?.();
    }

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Share {target.name}</DialogTitle>
                    <DialogDescription>
                        {target.isDir
                            ? "Whoever you name can open this folder and everything in it."
                            : "Whoever you name can open this file from their own Drive."}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <PeoplePicker
                        picked={picked}
                        onChange={setPicked}
                        exclude={alreadyHeld}
                        label="Share with"
                        search={findSharePeopleAction}
                    />

                    {groupOptions.length > 0 && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="text-xs text-muted-foreground">Or a group</span>
                            <Select
                                value={groupId}
                                onValueChange={setGroupId}
                                placeholder="No group"
                                options={groupOptions.map((group) => ({
                                    value: group.id,
                                    label: group.name
                                }))}
                            />
                        </label>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="text-xs text-muted-foreground">They may</span>
                            <Select
                                value={role}
                                onValueChange={(value) => setRole(value as DriveShareRole)}
                                options={ROLE_OPTIONS}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="text-xs text-muted-foreground">Until</span>
                            <ExpirySelect onChange={setExpiresAt} />
                        </label>
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="text-xs text-muted-foreground">
                            A line for them (optional)
                        </span>
                        <Input
                            value={note}
                            maxLength={DRIVE_GRANT_NOTE_MAX}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder="What this is"
                        />
                    </label>

                    <div className="flex justify-end">
                        <Button onClick={() => void share()} disabled={busy || nobodyChosen}>
                            {busy && <Loader2 className="size-4 animate-spin" />}
                            Share
                        </Button>
                    </div>

                    {error && <p className="text-sm text-danger">{error}</p>}

                    <div className="flex flex-col gap-2 border-t border-border pt-3">
                        <h3 className="text-xs font-medium text-muted-foreground">
                            People with access
                        </h3>
                        {holders === null ? (
                            <p className="text-sm text-muted-foreground">Looking</p>
                        ) : holders.length === 0 ? (
                            <p className="text-sm text-muted-foreground">Only you, so far.</p>
                        ) : (
                            <ul className="flex flex-col gap-1">
                                {holders.map((holder) => {
                                    // A grant with a date on it stops applying
                                    // when that date passes, and nothing sweeps
                                    // the table - so one that has says so rather
                                    // than sitting here as access somebody has.
                                    const lapsed =
                                        holder.expiresAt !== null &&
                                        new Date(holder.expiresAt).getTime() <= Date.now();
                                    return (
                                        <li
                                            key={holder.grantId}
                                            className="flex items-center gap-2 rounded-md px-1 py-1"
                                        >
                                            {holder.type === "group" ? (
                                                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
                                                    <Users className="size-3.5" />
                                                </span>
                                            ) : (
                                                <Avatar
                                                    person={{ id: holder.id, name: holder.name }}
                                                    size={24}
                                                />
                                            )}
                                            <span className="min-w-0 flex-1 truncate text-sm">
                                                {holder.name}
                                            </span>
                                            <Badge>{ROLE_LABELS[holder.role]}</Badge>
                                            {holder.expiresAt && (
                                                <Badge variant={lapsed ? "neutral" : "warning"}>
                                                    {lapsed ? "Lapsed" : "Until"}{" "}
                                                    {format.date(holder.expiresAt)}
                                                </Badge>
                                            )}
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                disabled={busy}
                                                title="Stop sharing"
                                                aria-label={`Stop sharing with ${holder.name}`}
                                                onClick={() => void stop(holder)}
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
