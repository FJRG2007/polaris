"use client";

/**
 * Adding people to a channel.
 *
 * The people already in it are excluded rather than shown greyed out: offering
 * somebody who is already here, and then doing nothing when they are picked,
 * reads as a broken button rather than as a no-op.
 */

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { PeoplePicker, type PickedPerson } from "./people-picker";
import { addChannelMembersAction, listMembersAction, searchPeopleAction } from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function AddPeopleDialog({
    open,
    onOpenChange,
    channel,
    onAdded
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    channel: ChatChannelView;
    onAdded: () => void;
}) {
    const [already, setAlready] = useState<readonly string[]>([]);
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        void listMembersAction(channel.id).then((result) =>
            setAlready((result.members ?? []).map((member) => member.userId))
        );
    }, [open, channel.id]);

    const add = async () => {
        setBusy(true);
        setError("");
        const result = await runAction(
            () =>
                addChannelMembersAction({
                    id: channel.id,
                    userIds: picked.map((person) => person.id)
                }),
            setError
        );
        setBusy(false);
        if (result?.error) return;
        setPicked([]);
        onOpenChange(false);
        onAdded();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add people</DialogTitle>
                    <DialogDescription>
                        {channel.private
                            ? "They will see this channel and everything already said in it."
                            : "Anybody in the space can already read this channel. Adding them puts it in their list."}
                    </DialogDescription>
                </DialogHeader>

                <PeoplePicker
                    picked={picked}
                    onChange={setPicked}
                    exclude={already}
                    search={searchPeopleAction}
                />

                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        disabled={busy || picked.length === 0}
                        onClick={() => void add()}
                    >
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Add
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
