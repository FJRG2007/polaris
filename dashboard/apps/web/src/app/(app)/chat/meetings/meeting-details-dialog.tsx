"use client";

/**
 * Changing a meeting's name or its hour, without ending it.
 *
 * Both were settable once, at the moment the meeting was made, and never again -
 * so a meeting that moved by half an hour, or that was named before anybody knew
 * what it was about, had exactly one remedy: end it, make another, and send
 * everybody a second link. That is a link already in somebody's calendar going
 * dead over a typo.
 *
 * The host's, because a meeting has one. The server was already able to do this;
 * this is the screen that asks it.
 *
 * Saving is refused while nothing has changed, so a dialog opened to look at is
 * a dialog that closes without writing anything.
 */

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { MAX_MEETING_TITLE } from "@/lib/chat/meeting-limits";
import { setMeetingOptionsAction } from "@/app/(app)/chat/meeting-actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** What a `datetime-local` field holds, from a moment. It takes local wall-clock
 *  and nothing else, so this is the reader's own clock rather than the stored
 *  instant. Empty for a meeting with no hour on it, which is a room that is open
 *  whenever its host is. */
function toLocalInput(iso: string | null): string {
    if (!iso) return "";
    const at = new Date(iso);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function MeetingDetailsDialog({
    open,
    meetingId,
    title,
    scheduledAt,
    onClose,
    onSaved,
    onError
}: {
    open: boolean;
    meetingId: string;
    /** What it is called now, and when it is due now. The dialog opens holding
     *  these, and compares against them to decide whether there is anything to
     *  save. */
    title: string;
    scheduledAt: string | null;
    onClose: () => void;
    onSaved: () => void | Promise<void>;
    onError: (message: string) => void;
}) {
    const [name, setName] = useState(title);
    const [when, setWhen] = useState(() => toLocalInput(scheduledAt));
    const [busy, setBusy] = useState(false);

    // Filled on the way in rather than the way out, so a dialog reopened after a
    // change made somewhere else is holding what is true now.
    useEffect(() => {
        if (!open) return;
        setName(title);
        setWhen(toLocalInput(scheduledAt));
    }, [open, title, scheduledAt]);

    const was = toLocalInput(scheduledAt);
    const changed = name.trim() !== title.trim() || when !== was;

    const save = async (): Promise<void> => {
        setBusy(true);
        const result = await runAction(
            () =>
                setMeetingOptionsAction({
                    meetingId,
                    title: name,
                    // The field is a local wall-clock and the server is nowhere,
                    // so the moment is worked out here, where the clock is. Null
                    // takes the hour off entirely rather than leaving it alone.
                    scheduledAt: when ? new Date(when).toISOString() : null
                }),
            onError
        );
        setBusy(false);
        if (result?.error) return;
        onClose();
        await onSaved();
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Meeting details</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium">
                            Name<span className="text-danger"> *</span>
                        </span>
                        <Input
                            autoFocus
                            value={name}
                            maxLength={MAX_MEETING_TITLE}
                            placeholder="What it is about"
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium">When</span>
                        <Input
                            type="datetime-local"
                            value={when}
                            onChange={(event) => setWhen(event.target.value)}
                        />
                        <span className="text-[0.6875rem] text-muted-foreground">
                            Clear it for a room that is open whenever you are. The link does not
                            change either way.
                        </span>
                    </label>
                </div>
                <DialogFooter>
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        disabled={busy || !name.trim() || !changed}
                        onClick={() => void save()}
                    >
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
