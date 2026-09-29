"use client";

/**
 * Which ways the account will accept as its second factor, which one the
 * challenge offers first, and whether a new sign-in still has to be allowed from
 * a session that is already open.
 *
 * The authenticator is listed but not switchable: it is what arms the factor,
 * and it is the only method that keeps working when a mail channel is removed or
 * the messaging bridge goes down. Turning it into a choice would let somebody
 * make the deployment's health the thing standing between them and their account.
 *
 * Sign-in approval sits in the same list because it is one of the ways the
 * account is proven, and a control kept somewhere else is a control nobody
 * finds. It is the one gate here that works with no second factor set up at all,
 * which is why the card is shown either way - and it is an alternative to a
 * second factor rather than an addition to it: an account that answers a code at
 * sign-in is not held for approval as well, so the row can only be armed while
 * the authenticator is off. Turning it off is always allowed.
 *
 * A method that cannot deliver right now says why instead of being hidden, so a
 * missing channel reads as something to fix rather than as a feature that never
 * existed. Saving asks for the password: every switch here widens or narrows the
 * ways in.
 */

import Link from "next/link";
import { Feedback, type SettingLock } from "./setting-card";
import { knownMessage, methodLabel } from "./known-sentences";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { setLoginApprovalAction } from "./actions";
import { saveTwoFactorPreferencesAction } from "./two-factor-actions";
import type { TwoFactorMethodStatus } from "@/lib/two-factor-delivery";
import {
    TWO_FACTOR_DELIVERY_METHODS,
    TWO_FACTOR_METHODS,
    type TwoFactorDeliveryMethod,
    type TwoFactorMethod
} from "@polaris/core";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch
} from "@polaris/ui";

/** What the sign-in approval gate can do for this account right now. */
export interface LoginApprovalStatus {
    enabled: boolean;
    hasPin: boolean;
    /** Open sessions other than this one, which is what an approval is decided from. */
    otherSessions: number;
}

