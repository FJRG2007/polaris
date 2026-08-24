"use client";

/**
 * "Confirm it is you", asked once and meant for a moment.
 *
 * The dialog around `StepUpFields`, for the screens whose gate is a window
 * rather than a single act: it takes the proof, opens the two minutes, and gets
 * out of the way. A screen with one irreversible button does not want this - it
 * wants the fields inside its own confirmation, which is what `StepUpFields` is
 * for on its own.
 *
 * Whatever the account armed is what it is asked for, in the order it would be
 * trusted, and never the password when it has something stronger. That decision
 * is the service's; this only draws it.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { StepUpProofInput } from "@polaris/core";
import { StepUpFields } from "@/components/step-up-fields";
import { proveStepUpAction } from "@/app/(app)/account/step-up-actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function StepUpDialog({
    open,
    purpose,
    title,
    description,
    onOpenChange,
    onProved
}: {
    open: boolean;
    /** One of the closed list in `step-up-grant`; the server refuses any other. */
    purpose: string;
    title: string;
    description: string;
    onOpenChange: (open: boolean) => void;
    onProved: () => void | Promise<void>;
}) {
    const [proof, setProof] = useState<StepUpProofInput | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function confirm(): Promise<void> {
        if (!proof) return;
        setBusy(true);
        setError("");
        const result = await proveStepUpAction(purpose, proof);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        await onProved();
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) {
                    setProof(null);
                    setError("");
                }
            }}
        >
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <StepUpFields open={open} purpose={purpose} onChange={setProof} />
                {error ? (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                ) : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button disabled={busy || proof === null} onClick={() => void confirm()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Confirm
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
