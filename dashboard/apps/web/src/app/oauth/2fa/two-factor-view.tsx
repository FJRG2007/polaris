"use client";

/**
 * The challenge itself. Every method ends in a six-digit code, so the form is one
 * field either way; what changes is where the code comes from and which endpoint
 * checks it - the authenticator's own, or the one better-auth stores a sent code
 * against.
 *
 * Backup codes share the screen because the moment a user needs one is the moment
 * they cannot reach their authenticator, and sending them elsewhere to find it
 * would be exactly the wrong time.
 */

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { abandonChallengeAction } from "./actions";
import { KeyRound, Mail, Smartphone } from "lucide-react";
import { WhatsAppLogo } from "@/app/(app)/admin/inbox/channel-logos";
import type { ChallengeOptions } from "@/lib/two-factor-delivery";
import { useEffect, useState, type ComponentType, type FormEvent } from "react";
import { Button, Card, CardBody, CardHeader, CardTitle, Checkbox, Input, PolarisMark } from "@polaris/ui";
import {
    TWO_FACTOR_METHOD_HEADER,
    TWO_FACTOR_METHOD_INFO,
    type TwoFactorMethod
} from "@polaris/core";

/** Post-verification destination: a safe same-origin redirect, else the drive. */
function target(): string {
    const redirect = new URLSearchParams(window.location.search).get("redirect");
    return redirect && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
}

const METHOD_ICON: Record<TwoFactorMethod, ComponentType<{ className?: string }>> = {
    totp: Smartphone,
    email: Mail,
    whatsapp: WhatsAppLogo
};

/** How long the resend button stays quiet, so a code that is simply slow does not
 *  get asked for four more times before the first one lands. */
const RESEND_COOLDOWN_SECONDS = 30;

export function TwoFactorView({ options }: { options: ChallengeOptions }) {
    const router = useRouter();
    const [method, setMethod] = useState<TwoFactorMethod>(options.preferred ?? "totp");
    const [backup, setBackup] = useState(false);
    const [trustDevice, setTrustDevice] = useState(false);
    const [sent, setSent] = useState<string | null>(null);
    const [cooldown, setCooldown] = useState(0);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (cooldown <= 0) return;
        const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
        return () => clearTimeout(timer);
    }, [cooldown]);

    /** Only the sent-code methods need a round trip before the field is useful. */
    const needsSending = !backup && method !== "totp";
    const entry = options.methods.find((option) => option.method === method);

    async function send() {
        setPending(true);
        setError(null);
        const { error: sendError } = await authClient.twoFactor.sendOtp({
            fetchOptions: { headers: { [TWO_FACTOR_METHOD_HEADER]: method } }
        });
        setPending(false);
        if (sendError) {
            setError("Could not send a code. Try another way.");
            return;
        }
        setCooldown(RESEND_COOLDOWN_SECONDS);
        setSent(entry?.target ? `Code sent to ${entry.target}.` : "Code sent.");
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
        setPending(true);
        setError(null);
        const { error: verifyError } = backup
            ? await authClient.twoFactor.verifyBackupCode({ code })
            : method === "totp"
              ? await authClient.twoFactor.verifyTotp({ code, trustDevice })
              : await authClient.twoFactor.verifyOtp({ code, trustDevice });
        setPending(false);
        if (verifyError) {
            setError(backup ? "That backup code is not valid." : "That code is not valid.");
            return;
        }
        router.push(target());
        router.refresh();
    }

    function choose(next: TwoFactorMethod) {
        setMethod(next);
        setBackup(false);
        setSent(null);
        setError(null);
    }

    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>Two-step verification</CardTitle>
                </CardHeader>
                <CardBody>
                    {options.methods.length > 1 && !backup ? (
                        <div className="mb-4 flex flex-col gap-1">
                            {options.methods.map((option) => {
                                const info = TWO_FACTOR_METHOD_INFO[option.method];
                                const Icon = METHOD_ICON[option.method];
                                const active = option.method === method;
                                return (
                                    <button
                                        key={option.method}
                                        type="button"
                                        onClick={() => choose(option.method)}
                                        aria-pressed={active}
                                        className={`flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition ${
                                            active
                                                ? "border-primary bg-primary/5"
                                                : "border-border hover:bg-muted/40"
                                        }`}
                                    >
                                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0">
                                            <span className="block">{info.label}</span>
                                            <span className="block truncate text-xs text-muted-foreground">
                                                {option.target ?? info.description}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}

                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        {needsSending ? (
                            <Button type="button" variant="outline" disabled={pending || cooldown > 0} onClick={() => void send()}>
                                {cooldown > 0 ? `Send again in ${cooldown}s` : sent ? "Send again" : "Send a code"}
                            </Button>
                        ) : null}
                        {sent ? <p className="text-sm text-success">{sent}</p> : null}
                        <label className="flex flex-col gap-1 text-sm">
                            {backup
                                ? "Backup code"
                                : method === "totp"
                                  ? "Code from your authenticator"
                                  : "Code we sent you"}
                            <Input
                                name="code"
                                autoFocus
                                autoComplete="one-time-code"
                                inputMode={backup ? "text" : "numeric"}
                                placeholder={backup ? "XXXXXXXX" : "000000"}
                                required
                            />
                        </label>
                        {backup ? null : (
                            <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    checked={trustDevice}
                                    onChange={(event) => setTrustDevice(event.target.checked)}
                                />
                                Trust this device for 30 days
                            </label>
                        )}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending}>
                            {pending ? "Verifying..." : "Verify"}
                        </Button>
                    </form>

                    <button
                        type="button"
                        className="mt-4 flex w-full items-center justify-center gap-1 text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onClick={() => {
                            setBackup(!backup);
                            setSent(null);
                            setError(null);
                        }}
                    >
                        <KeyRound className="size-3" />
                        {backup ? "Go back to your usual method" : "Use a backup code instead"}
                    </button>

                    {/* The way out. Without it the sign-in page keeps resuming this
                        challenge, so somebody who cannot finish it - wrong account,
                        no authenticator to hand - would be stuck here until it
                        expired. */}
                    <button
                        type="button"
                        disabled={pending}
                        className="mt-2 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onClick={() => void abandonChallengeAction()}
                    >
                        Sign in as someone else
                    </button>
                </CardBody>
            </Card>
        </main>
    );
}
