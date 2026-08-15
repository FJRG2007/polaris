"use client";

/**
 * Starting a direct message.
 *
 * One person makes a two-way conversation and there is only ever one of those
 * with anybody - asking again reopens the one that exists, with its history,
 * rather than a second empty one. More than one makes a group, and asking twice
 * there does make two, because three people can genuinely want two different
 * conversations.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useChat } from "./chat-context";
import { useRouter } from "next/navigation";
import { openDirectAction } from "./actions";
import { runAction } from "@/lib/run-action";
import { PeoplePicker, type PickedPerson } from "./people-picker";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function NewDirectDialog({
    open,
    onOpenChange
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const { viewerId, refresh } = useChat();
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const start = async () => {
        setBusy(true);
        setError("");
        const result = await runAction(
            () => openDirectAction({ userIds: picked.map((person) => person.id) }),
            setError
        );
        setBusy(false);
        if (result?.error || !result?.id) return;
        setPicked([]);
        onOpenChange(false);
        refresh();
        router.push(`/chat/c/${result.id}`);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New message</DialogTitle>
                    <DialogDescription>
                        One person, or several for a group.
                    </DialogDescription>
                </DialogHeader>

                <PeoplePicker
                    picked={picked}
                    onChange={setPicked}
                    // Messaging yourself is not what anybody means by this, and
                    // the room it would open has nobody else in it.
                    exclude={[viewerId]}
                    label="Who to message"
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
                    <Button size="sm" disabled={busy || picked.length === 0} onClick={() => void start()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {picked.length > 1 ? "Start group" : "Start conversation"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
