"use client";

/**
 * Asking an administrator to accept a known risk before a setting is lowered.
 *
 * The change is only made from the dialog's own confirm button, which stays off
 * until the box saying "I accept the risk" is ticked - in words, not a native
 * confirm. The server refuses the same change without that acceptance, so this
 * is the explanation, not the control.
 *
 * The box starts unticked every time the dialog opens: an acceptance is for the
 * change in front of the reader, never carried over from an earlier one.
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

export interface RiskAcceptanceCopy {
    title: string;
    description: string;
    /** The sentence the administrator ticks. */
    accept: string;
    /** Closes the dialog and leaves the setting as it was. */
    keep: string;
    /** Makes the change, with the risk accepted. */
    confirm: string;
}

export function RiskAcceptanceDialog({
    open,
    copy,
    onKeep,
    onAccept
}: {
    open: boolean;
    copy: RiskAcceptanceCopy;
    onKeep: () => void;
    onAccept: () => void;
}) {
    const [accepted, setAccepted] = useState(false);

    useEffect(() => {
        if (open) setAccepted(false);
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onKeep()}>
            <DialogContent>
                <div className="flex flex-col gap-4">
                    <DialogHeader>
                        <DialogTitle>{copy.title}</DialogTitle>
                        <DialogDescription>{copy.description}</DialogDescription>
                    </DialogHeader>
                    <label className="flex items-start gap-2 text-sm">
                        <Checkbox checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
                        <span>{copy.accept}</span>
                    </label>
                    <DialogFooter>
                        <Button variant="secondary" onClick={onKeep}>
                            {copy.keep}
                        </Button>
                        <Button variant="danger" disabled={!accepted} onClick={onAccept}>
                            {copy.confirm}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
