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
 *
 * "Always allow" follows the connector permissions Claude and ChatGPT offer
 * per tool: the answer is stored on the server and read by the chat's own
 * loop, never by this card. For a tool that can destroy, the card says plainly
 * that it will stop asking - and for which one thing - before it is chosen.
 */

import { Button, cn } from "@polaris/ui";
import { JsonView } from "@/components/json-view";
import { useEffect, useState, type ReactNode } from "react";
import { Check, ShieldAlert, UserRound, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { jsonOf, type ToolState } from "@/components/polar/elements/tool";

export interface ConfirmationApproval {
    id: string;
    approved?: boolean;
    reason?: string;
}

/** What the server read a call as: the thing it acts on, and what a grant covers. */
interface CallTarget {
    target: { name: string; action: string | null } | null;
    scope: "target" | "tool";
}

/** Asks the server what a call acts on, or stores "Always allow" for it. */
async function askGrants(tool: string, input: unknown, allow: boolean): Promise<CallTarget> {
    const response = await fetch("/api/polar/tool-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, input, allow })
    });
    if (!response.ok) throw new Error(`tool-grants ${response.status}`);
    return (await response.json()) as CallTarget;
}

/** "Unlatch Studio door", or "Operate a device: Studio door" with no verb. */
export function callSummary(action: string, target: CallTarget["target"]): string | null {
    if (!target) return null;
    if (!target.action) return `${action}: ${target.name}`;
    return `${target.action.charAt(0).toUpperCase()}${target.action.slice(1)} ${target.name}`;
}

export function Confirmation({
    state,
    approval,
    action,
    affects,
    destructive,
    input,
    tool,
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
    /** The tool's name. Given, the card offers "Always allow" and names the
     *  call's target as the server reads it. */
    tool?: string;
    onApprove: () => void;
    onReject: () => void;
    className?: string;
}) {
    const t = useTranslations("polar");
    const requested = state === "approval-requested";
    const asking = requested && !!tool && !!approval;
    const inputJson = jsonOf(input);
    const [read, setRead] = useState<CallTarget | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState(false);

    // The target's name, read as this person on the server. The card already
    // shows the raw id, so a failure here only leaves it at that.
    useEffect(() => {
        if (!asking || !tool) return;
        let live = true;
        askGrants(tool, input, false)
            .then((found) => {
                if (live) setRead(found);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
        // Keyed by the input as text: a re-render hands a new object for the
        // same call, and asking again for it would be a wasted round trip.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [asking, tool, inputJson]);

    if (!approval || state === "input-streaming" || state === "input-available") return null;
    const summary = callSummary(action, read?.target ?? null);
    const scopeName = read?.scope === "target" && read.target ? read.target.name : null;
    const alwaysText = scopeName
        ? t("approval.alwaysTarget", { target: scopeName })
        : t("approval.alwaysTool", { action });

    async function alwaysAllow() {
        if (!tool) return;
        setSaving(true);
        setFailed(false);
        try {
            await askGrants(tool, input, true);
            onApprove();
        } catch {
            setFailed(true);
        } finally {
            setSaving(false);
        }
    }

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
            className={cn(
                "w-full space-y-2 rounded-lg border border-border bg-card p-3 text-sm",
                className
            )}
        >
            <p className="font-medium text-foreground">{t("approval.question", { action })}</p>
            {summary ? (
                <p className="min-w-0 break-words text-sm text-foreground">{summary}</p>
            ) : affects.length > 0 ? (
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
                <JsonView
                    value={inputJson}
                    className="mt-1 max-h-40"
                    label={t("approval.details")}
                />
            </details>
            {requested && confirming ? (
                <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2 text-xs">
                    <p className="text-foreground">
                        {alwaysText} {t("approval.alwaysRevoke")}
                    </p>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirming(false)}
                        >
                            {t("approval.alwaysBack")}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            disabled={saving}
                            onClick={() => void alwaysAllow()}
                        >
                            {t("approval.alwaysConfirm")}
                        </Button>
                    </div>
                </div>
            ) : null}
            {requested && failed ? (
                <p role="alert" className="text-xs text-danger">
                    {t("approval.alwaysFailed")}
                </p>
            ) : null}
            {requested && !confirming ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={onReject}>
                        {t("approval.deny")}
                    </Button>
                    {asking ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={saving}
                            title={`${alwaysText} ${t("approval.alwaysRevoke")}`}
                            onClick={() => (destructive ? setConfirming(true) : void alwaysAllow())}
                        >
                            {t("approval.always")}
                        </Button>
                    ) : null}
                    <Button
                        type="button"
                        variant={destructive ? "danger" : "primary"}
                        size="sm"
                        onClick={onApprove}
                    >
                        {t("approval.run")}
                    </Button>
                </div>
            ) : null}
            {outcome}
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
        const text = Array.isArray(value)
            ? value.filter((entry) => typeof entry === "string").join(", ")
            : value;
        if (typeof text === "string" && text.trim()) found.push(text.trim().slice(0, 80));
        else if (typeof text === "number") found.push(String(text));
        if (found.length === 3) break;
    }
    return found;
}
