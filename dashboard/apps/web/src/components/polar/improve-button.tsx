"use client";

/**
 * The wand beside a composer's send button: the draft rewritten by Polar's
 * helper model before it goes (`/api/polar/improve`) - a prompt made clearer,
 * an email body corrected.
 *
 * The rewrite replaces the draft at once, and the button turns into Undo until
 * the text is touched again, so a rewrite nobody wanted costs one press. A
 * failure leaves the draft exactly as it was and says why.
 */

import { useState } from "react";
import { Button, cn, useToast } from "@polaris/ui";
import { Loader2, Undo2, WandSparkles } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

export type ImproveFor = "prompt" | "email";

interface Rewrite {
    /** The draft before the rewrite, for Undo. */
    before: string;
    /** The rewrite as it was put in, so a later edit retires Undo. */
    after: string;
}

export function ImproveButton({
    value,
    onChange,
    purpose,
    subject,
    disabled = false,
    size = "icon-sm",
    className
}: {
    value: string;
    onChange: (next: string) => void;
    purpose: ImproveFor;
    /** An email's subject, read as context and never rewritten. */
    subject?: string;
    disabled?: boolean;
    size?: "icon-sm" | "icon";
    className?: string;
}) {
    const t = useTranslations("components");
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const [rewrite, setRewrite] = useState<Rewrite | null>(null);
    const undoable = rewrite !== null && rewrite.after === value;
    const empty = !value.trim();

    const improve = async () => {
        if (busy || empty || disabled) return;
        const before = value;
        setBusy(true);
        try {
            const response = await fetch("/api/polar/improve", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: before, purpose, subject: subject ?? null })
            });
            const answer = (await response.json().catch(() => null)) as {
                text?: string;
                error?: string;
            } | null;
            if (!response.ok || typeof answer?.text !== "string") {
                toast.show({ title: refusalText(answer?.error) });
                return;
            }
            setRewrite({ before, after: answer.text });
            onChange(answer.text);
        } catch {
            toast.show({ title: t("improve.failed") });
        } finally {
            setBusy(false);
        }
    };

    function refusalText(error: string | undefined): string {
        if (error === "no_model") return t("improve.noModel");
        if (error === "limit") return t("improve.limit");
        if (error === "rate_limited") return t("improve.rateLimited");
        if (error === "polar_not_allowed") return t("improve.notAllowed");
        return t("improve.failed");
    }

    if (undoable) {
        return (
            <Button
                type="button"
                variant="ghost"
                size={size}
                aria-label={t("improve.undo")}
                title={t("improve.undo")}
                className={className}
                onClick={() => {
                    onChange(rewrite.before);
                    setRewrite(null);
                }}
            >
                <Undo2 className="size-4 shrink-0" aria-hidden />
            </Button>
        );
    }

    const label = busy
        ? t("improve.working")
        : empty
          ? t("improve.empty")
          : purpose === "email"
            ? t("improve.email")
            : t("improve.prompt");
    return (
        <Button
            type="button"
            variant="ghost"
            size={size}
            aria-label={label}
            title={label}
            // aria-disabled, so the reason stays readable on hover and focus.
            aria-disabled={busy || empty || disabled}
            aria-busy={busy}
            className={cn((empty || disabled) && "opacity-50", className)}
            onClick={() => void improve()}
        >
            {busy ? (
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
            ) : (
                <WandSparkles className="size-4 shrink-0" aria-hidden />
            )}
        </Button>
    );
}
