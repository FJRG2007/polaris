"use client";

/**
 * The wand beside a composer's send button, or over any field people write
 * for others: the draft rewritten before it goes (`/api/polar/improve`) - a
 * prompt made clearer, an email body or a task's text corrected, signed with
 * the writer's name, and a `{{field}}` wherever only the writer knows the
 * value. Pair it with `AiRewriting` around the field (`onBusyChange`) and
 * `FillInBar` under it.
 *
 * The rewrite replaces the draft at once, and the button turns into Undo until
 * the text is touched again, so a rewrite nobody wanted costs one press. A
 * failure leaves the draft exactly as it was and says why.
 */

import { useEffect, useRef, useState } from "react";
import type { ImprovePurpose } from "@/lib/polar/improve-draft";
import { Button, cn, useToast } from "@polaris/ui";
import { Loader2, Undo2, WandSparkles } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

export type ImproveFor = ImprovePurpose;

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
    orgId = null,
    spaceId = null,
    onBusyChange,
    disabled = false,
    size = "icon-sm",
    className
}: {
    value: string;
    onChange: (next: string) => void;
    purpose: ImproveFor;
    /** An email's subject, read as context and never rewritten. */
    subject?: string;
    /** The organization the text belongs to, whose writing guide it follows. */
    orgId?: string | null;
    /** The task space the text is written in, whose organization's guide it follows. */
    spaceId?: string | null;
    /** Told when a rewrite starts and ends, for the field's `AiRewriting`. */
    onBusyChange?: (busy: boolean) => void;
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
    // Held in a ref: only a change of `busy` is news, and the callback is the
    // caller's and changes with every render.
    const tell = useRef(onBusyChange);
    tell.current = onBusyChange;
    useEffect(() => {
        tell.current?.(busy);
    }, [busy]);

    const improve = async () => {
        if (busy || empty || disabled) return;
        const before = value;
        setBusy(true);
        try {
            const response = await fetch("/api/polar/improve", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: before, purpose, subject: subject ?? null, orgId, spaceId })
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
          : t(`improve.${purpose}`);
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
