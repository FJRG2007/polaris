"use client";

/**
 * "Approve from your phone": asks the account's Polaris app, then waits.
 *
 * The phone answers on its own screen; this only polls how the request stands.
 * It shows the request's number, which the phone has to pick among three - so
 * an approval only ever comes from somebody looking at this screen.
 * An approval arrives as a one-time code for this browser's challenge, which the
 * caller spends through the usual verify step, so signing in finishes the same
 * way whichever method was used.
 */

import { Button } from "@polaris/ui";
import { BellRing } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { phoneApprovalStatusAction, requestPhoneApprovalAction } from "./phone-approval-actions";

const POLL_MS = 2_000;

type Phase = "idle" | "asking" | "waiting";

export function PhoneApproval({
    disabled,
    onApproved
}: {
    disabled: boolean;
    onApproved: (code: string) => Promise<boolean>;
}) {
    const t = useTranslations("auth");
    const [phase, setPhase] = useState<Phase>("idle");
    const [approvalId, setApprovalId] = useState<string | null>(null);
    const [matchNumber, setMatchNumber] = useState<number | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const finishing = useRef(false);

    useEffect(() => {
        if (phase !== "waiting" || !approvalId) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        async function poll() {
            const status = await phoneApprovalStatusAction(approvalId).catch(() => ({ state: "pending" as const }));
            if (stopped) return;
            if (status.state === "pending") {
                timer = setTimeout(() => void poll(), POLL_MS);
                return;
            }
            setPhase("idle");
            setApprovalId(null);
            if (status.state === "approved") {
                if (finishing.current) return;
                finishing.current = true;
                const signedIn = await onApproved(status.code);
                finishing.current = false;
                if (!signedIn) setMessage(t("twoFactor.phoneExpired"));
                return;
            }
            setMessage(
                status.state === "denied"
                    ? t(status.reason === "mismatch" ? "twoFactor.phoneMismatch" : "twoFactor.phoneDenied")
                    : t("twoFactor.phoneExpired")
            );
        }
        timer = setTimeout(() => void poll(), POLL_MS);
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [phase, approvalId, onApproved, t]);

    async function ask() {
        setPhase("asking");
        setMessage(null);
        const result = await requestPhoneApprovalAction().catch(() => null);
        if (!result || !result.ok) {
            setPhase("idle");
            setMessage(
                result?.reason === "tooMany" ? t("twoFactor.phoneTooMany") : t("twoFactor.phoneUnavailable")
            );
            return;
        }
        setApprovalId(result.id);
        setMatchNumber(result.matchNumber);
        setPhase("waiting");
    }

    if (phase === "waiting") {
        return (
            <div className="mb-4 flex flex-col items-center gap-2 text-center" role="status" aria-live="polite">
                <BellRing className="size-5 shrink-0 text-primary" />
                <p className="text-sm">{t("twoFactor.phoneWaiting")}</p>
                {matchNumber !== null ? (
                    <>
                        <p className="text-xs text-muted-foreground">{t("twoFactor.phonePick")}</p>
                        <p className="font-mono text-4xl font-semibold tabular-nums" aria-label={t("twoFactor.phoneNumberLabel", { number: matchNumber })}>
                            {matchNumber}
                        </p>
                    </>
                ) : null}
                <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => {
                        setPhase("idle");
                        setApprovalId(null);
                    }}
                >
                    {t("twoFactor.phoneCancel")}
                </button>
            </div>
        );
    }

    return (
        <div className="mb-4 flex flex-col gap-2">
            <Button type="button" variant="outline" disabled={disabled || phase === "asking"} onClick={() => void ask()}>
                <BellRing className="size-4 shrink-0" />
                {t("twoFactor.phoneApprove")}
            </Button>
            {message ? <p className="text-sm text-danger">{message}</p> : null}
        </div>
    );
}
