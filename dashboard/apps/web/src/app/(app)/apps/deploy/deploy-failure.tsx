"use client";

/**
 * Why a deployment did not go live, wherever that deployment is on screen.
 *
 * The reason is stored in English; the fixed ones are said here in the reader's
 * language, and a builder's own message is shown as it was written.
 */

import { Button, cn } from "@polaris/ui";
import { CircleAlert, Loader2, RotateCw } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { deployFailureReason, type DeployFailureReason } from "@/lib/deploy/failure-reason";

type Words = ReturnType<typeof useTranslations>;

function reasonText(reason: DeployFailureReason, t: Words): string {
    switch (reason.kind) {
        case "restarted":
            return t("failure.restarted");
        case "canceled":
            return t("failure.canceled");
        case "timedOut":
            return t("failure.timedOut", { minutes: reason.minutes });
        case "noReason":
            return t("failure.noReason");
        case "text":
            return reason.text;
    }
}

/** One line of it, for a row in a list. Nothing when the deployment did not fail. */
export function DeployFailureLine({
    status,
    error,
    className
}: {
    status: string;
    error: string | null;
    className?: string;
}) {
    const t = useTranslations("deployService");
    const reason = deployFailureReason(status, error);
    if (!reason) return null;
    const text = reasonText(reason, t);
    const line =
        text
            .split(/\r?\n/)
            .map((part) => part.trim())
            .find((part) => part.length > 0) ?? text;
    return (
        <p
            title={line}
            className={cn(
                "truncate text-xs",
                reason.kind === "canceled" ? "text-muted-foreground" : "text-danger-ink",
                reason.kind === "text" && "font-mono",
                className
            )}
        >
            {line}
        </p>
    );
}

/**
 * The whole reason, titled, with the way out next to it. `onRedeploy` is passed
 * only to readers who may deploy, so the button is never offered to anyone the
 * server would refuse.
 */
export function DeployFailureNote({
    status,
    error,
    onRedeploy,
    redeploying = false
}: {
    status: string;
    error: string | null;
    onRedeploy?: () => void;
    redeploying?: boolean;
}) {
    const t = useTranslations("deployService");
    const reason = deployFailureReason(status, error);
    if (!reason) return null;
    // Stopped on purpose: said plainly, not in the colours of a failure.
    const calm = reason.kind === "canceled";
    return (
        <div
            role="status"
            className={cn(
                "flex flex-wrap items-start gap-3 rounded-lg border px-3 py-2.5",
                calm ? "border-border bg-muted/40" : "border-danger-edge bg-danger-soft"
            )}
        >
            <CircleAlert
                className={cn(
                    "mt-0.5 size-4 shrink-0",
                    calm ? "text-muted-foreground" : "text-danger-ink"
                )}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-sm font-medium text-foreground">
                    {status === "failed" ? t("failure.failedTitle") : t("failure.stoppedTitle")}
                </p>
                <p
                    className={cn(
                        "whitespace-pre-wrap break-words text-sm",
                        calm ? "text-muted-foreground" : "text-danger-ink",
                        reason.kind === "text" &&
                            "max-h-40 overflow-y-auto overscroll-contain font-mono text-xs"
                    )}
                >
                    {reasonText(reason, t)}
                </p>
            </div>
            {onRedeploy && (
                <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={redeploying}
                    onClick={onRedeploy}
                >
                    {redeploying ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <RotateCw className="size-4" />
                    )}
                    {t("callouts.redeploy")}
                </Button>
            )}
        </div>
    );
}
