"use client";

/**
 * "Sign in with your phone": no password, the account's Polaris app approves.
 *
 * Drawn only for an account whose phone can answer (`phoneSignInOffered`). It
 * shows the request's number, which the phone has to pick among three, and
 * waits; the password form stays one press away the whole time, so a phone that
 * is off, flat or lost never leaves the screen without a way in.
 */

import { Button } from "@polaris/ui";
import { BellRing } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    cancelPhoneSignInAction,
    phoneSignInStatusAction,
    startPhoneSignInAction
} from "./phone-sign-in-actions";

const POLL_MS = 2_000;

export function PhoneSignIn({
    identifier,
    disabled,
    onSignedIn,
    onSsoRequired
}: {
    identifier: string;
    disabled: boolean;
    onSignedIn: () => void;
    onSsoRequired: () => void;
}) {
    const t = useTranslations("auth");
    const [phase, setPhase] = useState<"idle" | "asking" | "waiting" | "done">("idle");
    const [approvalId, setApprovalId] = useState<string | null>(null);
    const [matchNumber, setMatchNumber] = useState<number | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const signedIn = useRef(onSignedIn);
    const ssoRequired = useRef(onSsoRequired);
    signedIn.current = onSignedIn;
    ssoRequired.current = onSsoRequired;

    useEffect(() => {
        if (phase !== "waiting" || !approvalId) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        async function poll() {
            const status = await phoneSignInStatusAction(approvalId).catch(() => ({ state: "pending" as const }));
            if (stopped) return;
            if (status.state === "pending") {
                timer = setTimeout(() => void poll(), POLL_MS);
                return;
            }
            setApprovalId(null);
            if (status.state === "approved") {
                setPhase("done");
                signedIn.current();
                return;
            }
            setPhase("idle");
            if (status.state === "refused" && status.reason === "sso") {
                ssoRequired.current();
                return;
            }
            setMessage(
                status.state === "denied"
                    ? t(status.reason === "mismatch" ? "twoFactor.phoneMismatch" : "twoFactor.phoneDenied")
                    : status.state === "refused"
                      ? t("login.phoneFailed")
                      : t("twoFactor.phoneExpired")
            );
        }
        timer = setTimeout(() => void poll(), POLL_MS);
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [phase, approvalId, t]);

    async function ask() {
        setPhase("asking");
        setMessage(null);
        const result = await startPhoneSignInAction(identifier).catch(() => null);
        if (!result || !result.ok) {
            setPhase("idle");
            setMessage(result?.reason === "tooMany" ? t("twoFactor.phoneTooMany") : t("login.phoneUnavailable"));
            return;
        }
        setApprovalId(result.id);
        setMatchNumber(result.matchNumber);
        setPhase("waiting");
    }

    function cancel() {
        setPhase("idle");
        setApprovalId(null);
        void cancelPhoneSignInAction().catch(() => undefined);
    }

    if (phase === "waiting" || phase === "done") {
        return (
            <div className="flex flex-col items-center gap-2 text-center" role="status" aria-live="polite">
                <BellRing className="size-5 shrink-0 text-primary" aria-hidden />
                <p className="text-sm">{t("twoFactor.phoneWaiting")}</p>
                {matchNumber !== null ? (
                    <>
                        <p className="text-xs text-muted-foreground">{t("twoFactor.phonePick")}</p>
                        <p
                            className="font-mono text-4xl font-semibold tabular-nums"
                            aria-label={t("twoFactor.phoneNumberLabel", { number: matchNumber })}
                        >
                            {matchNumber}
                        </p>
                    </>
                ) : null}
                {phase === "waiting" ? (
                    <button
                        type="button"
                        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onClick={cancel}
                    >
                        {t("login.phoneCancel")}
                    </button>
                ) : null}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <Button type="button" variant="secondary" disabled={disabled || phase === "asking"} onClick={() => void ask()}>
                <BellRing className="size-4 shrink-0" aria-hidden />
                {t("login.phone")}
            </Button>
            {message ? <p className="text-center text-sm text-danger">{message}</p> : null}
        </div>
    );
}
