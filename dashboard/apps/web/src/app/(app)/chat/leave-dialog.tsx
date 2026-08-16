"use client";

/**
 * Walking out, with the one question worth asking first.
 *
 * Leaving used to happen the instant the menu item was pressed, which is a lot
 * of finality for one click on a menu that also holds "Copy link". So there is a
 * step in the way now, and the step carries the choice that only exists at this
 * moment: whether the room is told.
 *
 * **Quiet is offered, not the default.** The people still in the conversation
 * are the ones who need the line - it is why a question does not go unanswered
 * for a week - so the ordinary way out says so. Somebody who would rather slip
 * out has a box to tick, and nothing about their leaving is announced anywhere
 * else either.
 *
 * Deliberately not `ConfirmDeleteDialog`: nothing is being destroyed, nobody
 * should have to type a name to leave a chat, and the phrasing of that dialog
 * ("this cannot be undone") is wrong here - being added back is normal.
 */

import { useEffect, useState } from "react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

/** What is being left. The consequences differ enough to be worth saying. */
export type LeavingKind = "group" | "space";

const WHAT: Record<LeavingKind, { title: string; description: string; confirm: string }> = {
    group: {
        title: "Leave this group?",
        description:
            "It goes out of your list and you stop getting its messages. Anybody still in it can add you back.",
        confirm: "Leave group"
    },
    space: {
        title: "Leave this space?",
        description:
            "You lose every channel in it, including the ones you were added to by hand. Getting back in takes another invitation.",
        confirm: "Leave space"
    }
};

export function LeaveDialog({
    open,
    onOpenChange,
    kind,
    name,
    error = "",
    onLeave
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    kind: LeavingKind;
    /** Why it did not work, shown here rather than behind the dialog - the
     *  dialog stays open on a refusal, so an error anywhere else is an error
     *  nobody sees. */
    error?: string;
    /** What it is called, so the dialog names the thing being left rather than
     *  asking about "this conversation" over a screen showing four. */
    name: string;
    /** Do it. The flag is whether the room is left in silence. */
    onLeave: (quietly: boolean) => Promise<void> | void;
}) {
    const [quietly, setQuietly] = useState(false);
    const [busy, setBusy] = useState(false);
    const words = WHAT[kind];

    // Reset when it opens rather than when it closes: a dialog that closes on a
    // successful leave and then re-renders with the box still ticked would be
    // offering the last answer to the next question.
    useEffect(() => {
        if (open) {
            setQuietly(false);
            setBusy(false);
        }
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{words.title}</DialogTitle>
                    <DialogDescription>
                        {name ? `${name}. ` : ""}
                        {words.description}
                    </DialogDescription>
                </DialogHeader>

                <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <Checkbox
                        checked={quietly}
                        className="mt-0.5"
                        onChange={(event) => setQuietly(event.target.checked)}
                    />
                    <span>
                        Leave quietly
                        <span className="block text-xs text-muted-foreground">
                            Nobody is shown a line saying you left.
                        </span>
                    </span>
                </label>

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Stay
                    </Button>
                    <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true);
                            await onLeave(quietly);
                            setBusy(false);
                        }}
                    >
                        {busy ? "Leaving..." : words.confirm}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
