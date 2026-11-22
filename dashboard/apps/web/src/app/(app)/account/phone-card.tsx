"use client";

/**
 * The account's phone number: a profile detail that doubles as the address a
 * second-factor code is sent to.
 *
 * It is written down first and confirmed second, because a mistyped digit would
 * otherwise send codes to a stranger for as long as nobody noticed. The
 * confirmation arrives the same way the codes themselves will - through one of
 * the user's own WhatsApp channels - so a number that confirms is a number that
 * can be reached, not just one that looks right.
 */

import { useRouter } from "next/navigation";
import type { UserPhoneView } from "@polaris/auth";
import { otpCodeField, phoneField } from "@polaris/core";
import { useEffect, useState, type FormEvent } from "react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    PhoneInput
} from "@polaris/ui";
import {
    removePhoneAction,
    sendPhoneCodeAction,
    setPhoneAction,
    verifyPhoneAction
} from "./security/two-factor-actions";
import { Feedback } from "./security/setting-card";
import { knownMessage } from "./security/known-sentences";
import { CodeInput, isWholeCode } from "@/components/code-input";
import { useTranslations } from "@/components/i18n/i18n-provider";

/**
 * What the field holds measured against the number on the account: the number
 * to save when it is a whole, valid one that is not already there (typed again,
 * or only regrouped, it is nothing to save).
 */
export function phoneDraftToSave(draft: string, stored: string): string | null {
    const candidate = phoneField.safeParse(draft);
    if (!candidate.success) return null;
    const current = phoneField.safeParse(stored);
    return current.success && current.data === candidate.data ? null : candidate.data;
}

export function PhoneCard({ phone, canSend }: { phone: UserPhoneView | null; canSend: boolean }) {
    const router = useRouter();
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const ts = useTranslations("accountSecurity");
    const tv = useTranslations("validation");
    // The number just saved, shown as the account's while the save is on its
    // way and dropped again if it fails.
    const [pending, setPending] = useState<UserPhoneView | null>(null);
    const shown = pending ?? phone;
    const [draft, setDraft] = useState(phone?.phone ?? "");
    const [touched, setTouched] = useState(false);
    const [dialog, setDialog] = useState<"password" | "remove" | null>(null);
    const [passwordError, setPasswordError] = useState<string | null>(null);
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // A number the server reports anew (after a save, a removal, another tab)
    // is what the field holds from then on.
    useEffect(() => {
        setPending(null);
        setDraft(phone?.phone ?? "");
        setTouched(false);
    }, [phone?.phone]);

    const toSave = busy ? null : phoneDraftToSave(draft, shown?.phone ?? "");

    async function run(action: () => Promise<{ error?: string }>, ok?: string) {
        setBusy(true);
        setError(null);
        setNotice(null);
        const result = await action();
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return false;
        }
        if (ok) setNotice(ok);
        router.refresh();
        return true;
    }

    function askToSave(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setTouched(true);
        if (!toSave) return;
        setPasswordError(null);
        setDialog("password");
    }

    /** Writing the number is a way into the account, so it re-asks for the password. */
    async function confirmSave(password: string) {
        const next = phoneDraftToSave(draft, shown?.phone ?? "");
        if (!next) return;
        setDialog(null);
        setPending({ phone: next, verified: false });
        setBusy(true);
        setError(null);
        setNotice(null);
        const result = await setPhoneAction({ phone: next, password }).catch(() => ({
            error: ts("errors.checkForm")
        }));
        setBusy(false);
        if (result.error) {
            // Back to what the account really has. The typed number stays in
            // the field, and the password is asked again with the reason.
            setPending(null);
            setPasswordError(result.error);
            setDialog("password");
            return;
        }
        router.refresh();
    }

    async function verify(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const parsed = otpCodeField.safeParse(code);
        if (!parsed.success) {
            const issue = parsed.error.issues[0]?.message;
            setError(issue ? knownMessage(ts, tv, issue) : ts("errors.enterCode"));
            return;
        }
        if (await run(() => verifyPhoneAction(parsed.data))) setCode("");
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-sm font-medium">
                                <label htmlFor="account-phone">{t("phone.title")}</label>
                            </h2>
                            {shown ? (
                                shown.verified ? (
                                    <Badge className="border-success-edge text-success">
                                        {t("phone.confirmed")}
                                    </Badge>
                                ) : (
                                    <Badge className="border-warning-edge text-warning">
                                        {t("phone.unconfirmed")}
                                    </Badge>
                                )
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">{t("phone.description")}</p>
                    </div>
                    {shown ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            disabled={busy}
                            onClick={() => setDialog("remove")}
                        >
                            {t("phone.remove")}
                        </Button>
                    ) : null}
                </div>

                <form onSubmit={askToSave} noValidate className="flex min-w-0 flex-wrap items-start gap-2">
                    <PhoneInput
                        id="account-phone"
                        value={draft}
                        onChange={setDraft}
                        showError={touched}
                        onBlur={() => setTouched(true)}
                        className="min-w-0 flex-1 basis-56"
                    />
                    <Button type="submit" disabled={!toSave}>
                        {busy && pending ? tc("actions.saving") : tc("actions.save")}
                    </Button>
                </form>

                {shown && !shown.verified ? (
                    <form onSubmit={verify} className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-start gap-2">
                            <CodeInput
                                autoSubmit
                                value={code}
                                aria-label={t("phone.code")}
                                onValueChange={setCode}
                            />
                            <Button type="submit" disabled={busy || !isWholeCode(code)}>
                                {t("phone.confirm")}
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                disabled={busy || !canSend}
                                title={canSend ? undefined : ts("errors.connectWhatsAppFirst")}
                                onClick={() => void run(sendPhoneCodeAction, t("phone.codeSent"))}
                            >
                                {t("phone.sendCode")}
                            </Button>
                        </div>
                    </form>
                ) : null}

                <Feedback error={error} ok={notice} />
            </CardBody>

            <PasswordDialog
                open={dialog === "password"}
                title={shown ? t("phone.changeTitle") : t("phone.addTitle")}
                error={passwordError}
                onOpenChange={(open) => !open && setDialog(null)}
                onConfirm={(password) => void confirmSave(password)}
            />
            <RemovePhoneDialog
                open={dialog === "remove"}
                onOpenChange={(open) => !open && setDialog(null)}
                onDone={() => {
                    setDialog(null);
                    router.refresh();
                }}
            />
        </Card>
    );
}

/** The password a save is confirmed with, asked only once Save is pressed. */
function PasswordDialog({
    open,
    title,
    error,
    onOpenChange,
    onConfirm
}: {
    open: boolean;
    title: string;
    error: string | null;
    onOpenChange: (open: boolean) => void;
    onConfirm: (password: string) => void;
}) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [password, setPassword] = useState("");

    useEffect(() => {
        if (open) setPassword("");
    }, [open]);

    function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (password) onConfirm(password);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{t("phone.setDescription")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("emails.currentPassword")}
                        <Input
                            name="password"
                            type="password"
                            required
                            autoFocus
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
                        <Button type="submit" disabled={!password}>
                            {tc("actions.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function RemovePhoneDialog({
    open,
    onOpenChange,
    onDone
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setError(null);
        const result = await removePhoneAction(password);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onDone();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("phone.removeTitle")}</DialogTitle>
                    <DialogDescription>{t("phone.removeDescription")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("emails.currentPassword")}
                        <Input
                            name="password"
                            type="password"
                            required
                            autoComplete="current-password"
                        />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" variant="danger" disabled={busy}>
                            {busy ? t("phone.removing") : t("phone.remove")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
