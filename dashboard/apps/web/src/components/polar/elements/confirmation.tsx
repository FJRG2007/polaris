"use client";

/**
 * Confirmation: the card a change waits on - what will happen, what it
 * touches, and that it runs as you - with the request folded under "Details".
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/confirmation.tsx at ca8be60), Apache-2.0 - see the
 * LICENSE beside this file. Changed: Tailwind 3, Polaris tokens and Button,
 * and the parts it shows by state (request, accepted, rejected) folded into one
 * component that takes the plain-language lines as props.
 */

import type { ReactNode } from "react";
import { Button, cn } from "@polaris/ui";
import { Check, ShieldAlert, UserRound, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { jsonOf, type ToolState } from "@/components/polar/elements/tool";

export interface ConfirmationApproval {
    id: string;
    approved?: boolean;
    reason?: string;
}

export function Confirmation({
    state,
    approval,
    action,
    affects,
    destructive,
    input,
    onApprove,
    onReject,
    className
}: {
    state: ToolState;
    approval: ConfirmationApproval | undefined;
    /** What will happen, in a sentence: "Send a message". */
    action: string;
    /** The values the call names, so the reader sees what it touches. */
    affects: string[];
    destructive: boolean;
    input: unknown;
    onApprove: () => void;
    onReject: () => void;
    className?: string;
}) {
    const t = useTranslations("polar");
    if (!approval || state === "input-streaming" || state === "input-available") return null;
    const requested = state === "approval-requested";
    let outcome: ReactNode = null;
    if (!requested) {
        outcome = approval.approved ? (
            <p className="inline-flex items-center gap-1 text-xs text-success-ink">
                <Check className="h-3.5 w-3.5" /> {t("approval.accepted")}
            </p>
        ) : (
            <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <X className="h-3.5 w-3.5" /> {t("approval.rejected")}
            </p>
        );
    }
    return (
        <div
            role={requested ? "alertdialog" : undefined}
            aria-label={requested ? t("approval.label") : undefined}
            className={cn("w-full space-y-2 rounded-lg border border-border bg-card p-3 text-sm", className)}
        >
            <p className="font-medium text-foreground">{t("approval.question", { action })}</p>
            {affects.length > 0 ? (
                <p className="min-w-0 text-xs text-muted-foreground">
                    <span className="text-foreground-subtle">{t("approval.affects")} </span>
                    <span className="break-words">{affects.join(", ")}</span>
                </p>
            ) : null}
            {destructive ? (
                <p className="inline-flex items-center gap-1 text-xs text-warning-ink">
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> {t("approval.destructive")}
                </p>
            ) : null}
            <p className="inline-flex items-center gap-1 text-xs text-foreground-subtle">
                <UserRound className="h-3.5 w-3.5 shrink-0" /> {t("approval.runsAsYou")}
            </p>
            <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">{t("approval.details")}</summary>
                <pre className="mt-1 max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]">
                    {jsonOf(input)}
                </pre>
            </details>
            {requested ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={onReject}>
                        {t("approval.deny")}
                    </Button>
                    <Button type="button" variant={destructive ? "danger" : "primary"} size="sm" onClick={onApprove}>
                        {t("approval.run")}
                    </Button>
                </div>
            ) : (
                outcome
            )}
        </div>
    );
}

/** Keys whose values say what a call touches, in the order they are read. */
const AFFECTS_KEYS = [
    "name",
    "title",
    "to",
    "subject",
    "channel",
    "channelId",
    "project",
    "service",
    "domain",
    "key",
    "path",
    "taskId",
    "id"
];

/** Up to three short values from a tool's input that name what it touches. */
export function affectedBy(input: unknown): string[] {
    if (!input || typeof input !== "object") return [];
    const record = input as Record<string, unknown>;
    const found: string[] = [];
    for (const key of AFFECTS_KEYS) {
        const value = record[key];
        const text = Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join(", ") : value;
        if (typeof text === "string" && text.trim()) found.push(text.trim().slice(0, 80));
        else if (typeof text === "number") found.push(String(text));
        if (found.length === 3) break;
    }
    return found;
}
