"use client";

/**
 * The quick-unlock PIN: a short code that reopens a dashboard the inactivity
 * lock closed. It never replaces the password - signing in still needs it - so a
 * 4-6 digit secret is an acceptable trade for reopening a session you already
 * proved. Setting or removing it requires the password, so the lock cannot be
 * downgraded from a session someone else is holding.
 */

import { useState, type FormEvent } from "react";
import { setPinSchema } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@polaris/ui";
import { clearPinAction, setPinAction } from "./actions";
import { Feedback } from "./setting-card";

export function SetPinDialog({
    open,
    onOpenChange,
    hasPin
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    hasPin: boolean;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const input = {
            pin: String(form.get("pin") ?? ""),
            confirmPin: String(form.get("confirmPin") ?? ""),
            password: String(form.get("password") ?? "")
        };
        const parsed = setPinSchema.safeParse(input);
        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the form.");
            return;
        }
        setBusy(true);
        setError(null);
        const result = await setPinAction(input);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{hasPin ? "Change your unlock PIN" : "Set an unlock PIN"}</DialogTitle>
                    <DialogDescription>4 to 6 digits, used only to reopen a locked dashboard.</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        PIN
                        <Input
                            name="pin"
                            type="password"
                            inputMode="numeric"
                            maxLength={6}
                            autoComplete="new-password"
                            required
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Confirm PIN
                        <Input
                            name="confirmPin"
                            type="password"
                            inputMode="numeric"
                            maxLength={6}
                            autoComplete="new-password"
                            required
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Account password
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy}>
                            {busy ? "Saving..." : "Save PIN"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function RemovePinDialog({
    open,
    onOpenChange
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        const result = await clearPinAction(password);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Remove your unlock PIN</DialogTitle>
                    <DialogDescription>A locked dashboard will then ask for your password.</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Account password
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="danger" disabled={busy}>
                            {busy ? "Removing..." : "Remove PIN"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
