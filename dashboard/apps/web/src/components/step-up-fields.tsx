"use client";

/**
 * The "prove it is still you" half of a destructive confirmation.
 *
 * Fields rather than a dialog of its own, so it drops into the confirmation the
 * screen already shows - typing the name of the thing and proving who you are
 * belong to one decision, and splitting them across two prompts turns a
 * deliberate act into two clicks somebody learns to get through.
 *
 * What it asks for is the account's business, not the caller's: it fetches the
 * ways this account can confirm and offers those. A picker only appears when
 * there is genuinely a choice - one way is not a decision anybody wants to be
 * shown. A way that delivers its code (email, WhatsApp, Telegram) sends it by
 * itself when the confirmation opens, once, and the button is the resend with its
 * wait (components/use-code-sending.ts) - the same as the sign-in steps.
 */

import { Loader2 } from "lucide-react";
import type { StepUpChoice } from "@/lib/step-up";
import { Button, Input, Select } from "@polaris/ui";
import type { StepUpProofInput } from "@polaris/core";
import { useEffect, useId, useRef, useState } from "react";
import { useCodeSending } from "@/components/use-code-sending";
import { sendStepUpCodeAction } from "@/app/(app)/account/step-up-actions";
import { CodeInput } from "@/components/code-input";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import * as polls from "./shared-polls";

const PROOFS = new Set(["totp", "email", "whatsapp", "sms", "telegram", "password"]);

/** How a proof is named, from its id; one this build has no words for keeps the
 *  label the service gave it. */
function proofLabel(t: NamespaceTranslator<"components">, choice: StepUpChoice): string {
    return PROOFS.has(choice.proof)
        ? t(`stepUp.proofs.${choice.proof}` as NamespaceKey<"components">)
        : choice.label;
}

export function StepUpFields({
    open,
    purpose,
    onChange,
    autoSubmit = false,
    offered,
    sendCode
}: {
    /** Drives the reset: reopening must not inherit the last attempt's code. */
    open: boolean;
    /** What the code is being minted against, e.g. `org-delete:<id>`. */
    purpose: string;
    /** The completed proof, or null while it is still incomplete. */
    onChange: (proof: StepUpProofInput | null) => void;
    /** Submit the surrounding form once a whole code is typed - only where the
     *  code is the last thing that form asks for and its submit checks the rest. */
    autoSubmit?: boolean;
    /** The ways to confirm, when the caller already knows them and they are not
     *  the account's usual step-up - recovering a forgotten password, where the
     *  password itself is no proof. Fetched from the account when left out. */
    offered?: StepUpChoice[];
    /** How a code is sent for those, when not through the usual step-up. */
    sendCode?: (method: StepUpChoice["proof"]) => Promise<{ error?: string }>;
}) {
    const t = useTranslations("components");
    const fieldId = useId();
    const [choices, setChoices] = useState<StepUpChoice[] | null>(null);
    const [proof, setProof] = useState<StepUpChoice | null>(null);
    const [value, setValue] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        setValue("");
        setError("");
        if (offered) {
            setChoices(offered);
            setProof(offered[0] ?? null);
            return;
        }
        let live = true;
        void polls
            .stepUpOptions()
            .then((result) => {
                if (!live) return;
                setChoices(result.choices);
                setProof(result.choices[0] ?? null);
            })
            .catch(() => live && setError(t("stepUp.optionsFailed")));
        return () => {
            live = false;
        };
    }, [open]);

    // Held in a ref and left out of the effect below: a caller that passes an
    // inline arrow - which every caller does - would otherwise hand this a new
    // function on every render and the effect would re-run forever.
    const report = useRef(onChange);
    report.current = onChange;

    // Reported up rather than read down, so the confirm button belongs to the
    // dialog and this stays a field group. Incomplete is null, which is what
    // keeps the button off until there is something worth checking.
    useEffect(() => {
        const typed = value.trim();
        if (!proof) {
            report.current(null);
        } else if (proof.proof === "password") {
            report.current(typed ? { proof: "password", password: typed } : null);
        } else {
            report.current(/^\d{6}$/.test(typed) ? { proof: proof.proof, code: typed } : null);
        }
    }, [proof, value]);

    // Before the early return below: a hook may not be skipped on a render.
    const sending = useCodeSending({
        scope: open && proof?.sends ? `step-up:${purpose}:${proof.proof}` : null,
        auto: true,
        send: async () => {
            if (!proof?.sends) return { error: "" };
            const result = sendCode ? await sendCode(proof.proof) : await sendStepUpCodeAction(purpose, proof.proof);
            return result.error ? { error: result.error } : {};
        }
    });

    if (!choices) {
        return (
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
                <Loader2 className="size-3.5 shrink-0 animate-spin" /> {t("stepUp.working")}
            </p>
        );
    }

    const sent = sending.sent
        ? proof?.target
            ? t("stepUp.sentTo", { target: proof.target })
            : t("stepUp.sent")
        : "";
    const shownError = error || sending.error;
    const password = proof?.proof === "password";

    return (
        <div className="flex flex-col gap-2">
            {choices.length > 1 && (
                <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                    {t("stepUp.confirmWith")}
                    <Select
                        value={proof?.proof ?? ""}
                        className="h-9"
                        aria-label={t("stepUp.how")}
                        options={choices.map((choice) => ({
                            value: choice.proof,
                            label: proofLabel(t, choice)
                        }))}
                        onValueChange={(next) => {
                            setProof(choices.find((choice) => choice.proof === next) ?? null);
                            setValue("");
                            setError("");
                        }}
                    />
                </label>
            )}

            <label className="text-muted-foreground flex flex-col gap-1 text-xs" htmlFor={fieldId}>
                {proof ? proofLabel(t, proof) : t("stepUp.confirm")}
                {password ? (
                    <Input
                        id={fieldId}
                        value={value}
                        className="h-9"
                        autoComplete="current-password"
                        type="password"
                        autoFocus
                        placeholder={t("stepUp.proofs.password")}
                        onChange={(event) => setValue(event.target.value)}
                    />
                ) : (
                    <CodeInput
                        id={fieldId}
                        value={value}
                        className="h-9"
                        autoSubmit={autoSubmit}
                        placeholder={t("stepUp.codePlaceholder")}
                        onValueChange={setValue}
                    />
                )}
            </label>

            {proof?.sends && (
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full"
                    disabled={sending.sending || sending.cooldown > 0}
                    onClick={sending.resend}
                >
                    {sending.sending ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                    {sending.sending
                        ? t("stepUp.sending")
                        : sending.cooldown > 0
                          ? t("stepUp.sendAgainIn", { seconds: sending.cooldown })
                          : sent
                            ? t("stepUp.resend")
                            : t("stepUp.send")}
                </Button>
            )}

            {sent && !shownError && <p className="text-muted-foreground text-xs">{sent}</p>}
            {shownError && <p className="text-danger text-xs">{shownError}</p>}
        </div>
    );
}
