"use client";

/**
 * The quick-unlock PIN: a short code that reopens a dashboard the inactivity
 * lock closed. It never replaces the password - signing in still needs it - so a
 * 4-6 digit secret is an acceptable trade for reopening a session you already
 * proved. Setting or removing it requires the password, so the lock cannot be
 * downgraded from a session someone else is holding.
 */

import { useEffect, useState, type FormEvent } from "react";
import { codeDigits } from "@/components/code-input";
import { setPinSchema } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@polaris/ui";
import { clearPinAction, setPinAction } from "./actions";
import { Feedback } from "./setting-card";
import { knownMessage } from "./known-messages";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function SetPinDialog({
    open,
    onOpenChange,
    hasPin
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    hasPin: boolean;
}) {
    const t = useTranslations("accountSecurity");
    const tv = useTranslations("validation");
    const tc = useTranslations("common");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pin, setPin] = useState("");
    const [confirmPin, setConfirmPin] = useState("");
    const [password, setPassword] = useState("");
    const input = { pin, confirmPin, password };

    // A reopened dialog starts empty rather than holding the last PIN typed.
    useEffect(() => {
        if (!open) return;
        setPin("");
        setConfirmPin("");
        setPassword("");
        setError(null);
    }, [open]);
    // Save stays off until the form would pass, so a letter or a short PIN is
    // never something to press and be refused for.
    const ready = setPinSchema.safeParse(input).success;

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const parsed = setPinSchema.safeParse(input);
        if (!parsed.success) {
            const issue = parsed.error.issues[0]?.message;
            setError(issue ? knownMessage(t, tv, issue) : t("errors.checkForm"));
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
                    <DialogTitle>{hasPin ? t("pin.changeTitle") : t("pin.setTitle")}</DialogTitle>
                    <DialogDescription>{t("pin.description")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("pin.pin")}
                        <Input
                            name="pin"
                            type="password"
                            inputMode="numeric"
                            autoComplete="new-password"
                            value={pin}
                            onChange={(event) => setPin(codeDigits(event.target.value))}
                            required
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("pin.confirm")}
                        <Input
                            name="confirmPin"
                            type="password"
                            inputMode="numeric"
                            autoComplete="new-password"
                            value={confirmPin}
                            onChange={(event) => setConfirmPin(codeDigits(event.target.value))}
                            required
                        />
                        {confirmPin.length >= pin.length && confirmPin !== "" && confirmPin !== pin ? (
                            <span className="text-xs text-danger">{t("known.pinsDiffer")}</span>
                        ) : null}
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("dialog.accountPassword")}
                        <Input
                            name="password"
                            type="password"
                            required
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={busy || !ready}>
                            {busy ? tc("actions.saving") : t("pin.save")}
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
    const t = useTranslations("accountSecurity");
    const tc = useTranslations("common");
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
                    <DialogTitle>{t("pin.removeTitle")}</DialogTitle>
                    <DialogDescription>{t("pin.removeDescription")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("dialog.accountPassword")}
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" variant="danger" disabled={busy}>
                            {busy ? t("dialog.removing") : t("pin.remove")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
