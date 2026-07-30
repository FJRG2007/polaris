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
 * which is why the card is shown either way.
 *
 * A method that cannot deliver right now says why instead of being hidden, so a
 * missing channel reads as something to fix rather than as a feature that never
 * existed. Saving asks for the password: every switch here widens or narrows the
 * ways in.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
    TWO_FACTOR_DELIVERY_METHODS,
    TWO_FACTOR_METHOD_INFO,
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
import type { TwoFactorMethodStatus } from "@/lib/two-factor-delivery";
import { setLoginApprovalAction } from "./actions";
import { saveTwoFactorPreferencesAction } from "./two-factor-actions";
import { Feedback } from "./setting-card";

/** What the sign-in approval gate can do for this account right now. */
export interface LoginApprovalStatus {
    enabled: boolean;
    hasPin: boolean;
    /** Open sessions other than this one, which is what an approval is decided from. */
    otherSessions: number;
}

export function TwoFactorMethodsCard({
    statuses,
    preferred,
    twoFactorEnabled,
    approval
}: {
    statuses: TwoFactorMethodStatus[];
    preferred: TwoFactorMethod;
    twoFactorEnabled: boolean;
    approval: LoginApprovalStatus;
}) {
    const router = useRouter();
    const [methods, setMethods] = useState<TwoFactorDeliveryMethod[]>(
        TWO_FACTOR_DELIVERY_METHODS.filter(
            (method) => statuses.find((status) => status.method === method)?.enabled === true
        )
    );
    const [choice, setChoice] = useState<TwoFactorMethod>(preferred);
    const [approve, setApprove] = useState(approval.enabled);
    const [confirming, setConfirming] = useState(false);

    const savedMethods = TWO_FACTOR_DELIVERY_METHODS.filter(
        (method) => statuses.find((status) => status.method === method)?.enabled === true
    );
    const preferencesChanged =
        choice !== preferred ||
        methods.length !== savedMethods.length ||
        savedMethods.some((method) => !methods.includes(method));
    const changed = preferencesChanged || approve !== approval.enabled;

    /** Only the authenticator and the methods that are on can be the default; a
     *  default nobody can use would just be a slower way to reach the fallback. */
    const preferrable: TwoFactorMethod[] = ["totp", ...methods];

    function toggle(method: TwoFactorDeliveryMethod, next: boolean) {
        const updated = next ? [...methods, method] : methods.filter((entry) => entry !== method);
        setMethods(updated);
        if (!next && choice === method) setChoice("totp");
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">How you finish signing in</h2>
                    <p className="text-xs text-muted-foreground">
                        After your password, pick what else the account asks for.
                    </p>
                </div>

                <div className="overflow-hidden rounded-md border border-border">
                    {statuses.map((status) => {
                        const info = TWO_FACTOR_METHOD_INFO[status.method];
                        const isAuthenticator = status.method === "totp";
                        const on = isAuthenticator || methods.includes(status.method as TwoFactorDeliveryMethod);
                        return (
                            <div
                                key={status.method}
                                className="flex items-start justify-between gap-3 border-t border-border px-3 py-2 first:border-t-0"
                            >
                                <div className="min-w-0">
                                    <p className="text-sm">{info.label}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {status.target ?? info.description}
                                    </p>
                                    {status.blocker ? (
                                        <p className="text-xs text-warning">{status.blocker}</p>
                                    ) : null}
                                </div>
                                {isAuthenticator ? (
                                    <span className="shrink-0 text-xs text-muted-foreground">Always on</span>
                                ) : (
                                    <Switch
                                        checked={on}
                                        disabled={!twoFactorEnabled || (!status.available && !on)}
                                        aria-label={`Use ${info.label}`}
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
                            <p className="text-sm">Approve from an open session</p>
                            <p className="text-xs text-muted-foreground">
                                A new sign-in waits until you allow it with your PIN from a session
                                that is already open.
                            </p>
                            {!approval.hasPin ? (
                                <p className="text-xs text-warning">
                                    Set a quick unlock PIN first - allowing a sign-in asks for it.
                                </p>
                            ) : (
                                <Link
                                    href="/account/sessions"
                                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                                >
                                    {approval.otherSessions === 0
                                        ? "No other session open - you would approve from this one."
                                        : `${approval.otherSessions} other session${approval.otherSessions === 1 ? "" : "s"} open.`}
                                </Link>
                            )}
                        </div>
                        <Switch
                            checked={approve}
                            disabled={!approval.hasPin && !approve}
                            aria-label="Require approval for new sign-ins"
                            onChange={setApprove}
                        />
                    </div>
                </div>

                {twoFactorEnabled ? (
                    <label className="flex flex-col gap-1 text-sm">
                        Offer first
                        <Select
                            value={choice}
                            onValueChange={(value) => setChoice(value as TwoFactorMethod)}
                            options={preferrable.map((method) => ({
                                value: method,
                                label: TWO_FACTOR_METHOD_INFO[method].label
                            }))}
                        />
                    </label>
                ) : null}

                <p className="text-xs text-muted-foreground">
                    Text messages are not offered. An SMS can be read off a locked screen and
                    redirected by anyone who can talk a carrier into moving the number, so it is a
                    weaker proof than the rest of this list.
                </p>

                <div className="flex justify-end">
                    <Button disabled={!changed} onClick={() => setConfirming(true)}>
                        Save
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
                    <DialogTitle>Confirm your password</DialogTitle>
                    <DialogDescription>
                        Changing which methods your account accepts changes how it can be reached.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Current password
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy}>
                            {busy ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
