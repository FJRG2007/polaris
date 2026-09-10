"use client";

/**
 * What the deployments list needs said before anything else: the last deploy
 * failed, or the live release is behind the branch it builds from. Each callout
 * carries the one action that answers it.
 */

import { Button, cn } from "@polaris/ui";
import { isInFlightStatus } from "@/lib/deploy/status";
import { deployFreshnessAction } from "./glance-actions";
import { useEffect, useState, type ReactNode } from "react";
import type { DeployFreshness } from "@/lib/deploy/freshness";
import type { DeploymentSummary } from "@/lib/deploy-service";
import { FAILED_DEPLOY_STATUSES } from "@/lib/deploy/attention";
import { ArrowUpRight, CircleAlert, GitCommitHorizontal, Loader2 } from "lucide-react";

/** The first line of an error that says something, for a callout that has one line. */
function firstErrorLine(error: string | null): string | null {
    const line = error
        ?.split(/\r?\n/)
        .map((part) => part.trim())
        .find((part) => part.length > 0);
    return line ?? null;
}

// A minute, like the server's own cache: reopening the panel does not ask again.
const FRESHNESS_TTL_MS = 60_000;
const freshnessCache = new Map<string, { at: number; value: DeployFreshness | null }>();

function useFreshness(applicationId: string, sha: string | null): DeployFreshness | null {
    const key = sha ? `${applicationId}:${sha}` : null;
    const [value, setValue] = useState<DeployFreshness | null>(() => {
        const hit = key ? freshnessCache.get(key) : undefined;
        return hit && Date.now() - hit.at < FRESHNESS_TTL_MS ? hit.value : null;
    });
    useEffect(() => {
        if (!key) {
            setValue(null);
            return;
        }
        const hit = freshnessCache.get(key);
        if (hit && Date.now() - hit.at < FRESHNESS_TTL_MS) {
            setValue(hit.value);
            return;
        }
        let active = true;
        void deployFreshnessAction(applicationId)
            .catch(() => null)
            .then((result) => {
                freshnessCache.set(key, { at: Date.now(), value: result });
                if (active) setValue(result);
            });
        return () => {
            active = false;
        };
    }, [applicationId, key]);
    return value;
}

function Callout({
    tone,
    icon,
    title,
    detail,
    children
}: {
    tone: "danger" | "neutral";
    icon: ReactNode;
    title: string;
    detail?: ReactNode;
    children?: ReactNode;
}) {
    return (
        <div
            role={tone === "danger" ? "alert" : "status"}
            className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3",
                tone === "danger" ? "border-danger-edge bg-danger/5" : "border-border bg-card"
            )}
        >
            <span className={cn("flex size-4 self-start pt-0.5", tone === "danger" ? "text-danger-ink" : "text-primary")}>
                {icon}
            </span>
            <div className="min-w-0 flex-1 basis-48">
                <p className="text-sm font-medium text-foreground">{title}</p>
                {detail && <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>}
            </div>
            {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
        </div>
    );
}

export function DeployCallouts({
    applicationId,
    items,
    canDeploy,
    busy,
    onDeploy,
    onViewLog
}: {
    applicationId: string;
    /** The service's deployments, newest first. */
    items: readonly DeploymentSummary[];
    canDeploy: boolean;
    busy: boolean;
    onDeploy: () => void;
    onViewLog: (deploymentId: string) => void;
}) {
    const latest = items[0] ?? null;
    const active = items.find((item) => item.isCurrent) ?? null;
    const moving = items.some((item) => isInFlightStatus(item.status));
    const freshness = useFreshness(applicationId, active?.commitSha ?? null);

    const failed = latest && FAILED_DEPLOY_STATUSES.includes(latest.status) ? latest : null;
    const errorLine = failed ? firstErrorLine(failed.error) : null;
    // A build already on its way brings the branch head with it.
    const behind = !moving && freshness && freshness.behindBy > 0 ? freshness : null;

    if (!failed && !behind) return null;

    const deployButton = (label: string) =>
        canDeploy && (
            <Button size="sm" variant="outline" disabled={busy} onClick={onDeploy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : label}
            </Button>
        );

    return (
        <div className="flex flex-col gap-2">
            {failed && (
                <Callout
                    tone="danger"
                    icon={<CircleAlert className="size-4" />}
                    title="Action required - the last deploy failed"
                    detail={
                        <>
                            {errorLine && (
                                <span className="line-clamp-2 break-words font-mono text-danger-ink" title={errorLine}>
                                    {errorLine}
                                </span>
                            )}
                            {active && active.id !== failed.id && <span>The release before it is still live.</span>}
                        </>
                    }
                >
                    <Button size="sm" variant="ghost" onClick={() => onViewLog(failed.id)}>
                        View log
                    </Button>
                    {deployButton("Redeploy")}
                </Callout>
            )}
            {behind && (
                <Callout
                    tone="neutral"
                    icon={<GitCommitHorizontal className="size-4" />}
                    title={`${behind.behindBy} ${behind.behindBy === 1 ? "commit" : "commits"} behind ${behind.branch}`}
                    detail={
                        active?.commitSha ? (
                            <span>
                                Live is <span className="font-mono">{active.commitSha.slice(0, 7)}</span>.
                            </span>
                        ) : undefined
                    }
                >
                    {behind.compareUrl && (
                        <a
                            href={behind.compareUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            Compare <ArrowUpRight className="size-3" />
                        </a>
                    )}
                    {deployButton("Deploy latest")}
                </Callout>
            )}
        </div>
    );
}