export function TwoFactorMethodsCard({
    lock,
    statuses,
    preferred,
    twoFactorEnabled,
    trustedDevices,
    approval
}: {
    /** Set while this browser is too new on the account to change any of it. */
    lock?: SettingLock;
    statuses: TwoFactorMethodStatus[];
    preferred: TwoFactorMethod;
    twoFactorEnabled: boolean;
    /** Browsers currently allowed to sign in without answering the challenge. */
    trustedDevices: number;
    approval: LoginApprovalStatus;
}) {
    const router = useRouter();
    const t = useTranslations("accountSecurity");
    const tv = useTranslations("validation");
    const [methods, setMethods] = useState<TwoFactorDeliveryMethod[]>(
        TWO_FACTOR_DELIVERY_METHODS.filter(
            (method) => statuses.find((status) => status.method === method)?.enabled === true
        )
    );
    const tc = useTranslations("common");
    const [choice, setChoice] = useState<TwoFactorMethod>(preferred);
    const [approve, setApprove] = useState(approval.enabled);
    const [confirming, setConfirming] = useState(false);
    const locked = Boolean(lock);

    const savedMethods = TWO_FACTOR_DELIVERY_METHODS.filter(
        (method) => statuses.find((status) => status.method === method)?.enabled === true
    );
    const preferencesChanged =
        choice !== preferred ||
        methods.length !== savedMethods.length ||
        savedMethods.some((method) => !methods.includes(method));
    const changed = preferencesChanged || approve !== approval.enabled;

    function toggle(method: TwoFactorDeliveryMethod, next: boolean) {
        const updated = next ? [...methods, method] : methods.filter((entry) => entry !== method);
        setMethods(updated);
        if (!next && choice === method) setChoice("totp");
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">{t("methods.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("methods.description")}</p>
                </div>

                <div className="overflow-hidden rounded-md border border-border">
                    {statuses.map((status) => {
                        const label = methodLabel(t, status.method);
                        const isAuthenticator = status.method === "totp";
                        const on = isAuthenticator || methods.includes(status.method as TwoFactorDeliveryMethod);
                        return (
                            <div
                                key={status.method}
                                className="flex items-start justify-between gap-3 border-t border-border px-3 py-2 first:border-t-0"
                            >
                                <div className="min-w-0">
                                    <p className="text-sm">{label}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {status.target ?? t(`methods.${status.method}.description` as const)}
                                    </p>
                                    {status.blocker ? (
                                        <p className="text-xs text-warning">{knownMessage(t, tv, status.blocker)}</p>
                                    ) : null}
                                </div>
                                {isAuthenticator ? (
                                    <span className="shrink-0 text-xs text-muted-foreground">{t("methods.alwaysOn")}</span>
                                ) : (
                                    <Switch
                                        checked={on}
                                        disabled={locked || !twoFactorEnabled || (!status.available && !on)}
                                        aria-label={t("methods.use", { method: label })}
                                        onChange={(next) =>
                                            toggle(status.method as TwoFactorDeliveryMethod, next)
                                        }
                                    />
                                )}
                            </div>
                        );
                    })}

                    <div className="flex items-start justify-between gap-3 border-t border-border px-3 py-2">
                        <div className="min-w-0">
                            <p className="text-sm">{t("methods.approval.title")}</p>
                            <p className="text-xs text-muted-foreground">{t("methods.approval.description")}</p>
                            {twoFactorEnabled ? (
                                <p className="text-xs text-warning">{t("methods.approval.oneOfTwo")}</p>
                            ) : !approval.hasPin ? (
                                <p className="text-xs text-warning">{t("methods.approval.pinFirst")}</p>
                            ) : (
                                <Link
                                    href="/account/sessions"
                                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                                >
                                    {approval.otherSessions === 0
                                        ? t("methods.approval.noOtherSession")
                                        : t("methods.approval.otherSessions", { count: approval.otherSessions })}
                                </Link>
                            )}
                        </div>
                        <Switch
                            checked={approve}
                            disabled={locked || ((twoFactorEnabled || !approval.hasPin) && !approve)}
                            aria-label={t("methods.approval.label")}
                            onChange={setApprove}
                        />
                    </div>
                </div>

                {twoFactorEnabled ? (
                    <label className="flex flex-col gap-1 text-sm">
                        {t("methods.offerFirst")}
                        {/* Every method is listed, including the ones that are off: a list
                            with one entry looks like the account has one way in, when what
                            it means is that nothing else has been turned on yet. */}
                        <Select
                            value={choice}
                            disabled={locked}
                            onValueChange={(value) => setChoice(value as TwoFactorMethod)}
                            options={TWO_FACTOR_METHODS.map((method) => {
                                const off =
                                    method !== "totp" &&
                                    !methods.includes(method as TwoFactorDeliveryMethod);
                                return {
                                    value: method,
                                    label: off ? t("methods.off", { method: methodLabel(t, method) }) : methodLabel(t, method),
                                    disabled: off
                                };
                            })}
                        />
                    </label>
                ) : null}

                {/* Only worth a row while there is something to forget. A remembered
                    browser is the one way a sign-in skips the challenge without any
                    setting on this page saying so, so it is named here and listed
                    with the sessions, where the devices are. */}
                {twoFactorEnabled && trustedDevices > 0 ? (
                    <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
                        <div className="min-w-0">
                            <p className="text-sm">{t("sessions.trusted.title")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("methods.remembered", { count: trustedDevices })}
                            </p>
                        </div>
                        <Link href="/account/sessions">
                            <Button variant="outline" size="sm">
                                {t("methods.review")}
                            </Button>
                        </Link>
                    </div>
                ) : null}

                <p className="text-xs text-muted-foreground">{t("methods.noSms")}</p>

                <div className="flex justify-end">
                    <Button disabled={locked || !changed} onClick={() => setConfirming(true)}>
                        {tc("actions.save")}
                    </Button>
                </div>
            </CardBody>

            <ConfirmDialog
                open={confirming}
                methods={methods}
                preferred={choice}
                savePreferences={preferencesChanged}
                approval={approve === approval.enabled ? null : approve}
                onOpenChange={(open) => !open && setConfirming(false)}
                onDone={() => {
                    setConfirming(false);
                    router.refresh();
                }}
            />
        </Card>
    );
}

function ConfirmDialog({
    open,
    methods,
    preferred,
    savePreferences,
    approval,
    onOpenChange,
    onDone
}: {
    open: boolean;
    methods: TwoFactorDeliveryMethod[];
    preferred: TwoFactorMethod;
    /** Whether the method list or the default changed and needs writing. */
    savePreferences: boolean;
    /** The new state of the approval gate, or null when it did not change. */
    approval: boolean | null;
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) {
    const t = useTranslations("accountSecurity");
    const tc = useTranslations("common");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setError(null);
        // The methods are written first: the approval gate is the cheaper change to
        // repeat, and leaving it on while the methods were refused is the safer half
        // of the two to end up applied on its own.
        const saved = savePreferences
            ? await saveTwoFactorPreferencesAction({ preferences: { methods, preferred }, password })
            : {};
        const gated =
            saved.error || approval === null ? {} : await setLoginApprovalAction(approval, password);
        setBusy(false);
        const failure = saved.error ?? gated.error;
        if (failure) {
            setError(failure);
            return;
        }
        onDone();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("passkeys.confirmTitle")}</DialogTitle>
                    <DialogDescription>{t("methods.confirmDescription")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("dialog.currentPassword")}
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={busy}>
                            {busy ? tc("actions.saving") : tc("actions.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
