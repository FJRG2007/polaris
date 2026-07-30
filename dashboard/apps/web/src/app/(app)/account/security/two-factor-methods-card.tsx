"use client";

/**
 * Which ways the account will accept as its second factor, and which one the
 * challenge offers first.
 *
 * The authenticator is listed but not switchable: it is what arms the factor,
 * and it is the only method that keeps working when a mail channel is removed or
 * the messaging bridge goes down. Turning it into a choice would let somebody
 * make the deployment's health the thing standing between them and their account.
 *
 * A method that cannot deliver right now says why instead of being hidden, so a
 * missing channel reads as something to fix rather than as a feature that never
 * existed. Saving asks for the password: every switch here widens or narrows the
 * ways in.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
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
import { saveTwoFactorPreferencesAction } from "./two-factor-actions";
import { Feedback } from "./setting-card";

export function TwoFactorMethodsCard({
    statuses,
    preferred
}: {
    statuses: TwoFactorMethodStatus[];
    preferred: TwoFactorMethod;
}) {
    const router = useRouter();
    const [methods, setMethods] = useState<TwoFactorDeliveryMethod[]>(
        TWO_FACTOR_DELIVERY_METHODS.filter(
            (method) => statuses.find((status) => status.method === method)?.enabled === true
        )
    );
    const [choice, setChoice] = useState<TwoFactorMethod>(preferred);
    const [confirming, setConfirming] = useState(false);

    const savedMethods = TWO_FACTOR_DELIVERY_METHODS.filter(
        (method) => statuses.find((status) => status.method === method)?.enabled === true
    );
    const changed =
        choice !== preferred ||
        methods.length !== savedMethods.length ||
        savedMethods.some((method) => !methods.includes(method));

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
                        After your password, Polaris asks for a code. Pick where it can come from.
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
                                        disabled={!status.available && !on}
                                        aria-label={`Use ${info.label}`}
                                        onChange={(next) =>
                                            toggle(status.method as TwoFactorDeliveryMethod, next)
                                        }
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>

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
    onOpenChange,
    onDone
}: {
    open: boolean;
    methods: TwoFactorDeliveryMethod[];
    preferred: TwoFactorMethod;
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
        const result = await saveTwoFactorPreferencesAction({
            preferences: { methods, preferred },
            password
        });
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
