"use client";

/**
 * The phone numbers on the account, managed the way the email addresses are:
 * a list with the primary marked, each number confirmed on its own, any
 * confirmed one made the primary, any removed.
 *
 * A number is written down first and confirmed second, because a mistyped digit
 * would otherwise send codes to a stranger for as long as nobody noticed. The
 * confirmation arrives the same way the codes themselves will, so a number that
 * confirms is a number that can be reached, not just one that looks right. The
 * code box only ever appears under the number it was sent to, labelled with
 * that number, so it never reads as a second phone field.
 */

import { useRouter } from "next/navigation";
import type { UserPhoneView } from "@polaris/auth";
import { useEffect, useId, useState, type FormEvent } from "react";
import { formatPhoneInternational, otpCodeField, phoneField } from "@polaris/core";
import { MoreHorizontal, Plus, Send, Smartphone, Star, Trash2 } from "lucide-react";
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
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    PhoneInput
} from "@polaris/ui";
import {
    addPhoneAction,
    makePhonePrimaryAction,
    removePhoneAction,
    sendPhoneCodeAction,
    verifyPhoneAction
} from "./security/two-factor-actions";
import { Feedback } from "./security/setting-card";
import { knownMessage } from "./security/known-sentences";
import { CodeInput, isWholeCode } from "@/components/code-input";
import { useTranslations } from "@/components/i18n/i18n-provider";

type Result = { error?: string };

/**
 * The server actions behind the card. Account > Details uses the account's own;
 * the enrollment step passes its own set, which acts on the session the guard is
 * holding rather than bouncing it back to the step.
 */
export interface PhoneActions {
    addPhone: (input: { phone: string; password: string }) => Promise<Result & { id?: string }>;
    removePhone: (input: { id: string; password: string }) => Promise<Result>;
    makePrimary: (id: string) => Promise<Result>;
    sendCode: (id: string) => Promise<Result>;
    verify: (input: { id: string; code: string }) => Promise<Result>;
}

const ACCOUNT_PHONE_ACTIONS: PhoneActions = {
    addPhone: addPhoneAction,
    removePhone: removePhoneAction,
    makePrimary: makePhonePrimaryAction,
    sendCode: sendPhoneCodeAction,
    verify: verifyPhoneAction
};

/** How many numbers one account may hold. Mirrors MAX_USER_PHONES, which the
 *  server enforces; this only keeps Add from offering what will be refused. */
export const PHONE_LIMIT = 5;

/**
 * The number to add, when the field holds a whole, valid one that is not
 * already on the account (typed again, or only regrouped, it is nothing new).
 */
export function phoneToAdd(draft: string, held: readonly string[]): string | null {
    const candidate = phoneField.safeParse(draft);
    if (!candidate.success) return null;
    const same = held.some((phone) => {
        const stored = phoneField.safeParse(phone);
        return stored.success && stored.data === candidate.data;
    });
    return same ? null : candidate.data;
}

/** A stored number spelled for reading: grouped, with its country code. */
function readable(phone: string): string {
    try {
        return formatPhoneInternational(phone) || phone;
    } catch {
        return phone;
    }
}

