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
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { regenerateBackupCodesAction } from "./two-factor-actions";
import { Feedback, SettingCard, type SettingLock } from "./setting-card";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@polaris/ui";

/** Below this, the set is close enough to spent to say so on the card. A person
 *  who has burned seven of ten has been signing in this way for a while and is
 *  going to run out mid-lockout unless something says otherwise. */
const LOW_WATER_MARK = 3;

/** What the card says about a set, given what the server could count. */
function describe(
    t: NamespaceTranslator<"accountSecurity">,
    remaining: number | null
): { status: string; description: string; low: boolean } {
    if (remaining === null) {
        return {
            status: t("backupCodes.unknown"),
            description: t("backupCodes.unreadable"),
            low: true
        };
    }
    if (remaining === 0) {
        return {
            status: t("backupCodes.noneLeft"),
            description: t("backupCodes.allUsed"),
            low: true
        };
    }
    return {
        status: t("backupCodes.left", { count: remaining }),
        description: remaining <= LOW_WATER_MARK ? t("backupCodes.runningLow") : t("backupCodes.description"),
        low: remaining <= LOW_WATER_MARK
    };
}

export function BackupCodesCard({
    lock,
    account,
    twoFactorEnabled,
    remaining
}: {
    /** Set while this browser is too new on the account to change any of it. */
    lock?: SettingLock;
    /** Who the codes belong to, so a saved set says which account it opens. */
    account: string;
    twoFactorEnabled: boolean;
    /** Codes still unspent, or null when no readable set exists. */
    remaining: number | null;
}) {
    const t = useTranslations("accountSecurity");
    const [open, setOpen] = useState(false);

    // Backup codes are minted with the authenticator and die with it, so with the
    // factor off there is no set to count and nothing to replace. The card still
    // appears, because a way into the account that is missing is worth knowing
    // about - it just points at the thing that creates it.
    if (!twoFactorEnabled) {
        return (
            <SettingCard
                title={t("backupCodes.title")}
                description={t("backupCodes.offDescription")}
                status={t("status.off")}
                statusTone="off"
            />
        );
    }

    const { status, description, low } = describe(t, remaining);

    return (
        <>
            <SettingCard
                title={t("backupCodes.title")}
                description={description}
                status={status}
                statusTone={low ? "off" : "on"}
            >
                <Button variant={low ? "primary" : "outline"} disabled={Boolean(lock)} onClick={() => setOpen(true)}>
                    <KeyRound className="size-4" />
                    {t("backupCodes.newCodes")}
                </Button>
            </SettingCard>
            <RegenerateDialog open={open} onOpenChange={setOpen} account={account} />
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
    onOpenChange,
    account
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    account: string;
}) {
    const router = useRouter();
    const t = useTranslations("accountSecurity");
    const tc = useTranslations("common");
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
            setError(result.error ?? t("backupCodes.notGenerated"));
            return;
        }
        setCodes(result.codes);
    }

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{codes ? t("backupCodes.newTitle") : t("backupCodes.generateTitle")}</DialogTitle>
                    <DialogDescription>
                        {codes ? t("backupCodes.saveNow") : t("backupCodes.oldStopWorking")}
                    </DialogDescription>
                </DialogHeader>

                {codes ? (
                    <div className="flex flex-col gap-3">
                        <BackupCodesPanel
                            codes={codes}
                            account={account}
                            label={t("backupCodes.panelLabel")}
                        />
                        <div className="flex justify-end">
                            <Button type="button" onClick={close}>
                                {t("dialog.done")}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("dialog.currentPassword")}
                            <Input name="password" type="password" required autoComplete="current-password" />
                        </label>
                        <Feedback error={error} />
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={close}>
                                {tc("actions.cancel")}
                            </Button>
                            <Button type="submit" disabled={busy}>
                                {busy ? t("backupCodes.generating") : t("backupCodes.generate")}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
