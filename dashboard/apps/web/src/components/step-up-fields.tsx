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
 * shown - and the code field is disabled until a code has actually been sent, so
 * nobody sits typing into a box waiting for a message that was never asked for.
 */

import { Loader2, Send } from "lucide-react";
import type { StepUpChoice } from "@/lib/step-up";
import { Button, Input, Select } from "@polaris/ui";
import type { StepUpProofInput } from "@polaris/core";
import { useEffect, useId, useRef, useState } from "react";
import { sendStepUpCodeAction, stepUpOptionsAction } from "@/app/(app)/account/step-up-actions";

export function StepUpFields({
    open,
    purpose,
    onChange
}: {
    /** Drives the reset: reopening must not inherit the last attempt's code. */
    open: boolean;
    /** What the code is being minted against, e.g. `org-delete:<id>`. */
    purpose: string;
    /** The completed proof, or null while it is still incomplete. */
    onChange: (proof: StepUpProofInput | null) => void;
}) {
    const fieldId = useId();
    const [choices, setChoices] = useState<StepUpChoice[] | null>(null);
    const [proof, setProof] = useState<StepUpChoice | null>(null);
    const [value, setValue] = useState("");
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        setValue("");
        setSent("");
        setError("");
        let live = true;
        void stepUpOptionsAction()
            .then((result) => {
                if (!live) return;
                setChoices(result.choices);
                setProof(result.choices[0] ?? null);
            })
            .catch(() => live && setError("Could not work out how to confirm this."));
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

    if (!choices) {
        return (
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
                <Loader2 className="size-3.5 shrink-0 animate-spin" /> Working out how to confirm this
            </p>
        );
    }

    const send = async () => {
        if (!proof?.sends) return;
        setSending(true);
        setError("");
        const result = await sendStepUpCodeAction(purpose, proof.proof);
        setSending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setSent(proof.target ? `Code sent to ${proof.target}.` : "Code sent.");
    };

    return (
        <div className="flex flex-col gap-2">
            {choices.length > 1 && (
                <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                    Confirm with
                    <Select
                        value={proof?.proof ?? ""}
                        className="h-9"
                        aria-label="How to confirm"
                        options={choices.map((choice) => ({ value: choice.proof, label: choice.label }))}
                        onValueChange={(next) => {
                            setProof(choices.find((choice) => choice.proof === next) ?? null);
                            setValue("");
                            setSent("");
                            setError("");
                        }}
                    />
                </label>
            )}

            <label className="text-muted-foreground flex flex-col gap-1 text-xs" htmlFor={fieldId}>
                {proof?.label ?? "Confirm"}
                <div className="flex items-center gap-2">
                    <Input
                        id={fieldId}
                        value={value}
                        className="h-9"
                        autoComplete={proof?.proof === "password" ? "current-password" : "one-time-code"}
                        type={proof?.proof === "password" ? "password" : "text"}
                        inputMode={proof?.proof === "password" ? undefined : "numeric"}
                        maxLength={proof?.proof === "password" ? undefined : 6}
                        placeholder={proof?.proof === "password" ? "Your password" : "6-digit code"}
                        disabled={Boolean(proof?.sends) && !sent}
                        onChange={(event) => setValue(event.target.value)}
                    />
                    {proof?.sends && (
                        <Button type="button" size="sm" variant="secondary" disabled={sending} onClick={() => void send()}>
                            {sending ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Send className="size-4 shrink-0" />}
                            {sent ? "Resend" : "Send code"}
                        </Button>
                    )}
                </div>
            </label>

            {sent && !error && <p className="text-muted-foreground text-xs">{sent}</p>}
            {error && <p className="text-danger text-xs">{error}</p>}
        </div>
    );
}