export function PhoneCard({
    phones,
    canSend,
    enforced = false,
    actions = ACCOUNT_PHONE_ACTIONS,
    onVerified
}: {
    phones: readonly UserPhoneView[];
    canSend: boolean;
    /** The instance requires a confirmed phone on this account, so its last
     *  confirmed number cannot be removed here. */
    enforced?: boolean;
    actions?: PhoneActions;
    /** Called once a number is confirmed, instead of refreshing the page. */
    onVerified?: () => void;
}) {
    const router = useRouter();
    const t = useTranslations("account");
    const ts = useTranslations("accountSecurity");
    const addId = useId();
    // The number just added, listed while the save is on its way and dropped
    // again if it fails.
    const [pending, setPending] = useState<UserPhoneView | null>(null);
    const shown = pending ? [...phones, pending] : phones;
    const [draft, setDraft] = useState("");
    const [touched, setTouched] = useState(false);
    const [asking, setAsking] = useState(false);
    const [passwordError, setPasswordError] = useState<string | null>(null);
    const [removing, setRemoving] = useState<UserPhoneView | null>(null);
    // The number a code was sent to, whose confirmation box is open.
    const [confirming, setConfirming] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // What the server reports replaces the optimistic row, and a box left open
    // for a number that is gone or confirmed in another tab closes.
    useEffect(() => {
        setPending(null);
        setConfirming((open) =>
            open && phones.some((entry) => entry.id === open && needsCode(entry)) ? open : null
        );
    }, [phones]);

    const held = phones.map((entry) => entry.phone);
    const toAdd = phoneToAdd(draft, held);
    const parsedDraft = phoneField.safeParse(draft);
    const duplicate = parsedDraft.success && toAdd === null;
    const full = phones.length >= PHONE_LIMIT;
    const confirmedCount = phones.filter((entry) => entry.verified).length;

    async function run(key: string, action: () => Promise<Result>, refresh = true): Promise<boolean> {
        setBusy(key);
        setError(null);
        const result = await action().catch(() => ({ error: ts("errors.checkForm") }));
        setBusy(null);
        if (result.error) {
            setError(result.error);
            return false;
        }
        if (refresh) router.refresh();
        return true;
    }

    /** Send a code and open the box for it under that number. */
    async function sendCode(entry: UserPhoneView) {
        if (await run(entry.id, () => actions.sendCode(entry.id), false)) setConfirming(entry.id);
    }

    function askToAdd(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setTouched(true);
        if (!toAdd || full) return;
        setPasswordError(null);
        setAsking(true);
    }

    /** Adding a number is a way into the account, so it re-asks for the password. */
    async function confirmAdd(password: string) {
        const next = phoneToAdd(draft, held);
        if (!next) return;
        setAsking(false);
        setPending({ id: "pending", phone: next, verified: false, primary: phones.length === 0 });
        setBusy("add");
        setError(null);
        const result = await actions
            .addPhone({ phone: next, password })
            .catch((): Result & { id?: string } => ({ error: ts("errors.checkForm") }));
        setBusy(null);
        if (result.error || !result.id) {
            // Back to what the account really has. The typed number stays in
            // the field, and the password is asked again with the reason.
            setPending(null);
            setPasswordError(result.error ?? ts("errors.checkForm"));
            setAsking(true);
            return;
        }
        setDraft("");
        setTouched(false);
        router.refresh();
        // The next thing anybody does with a new number is confirm it.
        const added = result.id;
        if (canSend && (await run(added, () => actions.sendCode(added), false))) setConfirming(added);
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-medium">{t("phone.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("phone.description")}</p>
                    {enforced ? (
                        <p className="mt-1 text-xs text-muted-foreground">{t("phone.requiredByAdmin")}</p>
                    ) : null}
                </div>

                {shown.length > 0 ? (
                    <ul className="overflow-hidden rounded-md border border-border">
                        {shown.map((entry) => (
                            <PhoneRow
                                key={entry.id}
                                entry={entry}
                                busy={busy}
                                canSend={canSend}
                                locked={enforced && entry.verified && confirmedCount <= 1}
                                open={confirming === entry.id}
                                actions={actions}
                                onSendCode={() => void sendCode(entry)}
                                onMakePrimary={() => void run(entry.id, () => actions.makePrimary(entry.id))}
                                onRemove={() => setRemoving(entry)}
                                onVerified={() => {
                                    setConfirming(null);
                                    if (onVerified) onVerified();
                                    else router.refresh();
                                }}
                            />
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-muted-foreground">{t("phone.empty")}</p>
                )}

                <form onSubmit={askToAdd} noValidate className="flex min-w-0 flex-col gap-1">
                    <label htmlFor={addId} className="text-xs font-medium">
                        {t("phone.addLabel")}
                    </label>
                    <div className="flex min-w-0 flex-wrap items-start gap-2">
                        <PhoneInput
                            id={addId}
                            value={draft}
                            onChange={setDraft}
                            showError={touched}
                            onBlur={() => draft && setTouched(true)}
                            disabled={full}
                            className="min-w-0 flex-1 basis-56"
                        />
                        <Button type="submit" disabled={!toAdd || full || busy === "add"}>
                            <Plus className="size-4" />
                            {busy === "add" ? t("phone.adding") : t("phone.add")}
                        </Button>
                    </div>
                    {full ? (
                        <p className="text-xs text-muted-foreground">{t("phone.limitReached")}</p>
                    ) : duplicate ? (
                        <p className="text-xs text-danger">{t("phone.duplicate")}</p>
                    ) : null}
                </form>

                <Feedback error={error} />
            </CardBody>

            <PasswordDialog
                open={asking}
                error={passwordError}
                onOpenChange={(open) => !open && setAsking(false)}
                onConfirm={(password) => void confirmAdd(password)}
            />
            <RemovePhoneDialog
                entry={removing}
                remove={actions.removePhone}
                onOpenChange={(open) => !open && setRemoving(null)}
                onDone={() => {
                    setRemoving(null);
                    router.refresh();
                }}
            />
        </Card>
    );
}

function PhoneRow({
    entry,
    busy,
    canSend,
    locked,
    open,
    actions,
    onSendCode,
    onMakePrimary,
    onRemove,
    onVerified
}: {
    entry: UserPhoneView;
    busy: string | null;
    canSend: boolean;
    /** The last confirmed number on an account that must keep one. */
    locked: boolean;
    open: boolean;
    actions: PhoneActions;
    onSendCode: () => void;
    onMakePrimary: () => void;
    onRemove: () => void;
    onVerified: () => void;
}) {
    const t = useTranslations("account");
    const ts = useTranslations("accountSecurity");
    const number = readable(entry.phone);
    const saving = entry.id === "pending";
    const working = saving || busy === entry.id;
    const sendTitle = canSend ? undefined : ts("errors.connectWhatsAppFirst");
    const askable = needsCode(entry);

    return (
        <li className="flex flex-col gap-2 border-t border-border px-3 py-2 first:border-t-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                    <Smartphone className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm tabular-nums" title={number}>
                        {number}
                    </span>
                </div>
                <div className="ms-auto flex shrink-0 flex-wrap items-center gap-1.5">
                    {entry.primary ? <Badge variant="primary">{t("phone.primary")}</Badge> : null}
                    {entry.verified ? (
                        <Badge className="border-success-edge text-success">{t("phone.confirmed")}</Badge>
                    ) : (
                        <Badge className="border-warning-edge text-warning">{t("phone.unconfirmed")}</Badge>
                    )}
                    {!askable || open ? null : (
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={working || !canSend}
                            title={sendTitle}
                            aria-label={t("phone.confirmNamed", { phone: number })}
                            onClick={onSendCode}
                        >
                            {t("phone.confirm")}
                        </Button>
                    )}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="icon"
                                variant="ghost"
                                disabled={saving}
                                aria-label={t("phone.menuFor", { phone: number })}
                                title={t("phone.menuFor", { phone: number })}
                            >
                                <MoreHorizontal className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                            {entry.primary ? null : (
                                <DropdownMenuItem
                                    disabled={!entry.verified || working}
                                    title={entry.verified ? undefined : t("phone.needsConfirm")}
                                    onSelect={onMakePrimary}
                                >
                                    <Star className="size-3.5" />
                                    <span className="flex min-w-0 flex-col">
                                        {t("phone.makePrimary")}
                                        {entry.verified ? null : (
                                            <span className="text-xs text-muted-foreground">
                                                {t("phone.needsConfirm")}
                                            </span>
                                        )}
                                    </span>
                                </DropdownMenuItem>
                            )}
                            {askable ? (
                                <DropdownMenuItem disabled={!canSend || working} title={sendTitle} onSelect={onSendCode}>
                                    <Send className="size-3.5" />
                                    {open ? t("phone.resend") : t("phone.sendCode")}
                                </DropdownMenuItem>
                            ) : null}
                            {entry.primary && !askable ? null : <DropdownMenuSeparator />}
                            <DropdownMenuItem
                                variant="danger"
                                disabled={locked || working}
                                title={locked ? t("phone.lastRequired") : undefined}
                                onSelect={onRemove}
                            >
                                <Trash2 className="size-3.5" />
                                <span className="flex min-w-0 flex-col">
                                    {t("phone.remove")}
                                    {locked ? (
                                        <span className="text-xs text-muted-foreground">{t("phone.lastRequired")}</span>
                                    ) : null}
                                </span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
            {entry.reconfirm && !open ? (
                <p className="text-xs text-muted-foreground">{t("phone.reconfirmHint")}</p>
            ) : null}
            {open ? (
                <ConfirmPhoneForm
                    entry={entry}
                    number={number}
                    canSend={canSend}
                    resending={busy === entry.id}
                    verify={actions.verify}
                    onResend={onSendCode}
                    onVerified={onVerified}
                />
            ) : null}
        </li>
    );
}

/** Whether a code may be asked for this number: it is unconfirmed, or confirmed
 *  on another account too, where a new code is what settles whose it is. */
function needsCode(entry: UserPhoneView): boolean {
    return !entry.verified || entry.reconfirm === true;
}

/** The code box for one number, labelled with the number the code went to. */
function ConfirmPhoneForm({
    entry,
    number,
    canSend,
    resending,
    verify,
    onResend,
    onVerified
}: {
    entry: UserPhoneView;
    number: string;
    canSend: boolean;
    resending: boolean;
    verify: PhoneActions["verify"];
    onResend: () => void;
    onVerified: () => void;
}) {
    const t = useTranslations("account");
    const ts = useTranslations("accountSecurity");
    const tv = useTranslations("validation");
    const codeId = useId();
    const hintId = useId();
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const parsed = otpCodeField.safeParse(code);
        if (!parsed.success) {
            const issue = parsed.error.issues[0]?.message;
            setError(issue ? knownMessage(ts, tv, issue) : ts("errors.enterCode"));
            return;
        }
        setBusy(true);
        setError(null);
        const result = await verify({ id: entry.id, code: parsed.data }).catch(() => ({
            error: ts("errors.checkForm")
        }));
        setBusy(false);
        if (result.error) {
            setError(result.error);
            setCode("");
            return;
        }
        onVerified();
    }

    return (
        <form onSubmit={onSubmit} className="flex flex-col gap-1 rounded-md bg-muted/40 p-2">
            <label htmlFor={codeId} className="text-xs font-medium">
                {t("phone.codeSentTo", { phone: number })}
            </label>
            <div className="flex min-w-0 flex-wrap items-start gap-2">
                <CodeInput
                    id={codeId}
                    autoSubmit
                    autoFocus
                    value={code}
                    aria-describedby={hintId}
                    onValueChange={setCode}
                    className="min-w-0 flex-1 basis-40"
                />
                <Button type="submit" disabled={busy || !isWholeCode(code)}>
                    {t("phone.confirm")}
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    disabled={busy || resending || !canSend}
                    title={canSend ? undefined : ts("errors.connectWhatsAppFirst")}
                    onClick={onResend}
                >
                    {t("phone.resend")}
                </Button>
            </div>
            <p id={hintId} className="text-xs text-muted-foreground">
                {t("phone.codeHint")}
            </p>
            <Feedback error={error} />
        </form>
    );
}

/** The password an add is confirmed with, asked only once Add is pressed. */
function PasswordDialog({
    open,
    error,
    onOpenChange,
    onConfirm
}: {
    open: boolean;
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
                    <DialogTitle>{t("phone.addTitle")}</DialogTitle>
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
                            {t("phone.add")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function RemovePhoneDialog({
    entry,
    remove,
    onOpenChange,
    onDone
}: {
    entry: UserPhoneView | null;
    remove: PhoneActions["removePhone"];
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const ts = useTranslations("accountSecurity");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (entry) setError(null);
    }, [entry]);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!entry) return;
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setError(null);
        const result = await remove({ id: entry.id, password }).catch(() => ({ error: ts("errors.checkForm") }));
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onDone();
    }

    return (
        <Dialog open={entry !== null} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("phone.removeTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("phone.removeDescription", { phone: entry ? readable(entry.phone) : "" })}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("emails.currentPassword")}
                        <Input name="password" type="password" required autoFocus autoComplete="current-password" />
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
