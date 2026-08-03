"use client";

/**
 * Backup codes as a standing control rather than a thing that happened once.
 *
 * They are minted with the authenticator and shown in that dialog, which for a
 * long time was the only place they ever appeared: close the tab and the account
 * had a set of spare keys nobody could count, replace or reprint. That is the
 * wrong shape for the credential somebody reaches for precisely when their phone
 * is gone - so the count lives here, and a fresh set is always one password away.
 *
 * The count comes from the server, which reads the stored set through
 * better-auth. The codes themselves are never fetched: they exist in plaintext
 * only in the answer to the request that mints them, which is the dialog below.
 */

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { BackupCodesPanel } from "./backup-codes-panel";
import { regenerateBackupCodesAction } from "./two-factor-actions";
import { Feedback, SettingCard, type SettingLock } from "./setting-card";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@polaris/ui";

/** Below this, the set is close enough to spent to say so on the card. A person
 *  who has burned seven of ten has been signing in this way for a while and is
 *  going to run out mid-lockout unless something says otherwise. */
const LOW_WATER_MARK = 3;

/** What the card says about a set, given what the server could count. */
function describe(remaining: number | null): { status: string; description: string; low: boolean } {
    if (remaining === null) {
        return {
            status: "Unknown",
            description: "The stored set could not be read. Generating a new one replaces it.",
            low: true
        };
    }
    if (remaining === 0) {
        return {
            status: "None left",
            description: "Every code has been used. Without the authenticator there is no way back in.",
            low: true
        };
    }
    return {
        status: `${remaining} left`,
        description:
            remaining <= LOW_WATER_MARK
                ? "Running low. Generate a new set before you need one."
                : "Single-use codes that stand in for the authenticator when you cannot reach it.",
        low: remaining <= LOW_WATER_MARK
    };
}

export function BackupCodesCard({
    lock,
    twoFactorEnabled,
    remaining
}: {
    /** Set while this browser is too new on the account to change any of it. */
    lock?: SettingLock;
    twoFactorEnabled: boolean;
    /** Codes still unspent, or null when no readable set exists. */
    remaining: number | null;
}) {
    const [open, setOpen] = useState(false);

    // Backup codes are minted with the authenticator and die with it, so with the
    // factor off there is no set to count and nothing to replace. The card still
    // appears, because a way into the account that is missing is worth knowing
    // about - it just points at the thing that creates it.
    if (!twoFactorEnabled) {
        return (
            <SettingCard
                title="Backup codes"
                description="Single-use codes that get you in without the authenticator. They come with it."
                status="Off"
                statusTone="off"
            />
        );
    }

    const { status, description, low } = describe(remaining);

    return (
        <>
            <SettingCard
                title="Backup codes"
                description={description}
                status={status}
                statusTone={low ? "off" : "on"}
            >
                <Button variant={low ? "primary" : "outline"} disabled={Boolean(lock)} onClick={() => setOpen(true)}>
                    <KeyRound className="size-4" />
                    New codes
                </Button>
            </SettingCard>
            <RegenerateDialog open={open} onOpenChange={setOpen} />
        </>
    );
}

/**
 * Two steps: prove the password, then take the codes away.
 *
 * The second step has no cancel. Closing it is the only way out and the codes
 * are gone when it goes, which is the truth of the situation rather than a
 * nicety - the old set stopped working the moment this one was issued, so a
 * dialog that let somebody back out would be lying about what it had done.
 */
function RegenerateDialog({
    open,
    onOpenChange
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const [codes, setCodes] = useState<string[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function close() {
        onOpenChange(false);
        // Cleared on the way out, not on the way in: the codes must not survive
        // in state behind a closed dialog, and the count on the card is stale
        // the moment a set is issued.
        setCodes(null);
        setError(null);
        setBusy(false);
        router.refresh();
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setError(null);
        const result = await regenerateBackupCodesAction({ password });
        setBusy(false);
        if (result.error || !result.codes) {
            setError(result.error ?? "The codes could not be generated.");
            return;
        }
        setCodes(result.codes);
    }

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{codes ? "Your new backup codes" : "Generate new backup codes"}</DialogTitle>
                    <DialogDescription>
                        {codes
                            ? "Save these now. This is the only time they are shown."
                            : "Your current codes stop working straight away, including any you have printed."}
                    </DialogDescription>
                </DialogHeader>

                {codes ? (
                    <div className="flex flex-col gap-3">
                        <BackupCodesPanel
                            codes={codes}
                            label="Each code works once. Keep them somewhere you can reach without your phone."
                        />
                        <div className="flex justify-end">
                            <Button type="button" onClick={close}>
                                Done
                            </Button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Current password
                            <Input name="password" type="password" required autoComplete="current-password" />
                        </label>
                        <Feedback error={error} />
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={close}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy}>
                                {busy ? "Generating..." : "Generate"}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
